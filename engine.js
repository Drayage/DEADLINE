/*
 * DEADLINE — 라인 전략 RTS 엔진 (순수 로직 + AI + 시뮬레이터)
 *
 * 브라우저 전역(window.DEADLINE) 및 Node(module.exports) 양쪽 지원(UMD).
 * DOM 의존 없음 — index.html(UI)과 sim.js(테스트)가 공유한다.
 *
 * 맵 모델: 각 라인은 위치 0~4의 공유 복도
 *   [P0 본진=0] - [P0 1칸=1] - [중앙=2] - [P1 1칸=3] - [P1 본진=4]
 *   P0 유닛은 pos1 생성 → pos4 방향 진군. P1 유닛은 pos3 생성 → pos0 방향 진군.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DEADLINE = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 상수 ----------
  const C = {
    LINES: 3, // 상/중/하
    SLOTS: 5, // pos 0..4
    START_GOLD: 100,
    START_WORKERS: 5,
    BASE_HP: 30,
    GOLD_PER_WORKER: 10,
    ACTIONS_PER_TURN: 2,
    COST_WORKER: 50,
    COST_UNIT: 50,
    COST_TOWER: 100,
    COST_BASE_TOWER: 100,
    COST_RESEARCH: 100,
    UNIT_HP: 10,
    UNIT_ATK: 10,
    TOWER_HP: 20,
    TOWER_ATK: 20,
    TOWER_REGEN: 2,
    SCOUT_HP: 15,
    MAX_TURNS: 200, // 시뮬 무승부 상한
  };

  const LINE_NAMES = ["상단", "중단", "하단"];

  // ---------- 유틸 ----------
  // 시드 RNG(재현 가능한 시뮬용)
  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      // xorshift32
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function randInt(rng, n) { return Math.floor(rng() * n); }

  // ---------- 상태 생성 ----------
  // 각 칸(slot)은 { units:{owner:{hp:총HP, count}}, tower:{owner, hp} | null }
  // 본진 칸(0,4)에는 baseTower(본진포탑)와 base(본진 HP/일꾼)가 따로.
  function createPlayer() {
    return {
      gold: C.START_GOLD,
      workers: C.START_WORKERS,
      baseHp: C.BASE_HP,
      baseTower: null, // { hp } | null  (hp는 20의 배수로 스택; 유효 포탑수 = ceil(hp/20))
      research: { atk: 0, def: 0 },
      alive: true,
    };
  }

  // ---------- 연구 유효치 ----------
  function effAtk(state, side) { return C.UNIT_ATK + 2 * state.players[side].research.atk; }
  function effHp(state, side) { return C.UNIT_HP + 2 * state.players[side].research.def; }
  function scoutHpOf(state, side) { return C.SCOUT_HP + 2 * state.players[side].research.def; }
  // 포탑 유효 수 / 공격력 (스택)
  function towerCount(hp) { return Math.ceil(hp / C.TOWER_HP); }
  function towerAtkOf(hp) { return towerCount(hp) * C.TOWER_ATK; }
  // 연구 비용: 레벨이 오를수록 50G씩 증가(현재 레벨 + 이번 턴 큐 기준).
  function researchCost(p, branch, queuedExtra) {
    return C.COST_RESEARCH + 50 * (p.research[branch] + (queuedExtra || 0));
  }

  function createState(opts) {
    opts = opts || {};
    const state = {
      turn: 0,
      players: [createPlayer(), createPlayer()],
      // lines[line] = array of SLOTS slots
      // slot.armies[owner] = { hp, count }  (owner 0 또는 1)
      // slot.tower = { owner, hp } | null  (라인 1칸 포탑; owner 0은 pos1, owner1은 pos3)
      lines: [],
      // 각 플레이어가 이번 턴 큐에 넣은 행동(생산/건설/정찰)은 턴 말 완성
      queues: [createQueue(), createQueue()],
      // 정찰 결과(가장 최근): intel[side][line] = {...}
      intel: [makeIntel(), makeIntel()],
      log: [],
      winner: null, // 0 | 1 | "draw" | null
    };
    for (let l = 0; l < C.LINES; l++) {
      const slots = [];
      for (let s = 0; s < C.SLOTS; s++) {
        slots.push({ armies: [null, null], tower: null });
      }
      state.lines.push(slots);
    }
    return state;
  }

  function createQueue() {
    return { workers: 0, units: [], towers: [], baseTower: 0, scouts: [], research: { atk: 0, def: 0 } };
    // units: [{line}], towers: [{line}], baseTower: 갯수, scouts: [{line}], research: 레벨증가
  }

  function makeIntel() {
    // intel[line] = null | { turn, slots:[{visible, count, tower}|...], death:{slot}|null, fullBase }
    return [null, null, null];
  }

  // ---------- 방향 헬퍼 ----------
  // owner 0 진군 방향 +1 (pos1→4), owner 1 진군 방향 -1 (pos3→0)
  function dir(owner) { return owner === 0 ? 1 : -1; }
  function spawnSlot(owner) { return owner === 0 ? 1 : 3; }
  function enemyBaseSlot(owner) { return owner === 0 ? 4 : 0; }
  function ownBaseSlot(owner) { return owner === 0 ? 0 : 4; }
  function enemyOf(owner) { return owner === 0 ? 1 : 0; }

  // ---------- 행동 적용 (큐에 등록) ----------
  // action: {type:'worker'|'unit'|'tower'|'baseTower'|'scout'|'attack', line?, count?}
  // 반환: {ok, reason}
  function applyAction(state, side, action) {
    const p = state.players[side];
    const q = state.queues[side];
    if (action.type === "worker") {
      if (p.gold < C.COST_WORKER) return fail("골드 부족");
      p.gold -= C.COST_WORKER;
      q.workers += 1;
      return ok();
    }
    if (action.type === "unit") {
      const n = clampCount(action.count);
      if (p.gold < C.COST_UNIT * n) return fail("골드 부족");
      p.gold -= C.COST_UNIT * n;
      for (let i = 0; i < n; i++) q.units.push({ line: action.line });
      return ok();
    }
    if (action.type === "tower") {
      const n = clampCount(action.count);
      if (p.gold < C.COST_TOWER * n) return fail("골드 부족");
      p.gold -= C.COST_TOWER * n;
      for (let i = 0; i < n; i++) q.towers.push({ line: action.line });
      return ok();
    }
    if (action.type === "baseTower") {
      const n = clampCount(action.count);
      if (p.gold < C.COST_BASE_TOWER * n) return fail("골드 부족");
      p.gold -= C.COST_BASE_TOWER * n;
      q.baseTower += n;
      return ok();
    }
    if (action.type === "research") {
      const branch = action.branch === "def" ? "def" : "atk";
      const cost = researchCost(p, branch, q.research[branch]); // 같은 턴 추가 연구는 더 비쌈
      if (p.gold < cost) return fail("골드 부족");
      p.gold -= cost;
      q.research[branch] += 1;
      return ok();
    }
    if (action.type === "scout") {
      if (p.workers - countQueuedScouts(q) <= 0) return fail("정찰 보낼 일꾼 없음");
      q.scouts.push({ line: action.line });
      return ok();
    }
    if (action.type === "attack") {
      // 즉시 처리: 주둔 유닛 중 count만큼 진군 표시. 스폰 칸의 아군 주둔 병력에서 차감해 이동중 표시.
      const slot = state.lines[action.line][spawnSlot(side)];
      const garr = slot.armies[side];
      if (!garr || garr.count <= 0) return fail("주둔 유닛 없음");
      const avail = garr.count - (garr.marching || 0); // 이번 턴 이미 진군 명령한 수 제외
      if (avail <= 0) return fail("보낼 주둔 병력 없음");
      let n = action.count == null ? avail : Math.min(action.count, avail);
      if (n <= 0) return fail("보낼 수량 0");
      // 진군 표시: 이동 단계에서 이동할 수 있도록 marching 플래그.
      // 같은 칸에서 일부만 진군 → 분리. marching 병력은 별도 슬롯 표현 대신
      // armies에 marching 누적량을 둔다.
      garr.marching = (garr.marching || 0) + n;
      state.log.push(`P${side} ${LINE_NAMES[action.line]} ${n}기 공격 명령`);
      return ok();
    }
    return fail("알 수 없는 행동");

    function ok() { return { ok: true }; }
    function fail(reason) { return { ok: false, reason }; }
  }

  function clampCount(c) { return Math.max(1, Math.min(3, c == null ? 1 : c)); }
  function countQueuedScouts(q) { return q.scouts.length; }

  // ---------- 턴 해결 ----------
  // 행동은 이미 applyAction으로 적용됨(공격 명령 포함). 여기서 순서대로 처리.
  function resolveTurn(state, rng) {
    rng = rng || Math.random;
    // 2. 이동
    resolveMovement(state);
    // 3. 전투(칸별) → 돌파 전진 → 본진 전투(돌파 진입분 포함)
    resolveCombat(state);
    advanceHalted(state);
    resolveBase(state);
    // 4. 수입
    collectIncome(state);
    // 5. 생산 완료
    completeProduction(state);
    // 5.5 포탑 회복
    regenTowers(state);
    // 6. 정찰
    resolveScouts(state);
    // 승패 판정
    checkVictory(state);
    state.turn += 1;
    return state;
  }

  // 애니메이션용: 턴 해결을 단계별 클로저로 반환(UI가 사이사이 렌더/딜레이).
  // 순서는 resolveTurn과 동일하게 유지.
  function resolveTurnSteps(state) {
    return [
      { name: "이동", apply: () => resolveMovement(state) },
      { name: "전투", apply: () => { resolveCombat(state); advanceHalted(state); resolveBase(state); } },
      { name: "수입", apply: () => collectIncome(state) },
      { name: "생산", apply: () => { completeProduction(state); regenTowers(state); } },
      { name: "정찰", apply: () => resolveScouts(state) },
      { name: "종료", apply: () => { checkVictory(state); state.turn += 1; } },
    ];
  }

  // 현재 상태에서 이번 전투 단계에 벌어질 교전 칸 목록(전투 적용 전 호출).
  function detectEngagements(state) {
    const out = [];
    for (let l = 0; l < C.LINES; l++) {
      for (let s = 0; s < C.SLOTS; s++) {
        const slot = state.lines[l][s];
        const a0 = slot.armies[0], a1 = slot.armies[1];
        if (s === 0 || s === 4) {
          // 본진 칸: 공격측 유닛 vs 방어측 본진포탑/일꾼/본진
          const defender = s === 0 ? 0 : 1;
          const atk = slot.armies[enemyOf(defender)];
          if (atk && atk.count > 0) {
            out.push({ line: l, slot: s, base: true, defender,
              attacker: enemyOf(defender), atkCount: atk.count });
          }
          continue;
        }
        const uVsU = a0 && a0.count > 0 && a1 && a1.count > 0;
        const tower = slot.tower;
        const uVsT = tower && slot.armies[enemyOf(tower.owner)] && slot.armies[enemyOf(tower.owner)].count > 0;
        if (uVsU || uVsT) {
          out.push({ line: l, slot: s, base: false,
            c0: a0 ? a0.count : 0, c1: a1 ? a1.count : 0,
            tower: tower ? { owner: tower.owner, hp: tower.hp } : null });
        }
      }
    }
    return out;
  }

  // 진군 부분 병력(marching 서브셋)을 칸에서 추출/배치
  function extractMoving(slot, owner, state) {
    const a = slot.armies[owner];
    const m = a.marching;
    a.count -= m; a.marching = 0; a.hp = a.count * effHp(state, owner);
    if (a.count <= 0) slot.armies[owner] = null;
    return { count: m, hp: m * effHp(state, owner), marching: m };
  }
  function placeMover(slot, owner, mv, state) {
    if (mv.count <= 0) return null;
    if (!slot.armies[owner]) slot.armies[owner] = { hp: 0, count: 0, marching: 0 };
    const d = slot.armies[owner];
    d.count += mv.count; d.hp += mv.count * effHp(state, owner); d.marching += mv.marching;
    return d;
  }

  // 두 군대 동시 전멸까지 교전(owner별 연구 유효치 적용). 객체 count/hp 갱신.
  function fightArmies(a, b, state, oa, ob) {
    let guard = 0;
    while (a.count > 0 && b.count > 0 && guard++ < 300) {
      const aAtk = a.count * effAtk(state, oa);
      const bAtk = b.count * effAtk(state, ob);
      a.hp -= bAtk; b.hp -= aAtk;
      a.count = a.hp > 0 ? Math.floor(a.hp / effHp(state, oa)) : 0;
      b.count = b.hp > 0 ? Math.floor(b.hp / effHp(state, ob)) : 0;
    }
  }

  // 2. 이동: 교차 선처리(스쳐 지나감 → 먼저 전투, 승자만 전진) 후 일반 1칸 이동.
  function resolveMovement(state) {
    for (let l = 0; l < C.LINES; l++) {
      const slots = state.lines[l];
      // 1) 교차: owner0 s→s+1, owner1 s+1→s 가 둘 다 진군이면 위치 맞바꿈 → 먼저 교전.
      for (let s = 0; s < C.SLOTS - 1; s++) {
        const A = slots[s].armies[0], B = slots[s + 1].armies[1];
        if (!(A && A.marching > 0) || !(B && B.marching > 0)) continue;
        const mvA = extractMoving(slots[s], 0, state);
        const mvB = extractMoving(slots[s + 1], 1, state);
        fightArmies(mvA, mvB, state, 0, 1);
        mvA.marching = mvA.count; mvB.marching = mvB.count; // 생존자는 계속 진군
        if (mvA.count > 0) { const d = placeMover(slots[s + 1], 0, mvA, state); if (d) d._crossed = true; }
        else if (mvB.count > 0) { const d = placeMover(slots[s], 1, mvB, state); if (d) d._crossed = true; }
        state.log.push(`${LINE_NAMES[l]} ${s}↔${s + 1}칸 교차 교전`);
      }
      // 2) 일반 이동: 남은 진군 병력 1칸. 현재 칸에 적 유닛/포탑 있으면 정지(전투단계 교전).
      for (let owner = 0; owner < 2; owner++) {
        const d = dir(owner);
        const order = d === 1 ? [3, 2, 1, 0] : [1, 2, 3, 4];
        for (const s of order) {
          const slot = slots[s];
          const army = slot.armies[owner];
          if (!army || !army.marching || army.marching <= 0 || army._crossed) continue;
          const enemy = enemyOf(owner);
          const enemyArmy = slot.armies[enemy];
          const enemyTower = slot.tower && slot.tower.owner === enemy;
          if ((enemyArmy && enemyArmy.count > 0) || enemyTower) { army._halted = true; continue; } // 정지(전투단계 교전 → 이기면 돌파)
          const ns = s + d;
          if (ns < 0 || ns >= C.SLOTS) continue;
          const mv = extractMoving(slot, owner, state);
          placeMover(slots[ns], owner, mv, state);
        }
      }
      // _crossed 플래그 정리(_halted는 전투 후 advanceHalted에서 처리)
      for (let s = 0; s < C.SLOTS; s++)
        for (let o = 0; o < 2; o++) { const a = slots[s].armies[o]; if (a) delete a._crossed; }
    }
  }

  // 3.5 돌파: 정지(halt)했던 진군군이 전투에서 이겨 칸이 비면 한 칸 전진(본진칸이면 진입 후 즉시 타격).
  function advanceHalted(state) {
    for (let l = 0; l < C.LINES; l++) {
      const slots = state.lines[l];
      for (let owner = 0; owner < 2; owner++) {
        const d = dir(owner);
        const order = d === 1 ? [3, 2, 1, 0] : [1, 2, 3, 4];
        for (const s of order) {
          const slot = slots[s];
          const army = slot.armies[owner];
          if (!army) continue;
          if (!army._halted) continue;
          delete army._halted;
          if (army.marching <= 0 || army.count <= 0) continue;
          const enemy = enemyOf(owner);
          const enemyArmy = slot.armies[enemy];
          const enemyTower = slot.tower && slot.tower.owner === enemy;
          if ((enemyArmy && enemyArmy.count > 0) || enemyTower) continue; // 아직 못 이김 → 정지 유지
          const ns = s + d;
          if (ns < 0 || ns >= C.SLOTS) continue;
          const mv = extractMoving(slot, owner, state);
          placeMover(slots[ns], owner, mv, state);
          state.log.push(`${LINE_NAMES[l]} 돌파 전진`);
          // 본진 진입분의 전투는 이후 resolveBase에서 처리(연출 위해 분리)
        }
      }
      for (let s = 0; s < C.SLOTS; s++)
        for (let o = 0; o < 2; o++) { const a = slots[s].armies[o]; if (a) delete a._halted; }
    }
  }

  // 3. 전투: 칸마다 양 owner 군대가 있으면 전멸까지 / 포탑과 만나면 전멸까지.
  function resolveCombat(state) {
    for (let l = 0; l < C.LINES; l++) {
      const slots = state.lines[l];
      for (let s = 0; s < C.SLOTS; s++) {
        const slot = slots[s];
        if (s === 0 || s === 4) continue; // 본진 칸은 resolveBase
        const a0 = slot.armies[0], a1 = slot.armies[1];
        if (a0 && a0.count > 0 && a1 && a1.count > 0) fightToDeath(slot, l, s, state);
        if (slot.tower) {
          const attacker = enemyOf(slot.tower.owner);
          const army = slot.armies[attacker];
          if (army && army.count > 0) fightArmyVsTower(slot, attacker, l, s, state);
        }
      }
    }
  }

  function fightToDeath(slot, line, s, state) {
    const a = slot.armies[0], b = slot.armies[1];
    fightArmies(a, b, state, 0, 1);
    if (a.count <= 0) slot.armies[0] = null;
    if (b.count <= 0) slot.armies[1] = null;
    normalizeArmy(slot.armies[0], state, 0);
    normalizeArmy(slot.armies[1], state, 1);
    state.log.push(`${LINE_NAMES[line]} ${s}칸 교전`);
  }

  // 군대 vs 라인 포탑(스택) → 전멸까지(둘 중 하나 0). 포탑 ATK=ceil(hp/20)*20.
  function fightArmyVsTower(slot, attacker, line, s, state) {
    const tower = slot.tower;
    let army = slot.armies[attacker];
    let guard = 0;
    while (army && army.count > 0 && tower.hp > 0 && guard++ < 300) {
      const aAtk = army.count * effAtk(state, attacker);
      const tAtk = towerAtkOf(tower.hp);
      army.hp -= tAtk;
      tower.hp -= aAtk;
      army.count = army.hp > 0 ? Math.floor(army.hp / effHp(state, attacker)) : 0;
      if (army.count <= 0) { slot.armies[attacker] = null; army = null; }
    }
    if (tower.hp <= 0) {
      slot.tower = null;
      state.log.push(`${LINE_NAMES[line]} 포탑 파괴`);
    }
    normalizeArmy(slot.armies[attacker], state, attacker);
  }

  function normalizeArmy(army, state, side) {
    if (!army || army.count <= 0) return;
    army.hp = army.count * effHp(state, side); // 교전 종료 후 생존 유닛은 풀피
    if (army.marching > army.count) army.marching = army.count; // 손실 후 진군수 보정
  }

  // 본진 칸 처리: 적 유닛이 본진 칸 도달 시 본진포탑 → 일꾼 → 본진
  function resolveBase(state) {
    for (let l = 0; l < C.LINES; l++)
      for (const baseSlotIdx of [0, 4]) resolveBaseAt(state, l, baseSlotIdx);
  }

  function resolveBaseAt(state, l, baseSlotIdx) {
    const slots = state.lines[l];
    const defender = baseSlotIdx === 0 ? 0 : 1;
    const attacker = enemyOf(defender);
    const slot = slots[baseSlotIdx];
    const army = slot.armies[attacker];
    if (!army || army.count <= 0) return;
    const dp = state.players[defender];
    // 본진포탑(스택)이 있으면 먼저 교전
    if (dp.baseTower) {
      let guard = 0;
      let a = army;
      while (a && a.count > 0 && dp.baseTower.hp > 0 && guard++ < 300) {
        const aAtk = a.count * effAtk(state, attacker);
        const tAtk = towerAtkOf(dp.baseTower.hp);
        dp.baseTower.hp -= aAtk;
        a.hp -= tAtk;
        a.count = a.hp > 0 ? Math.floor(a.hp / effHp(state, attacker)) : 0;
        if (a.count <= 0) { slot.armies[attacker] = null; a = null; }
      }
      if (dp.baseTower.hp <= 0) {
        dp.baseTower = null;
        state.log.push(`P${defender} ${LINE_NAMES[l]} 본진포탑 파괴`);
      }
      normalizeArmy(slot.armies[attacker], state, attacker);
    }
    // 본진포탑 없고 유닛 생존 → 일꾼 → 본진
    const survivors = slot.armies[attacker];
    if (!dp.baseTower && survivors && survivors.count > 0) {
      const n = survivors.count;
      if (dp.workers > 0) {
        const killed = Math.min(dp.workers, n);
        dp.workers -= killed;
        state.log.push(`P${defender} 일꾼 ${killed} 사망`);
      } else {
        const dmg = n * effAtk(state, attacker);
        dp.baseHp -= dmg;
        state.log.push(`P${defender} 본진 -${dmg} (HP ${Math.max(0, dp.baseHp)})`);
      }
    }
  }

  // 4. 수입
  function collectIncome(state) {
    for (let side = 0; side < 2; side++) {
      const p = state.players[side];
      p.gold += p.workers * C.GOLD_PER_WORKER;
    }
  }

  // 5. 생산 완료
  function completeProduction(state) {
    for (let side = 0; side < 2; side++) {
      const p = state.players[side];
      const q = state.queues[side];
      p.workers += q.workers;
      // 연구 완료(레벨 반영) — 유닛 생산 hp 적립 전에 적용
      p.research.atk += q.research.atk;
      const defGained = q.research.def;
      p.research.def += defGained;
      // 방어연구로 유효 HP 상승 시 보드 위 모든 군대 풀피로 갱신(count 일관성)
      if (defGained > 0) {
        for (let l = 0; l < C.LINES; l++)
          for (let s = 0; s < C.SLOTS; s++) {
            const a = state.lines[l][s].armies[side];
            if (a && a.count > 0) a.hp = a.count * effHp(state, side);
          }
      }
      for (const u of q.units) {
        const slot = state.lines[u.line][spawnSlot(side)];
        if (!slot.armies[side]) slot.armies[side] = { hp: 0, count: 0, marching: 0 };
        slot.armies[side].count += 1;
        slot.armies[side].hp += effHp(state, side);
      }
      for (const t of q.towers) {
        const slot = state.lines[t.line][spawnSlot(side)];
        if (!slot.tower) slot.tower = { owner: side, hp: C.TOWER_HP };
        else slot.tower.hp += C.TOWER_HP; // 스택
      }
      if (q.baseTower > 0) {
        if (!p.baseTower) p.baseTower = { hp: C.TOWER_HP * q.baseTower };
        else p.baseTower.hp += C.TOWER_HP * q.baseTower;
      }
      // 정찰은 resolveScouts에서 처리(큐 유지) — 여기선 비우지 않음
      state.queues[side] = carryScouts(q);
    }
  }

  function carryScouts(q) {
    const nq = createQueue();
    nq.scouts = q.scouts; // 정찰은 이번 턴 말 처리되므로 resolveScouts 후 비움
    return nq;
  }

  // 포탑 스택 회복: hp = min(ceil(hp/20)*20, hp + 2*ceil(hp/20))
  function regenTower(hp) {
    const cnt = towerCount(hp);
    return Math.min(cnt * C.TOWER_HP, hp + C.TOWER_REGEN * cnt);
  }
  function regenTowers(state) {
    for (let l = 0; l < C.LINES; l++) {
      for (let s = 0; s < C.SLOTS; s++) {
        const t = state.lines[l][s].tower;
        if (t) t.hp = regenTower(t.hp);
      }
    }
    for (let side = 0; side < 2; side++) {
      const bt = state.players[side].baseTower;
      if (bt) bt.hp = regenTower(bt.hp);
    }
  }

  // 6. 정찰: 정찰병이 라인을 적 본진 방향으로 통과하며 일방적으로 피해 받음.
  function resolveScouts(state) {
    state.scoutAnim = []; // 애니메이션용(이번 턴)
    for (let side = 0; side < 2; side++) {
      const q = state.queues[side];
      const p = state.players[side];
      for (const sc of q.scouts) {
        if (p.workers <= 0) continue; // 보낼 일꾼 없음
        const result = runScout(state, side, sc.line);
        result.intel.turn = state.turn; // 이 정보를 본 턴(0-based) 기록
        state.intel[side][sc.line] = result.intel;
        state.scoutAnim.push({
          side, line: sc.line, events: result.events || [],
          workerDied: result.workerDied,
          reachedBase: result.intel.reachedBase, baseTowerSeen: result.intel.baseTowerSeen,
          maxHp: scoutHpOf(state, side),
        });
        if (result.workerDied) {
          p.workers -= 1;
          state.log.push(`P${side} ${LINE_NAMES[sc.line]} 정찰병 사망`);
        } else {
          state.log.push(`P${side} ${LINE_NAMES[sc.line]} 정찰 귀환`);
        }
      }
      state.queues[side].scouts = [];
    }
  }

  function runScout(state, side, line) {
    const enemy = enemyOf(side);
    const slots = state.lines[line];
    const d = dir(side);
    let hp = scoutHpOf(state, side);
    const maxHp = hp;
    const start = spawnSlot(side); // 자기 1칸에서 출발
    const enemyBase = enemyBaseSlot(side);
    const visible = {}; // slotIdx -> {count, tower}
    const events = []; // 애니메이션용: 칸별 진행
    let death = null;

    for (let s = start + d; ; s += d) {
      if (s === enemyBase) {
        // 적 본진 도달 → 본진 정보 전부 획득
        const ep = state.players[enemy];
        const baseInfo = {
          hp: ep.baseHp, workers: ep.workers,
          research: { atk: ep.research.atk, def: ep.research.def },
          baseTowerHp: ep.baseTower ? ep.baseTower.hp : 0,
        };
        const seen = !!ep.baseTower;
        events.push({ slot: enemyBase, base: true, dmg: seen ? towerAtkOf(ep.baseTower.hp) : 0, hpAfter: seen ? 0 : hp, result: seen ? "die" : "return" });
        return { intel: makeScoutIntel(line, visible, null, true, seen, baseInfo), workerDied: seen, events };
      }
      if (s < 0 || s >= C.SLOTS) break;
      const slot = slots[s];
      const army = slot.armies[enemy];
      const towerHere = slot.tower && slot.tower.owner === enemy ? slot.tower : null;
      const enemyCount = army ? army.count : 0;
      let dmg = 0;
      if (enemyCount > 0) dmg += enemyCount * effAtk(state, enemy);
      if (towerHere) dmg += towerAtkOf(towerHere.hp);
      hp -= dmg;
      if (hp <= 0) {
        death = { slot: s, units: enemyCount, tower: !!towerHere };
        events.push({ slot: s, enemyCount, tower: !!towerHere, dmg, hpAfter: 0, result: "die" });
        return { intel: makeScoutIntel(line, visible, death, false, false, null), workerDied: true, events };
      }
      visible[s] = { count: enemyCount, tower: !!towerHere };
      events.push({ slot: s, enemyCount, tower: !!towerHere, dmg, hpAfter: hp, result: "pass" });
    }
    return { intel: makeScoutIntel(line, visible, null, false, false, null), workerDied: false, events };
  }

  function makeScoutIntel(line, visible, death, reachedBase, baseTowerSeen, baseInfo) {
    return { line, turn: null, visible, death, reachedBase, baseTowerSeen, baseInfo: baseInfo || null };
  }

  function checkVictory(state) {
    const p0 = state.players[0], p1 = state.players[1];
    const d0 = p0.baseHp <= 0;
    const d1 = p1.baseHp <= 0;
    if (d0 && d1) state.winner = "draw";
    else if (d0) state.winner = 1;
    else if (d1) state.winner = 0;
  }

  // ========================================================================
  // AI — 성향 기반 의사결정
  // ========================================================================
  // 성향 파라미터. defends=위협 대응 강도, opportunist=빈 라인 노리기.
  // atkSize: 공격 규모 범위[min,max] — 게임당 1회 랜덤 고정. 그만큼 모아 그만큼 보냄.
  // wantLineTower: 위협 라인에 라인포탑도 건설. stackBaseTower: 여유 시 본진포탑 추가 스택.
  const PLAYSTYLES = {
    rush: {
      name: "극한러쉬",
      targetWorkers: 5,
      greedUntil: 0,
      wantBaseTower: false,
      atkSize: [3, 4],       // 첫 웨이브로 본진포탑 1개를 깰 화력(정찰형 단일 포탑 처벌)
      reserve: 0,
      defends: false,
      scoutChance: 0,
    },
    turtle: {
      name: "1포탑배째기",
      targetWorkers: 12,
      greedUntil: 0,
      wantBaseTower: true,
      atkSize: [5, 6],
      reserve: 3,
      defends: true,
      wantLineTower: true,
      stackBaseTower: true,
      rampAttack: true,      // 경제 완성 후엔 모은 병력을 크게 내보내 교착을 깬다
      scoutChance: 0.1,
    },
    economy: {
      name: "무한경제",
      targetWorkers: 18,
      greedUntil: 13,        // 일꾼 13까지 탐욕(방어/공격 보류) → 러쉬·타이밍이 처벌
      wantBaseTower: true,
      atkSize: [6, 8],
      reserve: 2,
      defends: true,
      wantLineTower: true,
      stackBaseTower: true,
      scoutChance: 0.1,
      researchChance: 0.3,
    },
    timingAtk: {
      name: "타이밍(공업)",
      targetWorkers: 7,
      greedUntil: 0,
      wantBaseTower: false,
      atkSize: [5, 6],       // 버프와 결합해 포탑/주둔을 깰 수 있는 결정타 규모
      reserve: 0,
      defends: true,
      scoutChance: 0.15,
      timedUpgrade: true,        // 진군 웨이브가 적 1칸 도달 전에 연구가 완성되도록 타이밍 업글
      timedUpgradeBranch: "atk", // 공업: 결정타 +ATK로 포탑/주둔 격파
      timedUpgradeCap: 3,
    },
    timingDef: {
      name: "타이밍(방업)",
      targetWorkers: 7,
      greedUntil: 0,
      wantBaseTower: false,
      atkSize: [5, 6],
      reserve: 0,
      defends: true,
      scoutChance: 0.15,
      timedUpgrade: true,
      timedUpgradeBranch: "def", // 방업: 웨이브 +HP로 포탑/주둔과의 교환에서 더 많이 생존
      timedUpgradeCap: 3,
    },
    greedyTurtle: {
      name: "무정찰배째기",
      targetWorkers: 12,
      greedUntil: 8,            // 일꾼 먼저(2+1=8) 모은 뒤 본진포탑 → "일꾼2-일꾼1-포탑"
      wantBaseTower: true,
      atkSize: [5, 6],
      reserve: 3,
      defends: true,
      wantLineTower: true,
      saveForBaseTower: true,   // 본진포탑 세우기 전엔 방어유닛 대신 100 모아 포탑부터
      reinforceWhenHit: true,   // 본진포탑이 피격되면 돈 모아 본진포탑 1개 추가
      rampAttack: true,         // 경제 완성 후 대규모 공격으로 교착 타개
      scoutChance: 0,           // 무정찰
    },
    scout: {
      name: "정찰형",
      targetWorkers: 8,
      greedUntil: 0,
      wantBaseTower: true,   // (1) 생존성: 본진포탑 확보
      atkSize: [4, 5],       // opportunist는 4기 이상에서만 공격
      reserve: 0,
      defends: true,
      wantLineTower: true,
      stackBaseTower: true,
      opportunist: true,
      adaptive: true,        // 정찰로 적 성향 분류 → 카운터 전략으로 전환
    },
  };

  // 현재 라인별 주둔(비진군) 아군 유닛 수
  function garrisonCounts(state, side) {
    const out = [];
    for (let l = 0; l < C.LINES; l++) {
      const slot = state.lines[l][spawnSlot(side)];
      const army = slot.armies[side];
      const total = army ? army.count : 0;
      const marching = army ? (army.marching || 0) : 0;
      out.push(Math.max(0, total - marching));
    }
    return out;
  }

  // 라인별 내 본진으로 접근 중인 적 유닛 수(내 절반 + 중앙). 위협 감지.
  function incomingThreat(state, side) {
    const enemy = enemyOf(side);
    const out = [];
    for (let l = 0; l < C.LINES; l++) {
      const slots = state.lines[l];
      let threat = 0;
      // 내 방어 구간: 내 본진~중앙(내 spawn 포함). P0: slots 0,1,2 / P1: 2,3,4
      const range = side === 0 ? [0, 1, 2] : [2, 3, 4];
      for (const s of range) {
        const a = slots[s].armies[enemy];
        if (a && a.count > 0) threat += a.count;
      }
      out.push(threat);
    }
    return out;
  }

  // 게임당 1회 성향 수치 확정(공격 규모 범위를 랜덤 고정). state._aiPs[side]에 캐시.
  function resolveAiPs(state, side, playstyle, rng) {
    if (!state._aiPs) state._aiPs = [null, null];
    if (state._aiPs[side]) return state._aiPs[side];
    const base = typeof playstyle === "string" ? PLAYSTYLES[playstyle] : playstyle;
    const [mn, mx] = base.atkSize || [3, 3];
    const size = mn + randInt(rng, mx - mn + 1);
    const ps = Object.assign({}, base, { attackThreshold: size, attackMax: size });
    state._aiPs[side] = ps;
    return ps;
  }

  // 성향은 "초반 빌드오더"만 결정한다. 중반(OPENING_TURNS)부터는 성향을 버리고 현재
  // 판세(경제/위협/병력)를 읽어 합리적 적응형 매크로로 전환한다. → 러쉬·타이밍이 한 번
  // 막혔다고 게임을 던지지 않고 경제 복구·분산 압박·방어로 갈아탄다.
  const OPENING_TURNS = 7;
  function midGameProfile(state, side, ps, rng) {
    if (state.turn < OPENING_TURNS) return ps;   // 초반: 성향(빌드오더) 그대로
    if (ps.adaptive) return ps;                  // 정찰형은 자체 적응 로직(adaptScout) 유지
    // 이미 경제 기반(배째기/경제)인 성향은 정체성 유지 → 상성(가위바위보) 보존.
    if (ps.targetWorkers >= 10) return ps;
    // 저경제 공격형(러쉬·타이밍): 초반 압박이 끝났으면 경제로 복구해 게임을 던지지 않게.
    // 정체성은 "공격형" 그대로 두되, 경제 바닥을 끌어올리고 생존(방어/본진포탑)을 켠다.
    return Object.assign({}, ps, {
      targetWorkers: 12,
      greedUntil: 0,
      wantBaseTower: true,
      defends: true,
      spread: true,        // 복구 후엔 3라인 분산 압박
      rampAttack: true,    // 경제 회복하면 모아서 대규모 공격
    });
  }

  // AI가 한 턴(행동 2회)을 계획해 실행. 방어는 턴당 1회로 제한(과방어 = 영구 교착 방지).
  function aiTakeTurn(state, side, playstyle, rng) {
    rng = rng || Math.random;
    const ps = midGameProfile(state, side, resolveAiPs(state, side, playstyle, rng), rng);
    let defenseUsed = 0;
    for (let act = 0; act < C.ACTIONS_PER_TURN; act++) {
      const choice = aiChooseAction(state, side, ps, rng, defenseUsed);
      if (!choice) break;
      if (choice._defense) defenseUsed++;
      const res = applyAction(state, side, choice);
      if (!res.ok) break;
    }
  }

  function aiChooseAction(state, side, ps, rng, defenseUsed) {
    const p = state.players[side];
    const garr = garrisonCounts(state, side);
    const threat = incomingThreat(state, side);
    const totalThreat = threat.reduce((a, b) => a + b, 0);
    // 본진 코앞(인접 칸) 위협 = 긴급
    const urgent = urgentThreat(state, side);

    // [공통·예외없음] 본진 침투 긴급 방어: 본진 칸에 적 유닛이 있고 본진포탑이 없으면
    // 빌드/전략 무시하고 본진포탑 건설을 최우선(못 사면 저축 — 무의미한 행동 금지).
    {
      const en = enemyOf(side);
      const bs = ownBaseSlot(side);
      let intruder = false;
      for (let l = 0; l < C.LINES; l++) {
        const a = state.lines[l][bs].armies[en];
        if (a && a.count > 0) { intruder = true; break; }
      }
      if (intruder && !p.baseTower && !state.queues[side].baseTower) {
        return p.gold >= C.COST_BASE_TOWER ? { type: "baseTower" } : null;
      }
    }

    // 적응형(정찰형): 정찰로 적 성향을 분류해 카운터 전략으로 파라미터를 전환한다.
    if (ps.adaptive) {
      // 상대가 실제로 날 공격해오면(공격형) 기록 — 경제로 분류됐어도 대응을 바꾼다.
      if (!state._pressured) state._pressured = [false, false];
      // 적의 진군 웨이브(공세 신호) 감지 — 공격형끼리 중앙 상쇄로 위치 감지가 안 되는 문제 보완.
      let enemyMarch = 0;
      const en = enemyOf(side);
      for (let l = 0; l < C.LINES; l++)
        for (let sl = 0; sl < C.SLOTS; sl++) {
          const a = state.lines[l][sl].armies[en];
          if (a) enemyMarch += (a.marching || 0);
        }
      if (totalThreat >= 2 || enemyMarch >= 3) state._pressured[side] = true;
      ps = adaptScout(state, side, ps);
      const threatened = totalThreat > 0 || urgent > 0 || baseTowerDamaged(p);
      const known = ps._enemyType != null;
      if (!state._scoutCount) state._scoutCount = [0, 0];
      // 정찰 빈도: T1·T5 강제(안전할 때) + 적 미분류 시 정찰. 위협 중엔 금지, 총 4회 상한.
      if (!threatened && state.queues[side].scouts.length === 0 && p.workers > 1 &&
          state._scoutCount[side] < 4 &&
          (state.turn === 0 || state.turn === 4 || !known)) {
        state._scoutCount[side] += 1;
        return { type: "scout", line: pickScoutLine(state, side, rng) };
      }
      // T1: 정찰 직후 같은 턴에 일꾼(빌드오더: 정찰+일꾼 → T2 본진포탑)
      if (!threatened && state.turn === 0 && state.queues[side].scouts.length > 0 &&
          state.queues[side].workers === 0 && p.gold >= C.COST_WORKER) {
        return { type: "worker" };
      }
    }

    // 탐욕 구간: 일꾼이 greedUntil 미만이고 긴급 위협(본진 인접)이 아니면 일꾼만 생산.
    // → 초반 무방비(탐욕)를 만들어 러쉬·타이밍이 처벌할 창을 연다.
    const futureWorkersG = p.workers + state.queues[side].workers;
    // saveForBaseTower 성향은 위협이 보이면 탐욕을 멈추고 포탑부터(아래) 챙긴다.
    // (일반 탐욕형은 기존대로 본진 인접 긴급 위협이 아니면 계속 탐욕)
    const greedClear = ps.saveForBaseTower ? totalThreat === 0 : urgent === 0;
    if ((ps.greedUntil || 0) > 0 && futureWorkersG < ps.greedUntil && greedClear) {
      if (p.gold >= C.COST_WORKER) return { type: "worker" };
      return null; // 골드 모자라면 행동 보류(저축)
    }

    // 0.-) 포탑 우선 저축: 본진포탑이 아직 없으면(컨셉상 반드시 세워야 함) 방어유닛 등에
    //      돈을 쓰지 말고 100을 모아 본진포탑부터 올린다. 모이면 즉시 건설.
    if (ps.saveForBaseTower && ps.wantBaseTower && !p.baseTower &&
        !state.queues[side].baseTower) {
      if (p.gold >= C.COST_BASE_TOWER) return { type: "baseTower", _defense: urgent > 0 };
      return null; // 포탑 자금 모으는 중 — 다른 지출 보류
    }

    // 0) 방어: 위협받는 라인에 방어 유닛 부족 시 보강(길목에서 자동 요격).
    //    긴급(본진 인접)일 땐 2회까지, 아니면 턴당 1회만 방어에 사용.
    if (ps.defends && p.gold >= C.COST_UNIT) {
      const defenseCap = urgent > 0 ? C.ACTIONS_PER_TURN : 1;
      if (defenseUsed < defenseCap) {
        let target = -1, worst = 0;
        for (let l = 0; l < C.LINES; l++) {
          const deficit = threat[l] - garr[l];
          if (threat[l] > 0 && deficit >= 0 && threat[l] > worst) { worst = threat[l]; target = l; }
        }
        if (target >= 0) return { type: "unit", line: target, _defense: true };
      }
    }

    // 0.5) 긴급 위협 + 본진포탑 없음 → 비상 본진포탑
    if (totalThreat >= 2 && !p.baseTower && !state.queues[side].baseTower && p.gold >= C.COST_BASE_TOWER) {
      return { type: "baseTower" };
    }

    // 0.6) 라인포탑: 위협 큰 라인의 내 1칸에 포탑이 없으면 건설(방어 성향)
    if (ps.wantLineTower && p.gold >= C.COST_TOWER) {
      for (let l = 0; l < C.LINES; l++) {
        if (threat[l] >= 2 && !state.lines[l][spawnSlot(side)].tower &&
            !state.queues[side].towers.some(t => t.line === l)) {
          return { type: "tower", line: l, count: 1, _defense: defenseUsed === 0 };
        }
      }
    }

    // 0.7) 여유 자금 → 본진포탑 스택 보강(방어 성향)
    if (ps.stackBaseTower && p.baseTower && p.gold >= C.COST_BASE_TOWER + 100 && totalThreat >= 3) {
      return { type: "baseTower", count: 1 };
    }

    // 0.7b) 본진포탑 피격 대응(무정찰배째기): 본진포탑이 데미지를 입었거나 본진 코앞에
    //       위협이 있으면, 돈을 모아 본진포탑 1개를 더 올린다. 모으는 동안은 다른 데 안 씀.
    if (ps.reinforceWhenHit && p.baseTower) {
      const full = Math.ceil(p.baseTower.hp / C.TOWER_HP) * C.TOWER_HP;
      const underAttack = (p.baseTower.hp < full && totalThreat > 0) || urgent > 0;
      if (underAttack) {
        if (p.gold >= C.COST_BASE_TOWER && !state.queues[side].baseTower) {
          return { type: "baseTower", count: 1, _defense: true };
        }
        return null; // 돈 모으는 중 — 본진포탑 추가를 위해 저축
      }
    }

    // 1) 공격: 임계 이상 모인 라인이 있으면(예비 reserve 남기고) 모은 병력 모아치기
    {
      // 방어형은 경제 완성 후 임계/규모를 키워 누적 포탑·주둔을 깨는 대규모 공격(교착 타개).
      let atkThr = ps.attackThreshold, atkMax = ps.attackMax;
      if (ps.rampAttack && p.workers >= ps.targetWorkers) {
        atkThr = Math.max(atkThr, 8); atkMax = Math.max(atkMax, 10);
      }
      let target = -1, best = -1;
      for (let l = 0; l < C.LINES; l++) {
        const sendable = garr[l] - ps.reserve;
        if (garr[l] >= atkThr && sendable >= 1 && garr[l] > best) {
          best = garr[l]; target = l;
        }
      }
      if (target >= 0) {
        if (ps.opportunist) {
          // 약한 라인 발견 + 그 라인에 보낼 병력이 공격 임계(4기+) 이상일 때만 그쪽으로 집중
          const weak = weakestEnemyLine(state, side);
          if (weak >= 0 && garr[weak] - ps.reserve >= atkThr) target = weak;
        }
        const sendable = garr[target] - ps.reserve;
        return { type: "attack", line: target, count: Math.min(atkMax, sendable) };
      }
    }

    // 1.5) 타이밍 공업: 진군 웨이브가 내 진영/중앙을 지나는 동안(=적 1칸 도달 전) 공격연구를
    //      올려, 본진 들어가기 직전 결정타에 +ATK가 적용되게 한다. 같은 라인 반복 찔끔이
    //      아니라 "버프된 한 방"으로 포탑/주둔을 깨는 게 목적.
    if (ps.timedUpgrade && totalThreat === 0) {
      const br = ps.timedUpgradeBranch || "atk";
      if (p.research[br] < (ps.timedUpgradeCap || 3) &&
          p.gold >= researchCost(p, br) && !state.queues[side].research[br]) {
        const half = side === 0 ? [0, 1, 2] : [2, 3, 4]; // 내 진영+중앙(적 미접촉 구간)
        let pushing = false;
        for (let l = 0; l < C.LINES && !pushing; l++) {
          for (const sl of half) {
            const a = state.lines[l][sl].armies[side];
            if (a && a.marching > 0) { pushing = true; break; }
          }
        }
        if (pushing) return { type: "research", branch: br };
      }
    }

    // 2) 평시 본진포탑(원하면)
    if (ps.wantBaseTower && !p.baseTower && !state.queues[side].baseTower && p.gold >= C.COST_BASE_TOWER) {
      return { type: "baseTower" };
    }

    // 3) 경제: 일꾼 목표 미달이면 일꾼
    const futureWorkers = p.workers + state.queues[side].workers;
    if (futureWorkers < ps.targetWorkers && p.gold >= C.COST_WORKER) {
      return { type: "worker" };
    }

    // 4) 정찰(확률)
    if (rng() < ps.scoutChance && p.workers > 1) {
      return { type: "scout", line: randInt(rng, C.LINES) };
    }

    // 4.5) 연구 — 성향 확률 OR 잉여 자금(모두 적용): 유닛/포탑 다 굴리고도 돈이 남으면
    //      남는 돈을 업그레이드로 환원해 잉여 골드가 과도하게 쌓이지 않게 한다.
    {
      const branch = (p.research.atk <= p.research.def) ? "atk" : "def";
      const cost = researchCost(p, branch);
      const byChance = ps.researchChance && rng() < ps.researchChance && p.gold >= cost + C.COST_UNIT;
      // 연구 후에도 유닛 한 배치(150)는 남을 만큼 부유하면 → 잉여를 업글로(레벨 상한 8)
      const bySurplus = p.gold >= cost + 150 && p.research[branch] < 8 && !state.queues[side].research[branch];
      if (byChance || bySurplus) return { type: "research", branch };
    }

    // 5) 유닛 생산 — 성향에 따라 분산(빌드형) / 집중(러쉬·타이밍), 한 번에 최대 3마리
    if (p.gold >= C.COST_UNIT) {
      const target = pickProductionLine(state, side, ps, garr, rng);
      const n = Math.min(3, Math.floor(p.gold / C.COST_UNIT));
      return { type: "unit", line: target, count: n };
    }

    return null;
  }

  // 유닛 생산 라인 선택.
  // spread(빌드형): 가장 적게 쌓인 라인을 채워 3라인 균등 압박 → 수비 분산 강요.
  // 집중(러쉬·타이밍): 이미 모인 라인을 유지해 한 방. 동률(초기 포함)이면 약점 라인/랜덤으로
  // 한 라인을 커밋(상단 인덱스 편향 제거).
  function pickProductionLine(state, side, ps, garr, rng) {
    // 라인별 부하 = 주둔 + 이번 턴 큐(미완성 유닛). 큐를 포함해야 집중형이 첫 웨이브를
    // 한 라인에 제대로 커밋하고, 분산형이 큐까지 고려해 균등하게 채운다.
    const load = garr.slice();
    for (const u of state.queues[side].units) if (u.line >= 0 && u.line < C.LINES) load[u.line] += 1;
    const pickTied = (cands) => {
      const weak = weakestEnemyLine(state, side);
      if (weak >= 0 && cands.indexOf(weak) >= 0) return weak;
      return cands[randInt(rng, cands.length)];
    };
    if (ps.spread) {
      let min = Infinity;
      for (let l = 0; l < C.LINES; l++) min = Math.min(min, load[l]);
      const cands = [];
      for (let l = 0; l < C.LINES; l++) if (load[l] === min) cands.push(l);
      return pickTied(cands);
    }
    let max = -1;
    for (let l = 0; l < C.LINES; l++) max = Math.max(max, load[l]);
    const cands = [];
    for (let l = 0; l < C.LINES; l++) if (load[l] === max) cands.push(l);
    return cands.length > 1 ? pickTied(cands) : cands[0];
  }

  // 본진 인접 칸(긴급)의 적 유닛 수 합. P0: slot1 / P1: slot3
  function urgentThreat(state, side) {
    const enemy = enemyOf(side);
    const adj = side === 0 ? 1 : 3;
    let n = 0;
    for (let l = 0; l < C.LINES; l++) {
      const a = state.lines[l][adj].armies[enemy];
      if (a && a.count > 0) n += a.count;
    }
    return n;
  }

  // 정찰 정보 기준 가장 약한 적 라인(병력/포탑 적음). 정보 없으면 -1.
  function weakestEnemyLine(state, side) {
    const intel = state.intel[side];
    let best = -1, bestScore = Infinity;
    for (let l = 0; l < C.LINES; l++) {
      const info = intel[l];
      if (!info) continue;
      let score = 0;
      for (const k in info.visible) score += (info.visible[k].count || 0) + (info.visible[k].tower ? 2 : 0);
      if (info.baseTowerSeen) score += 2;
      if (score < bestScore) { bestScore = score; best = l; }
    }
    return best;
  }

  // 본진포탑이 데미지를 입었는지(=피격 중). 회복으로 곧 차오르므로 "현재 손상" 판정.
  function baseTowerDamaged(p) {
    return !!p.baseTower && p.baseTower.hp < towerCount(p.baseTower.hp) * C.TOWER_HP;
  }

  // 정찰 보낼 라인: 아직 정보 없는 라인 우선, 없으면 랜덤.
  function pickScoutLine(state, side, rng) {
    for (let l = 0; l < C.LINES; l++) if (!state.intel[side][l]) return l;
    return randInt(rng, C.LINES);
  }

  // 정찰 정보 종합 → 적 프로필. 정보 없으면 null.
  //  workers: 본진 도달 시에만 파악(아니면 null), units: 목격/사망지점 최대 병력,
  //  towers: 목격한 (라인/본진)포탑 수, aggressive: 전방 병력이 정찰병을 잡음(공세적 신호).
  function enemyProfile(state, side) {
    const intel = state.intel[side];
    let workers = null, units = 0, aggressive = false, any = false;
    const towerKeys = new Set();
    for (let l = 0; l < C.LINES; l++) {
      const info = intel[l];
      if (!info) continue;
      any = true;
      for (const k in info.visible) {
        const v = info.visible[k];
        if (v.count > units) units = v.count;
        if (v.tower) towerKeys.add("L" + l);
      }
      if (info.death) {
        if ((info.death.units || 0) > units) units = info.death.units;
        if (info.death.tower) towerKeys.add("L" + l);
        else if ((info.death.units || 0) > 0) aggressive = true; // 포탑 아닌 병력에 사망
      }
      if (info.baseTowerSeen) towerKeys.add("base");
      if (info.baseInfo) {
        workers = info.baseInfo.workers;
        if (info.baseInfo.baseTowerHp > 0) towerKeys.add("base");
      }
    }
    if (!any) return null;
    return { workers, units, towers: towerKeys.size, aggressive };
  }

  // 적 성향 분류: RUSH / ECONOMY / GREED_DEFENSE / null.
  //  포탑을 봤다 → 방어형(배째기). 본진까지 보고 일꾼 많다 → 경제. 전방 병력에 정찰병이
  //  잡혔다(포탑 아님) → 러쉬.
  function classifyEnemy(prof) {
    if (!prof) return null;
    if (prof.towers >= 1) return "GREED_DEFENSE";
    if (prof.aggressive || prof.units >= 3) return "RUSH";
    if (prof.workers != null && prof.workers >= 7) return "ECONOMY";
    return null;
  }

  // 적응형 정찰형: 분류 결과에 따라 파라미터 세트를 카운터 전략으로 전환.
  //   적 경제 → 타이밍러쉬 / 적 러쉬 → 방어 후 역공 / 적 배째기 → 경제형(더 배째기).
  function adaptScout(state, side, ps) {
    if (!state._scoutType) state._scoutType = [null, null];
    const t = classifyEnemy(enemyProfile(state, side));
    if (t) state._scoutType[side] = t; // 마지막 분류 유지(정보 사라져도 전략 고수)
    const type = state._scoutType[side];
    const o = Object.assign({}, ps);
    o._enemyType = type;
    if (type === "RUSH") {            // DEFENSE_MODE: 본진포탑으로 막으며 경제 키워 역공
      o.targetWorkers = 10; o.attackThreshold = 5; o.attackMax = 6;
      o.reserve = 3; o.opportunist = false;
      o.wantBaseTower = true; o.wantLineTower = true; o.stackBaseTower = true;
    } else if (type === "ECONOMY") {
      if (state._pressured && state._pressured[side]) {
        // 상대가 실은 공격형(타이밍) → 본진포탑으로 버티고 경제 채워 더 큰 공격으로 타개
        o.targetWorkers = 11; o.attackThreshold = 8; o.attackMax = 10;
        o.reserve = 2; o.opportunist = false; o.wantBaseTower = true; o.defends = true;
      } else {
        // 진짜 경제(수동) → 빠른 소규모 버프 공세로 탐욕 처벌(포탑 없이 공세 전념)
        o.targetWorkers = 7; o.attackThreshold = 5; o.attackMax = 5;
        o.reserve = 0; o.opportunist = false; o.wantBaseTower = false;
        o.timedUpgrade = true; o.timedUpgradeBranch = "atk"; o.timedUpgradeCap = 2;
      }
    } else if (type === "GREED_DEFENSE") { // ECONOMY_MODE: 배째기보다 더 배째기
      o.targetWorkers = 15; o.greedUntil = 13;
      o.wantBaseTower = true; o.attackThreshold = 6; o.attackMax = 7; o.opportunist = true;
    }
    return o;
  }

  // ========================================================================
  // 시뮬레이터 — AI vs AI
  // ========================================================================
  function playGame(playstyleA, playstyleB, seed) {
    // 측별 독립 RNG: 두 AI가 같은 스트림을 공유하면 호출 순서가 rng 소비를 바꿔
    // 선후공 편차(후공 유리)가 생긴다. 독립 스트림으로 매치업을 대칭·공정하게.
    const s = seed || 1;
    const rngA = makeRng(s * 7 + 1);
    const rngB = makeRng(s * 7 + 2);
    const rngR = makeRng(s * 7 + 3);
    const state = createState();
    while (state.winner === null && state.turn < C.MAX_TURNS) {
      aiTakeTurn(state, 0, playstyleA, rngA);
      aiTakeTurn(state, 1, playstyleB, rngB);
      resolveTurn(state, rngR);
    }
    return {
      winner: state.winner === null ? "draw" : state.winner,
      turns: state.turn,
    };
  }

  function simulate(playstyleA, playstyleB, n) {
    n = n || 100;
    let a = 0, b = 0, draw = 0, totalTurns = 0;
    for (let i = 0; i < n; i++) {
      const r = playGame(playstyleA, playstyleB, i + 1);
      if (r.winner === 0) a++;
      else if (r.winner === 1) b++;
      else draw++;
      totalTurns += r.turns;
    }
    return {
      a, b, draw, n,
      aRate: a / n, bRate: b / n, drawRate: draw / n,
      avgTurns: totalTurns / n,
      labelA: PLAYSTYLES[playstyleA] ? PLAYSTYLES[playstyleA].name : playstyleA,
      labelB: PLAYSTYLES[playstyleB] ? PLAYSTYLES[playstyleB].name : playstyleB,
    };
  }

  return {
    C,
    LINE_NAMES,
    PLAYSTYLES,
    makeRng,
    createState,
    applyAction,
    resolveTurn,
    resolveTurnSteps,
    detectEngagements,
    resolveMovement,
    resolveCombat,
    resolveBase,
    advanceHalted,
    collectIncome,
    completeProduction,
    resolveScouts,
    runScout,
    garrisonCounts,
    incomingThreat,
    weakestEnemyLine,
    researchCost,
    aiTakeTurn,
    aiChooseAction,
    playGame,
    simulate,
    // 방향 헬퍼(테스트/UI용)
    spawnSlot, enemyBaseSlot, ownBaseSlot, enemyOf, dir,
  };
});
