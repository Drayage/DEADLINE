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
      baseTower: null, // { hp } | null
      alive: true,
    };
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
    return { workers: 0, units: [], towers: [], baseTower: false, scouts: [] };
    // units: [{line}], towers: [{line}], scouts: [{line}]
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
      if (p.gold < C.COST_UNIT) return fail("골드 부족");
      p.gold -= C.COST_UNIT;
      q.units.push({ line: action.line });
      return ok();
    }
    if (action.type === "tower") {
      if (p.gold < C.COST_TOWER) return fail("골드 부족");
      const slot = state.lines[action.line][spawnSlot(side)];
      if (slot.tower) return fail("이미 포탑 있음");
      // 같은 턴 중복 건설 방지
      if (q.towers.some((t) => t.line === action.line)) return fail("이미 건설 예약");
      p.gold -= C.COST_TOWER;
      q.towers.push({ line: action.line });
      return ok();
    }
    if (action.type === "baseTower") {
      if (p.gold < C.COST_BASE_TOWER) return fail("골드 부족");
      if (p.baseTower) return fail("본진포탑 존재");
      if (q.baseTower) return fail("이미 건설 예약");
      p.gold -= C.COST_BASE_TOWER;
      q.baseTower = true;
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
      let n = action.count == null ? garr.count : Math.min(action.count, garr.count);
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

  function countQueuedScouts(q) { return q.scouts.length; }

  // ---------- 턴 해결 ----------
  // 행동은 이미 applyAction으로 적용됨(공격 명령 포함). 여기서 순서대로 처리.
  function resolveTurn(state, rng) {
    rng = rng || Math.random;
    // 2. 이동
    resolveMovement(state);
    // 3. 전투 (칸별 + 본진)
    resolveCombat(state);
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
      { name: "전투", apply: () => { resolveCombat(state); resolveBase(state); } },
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

  // 2. 이동: marching 병력을 진군 방향으로 1칸 이동.
  function resolveMovement(state) {
    for (let l = 0; l < C.LINES; l++) {
      const slots = state.lines[l];
      // 각 owner에 대해, 진군 방향으로 처리(겹침 방지 위해 방향 끝에서부터)
      for (let owner = 0; owner < 2; owner++) {
        const d = dir(owner);
        // 진군 방향으로 먼 칸부터 이동(앞 칸이 비도록)
        const order = d === 1
          ? [3, 2, 1, 0] // owner0: 앞쪽(큰 인덱스)부터
          : [1, 2, 3, 4]; // owner1: 앞쪽(작은 인덱스)부터
        for (const s of order) {
          const slot = slots[s];
          const army = slot.armies[owner];
          if (!army || !army.marching || army.marching <= 0) continue;
          const enemy = enemyOf(owner);
          // 현재 칸에 적 유닛/적 포탑이 있으면 이동하지 않고 정지(전투 단계에서 교전).
          const enemyArmy = slot.armies[enemy];
          const enemyTower = slot.tower && slot.tower.owner === enemy;
          if ((enemyArmy && enemyArmy.count > 0) || enemyTower) continue;
          const ns = s + d;
          if (ns < 0 || ns >= C.SLOTS) continue;
          const moveCount = army.marching;
          const moveHp = moveCount * C.UNIT_HP; // 진군 병력은 풀피로 간주(주둔 시 회복)
          // 출발 칸에서 차감
          army.count -= moveCount;
          army.marching = 0;
          army.hp = army.count * C.UNIT_HP;
          if (army.count <= 0) slot.armies[owner] = null;
          // 도착 칸에 합류(계속 진군 상태로)
          const dest = slots[ns];
          if (!dest.armies[owner]) dest.armies[owner] = { hp: 0, count: 0, marching: 0 };
          dest.armies[owner].count += moveCount;
          dest.armies[owner].hp += moveHp;
          dest.armies[owner].marching += moveCount; // 다음 턴 계속 진군
        }
      }
    }
  }

  // 3. 전투: 칸마다 양 owner 군대가 있으면 전멸까지 / 포탑과 만나면 전멸까지.
  function resolveCombat(state) {
    for (let l = 0; l < C.LINES; l++) {
      const slots = state.lines[l];
      for (let s = 0; s < C.SLOTS; s++) {
        const slot = slots[s];
        // 본진 칸(0,4)은 resolveBase에서 처리
        if (s === 0 || s === 4) continue;
        const a0 = slot.armies[0];
        const a1 = slot.armies[1];
        // 유닛 vs 유닛
        if (a0 && a0.count > 0 && a1 && a1.count > 0) {
          fightToDeath(slot, l, s, state);
        }
        // 유닛 vs 포탑 (포탑 owner와 반대 owner 유닛)
        if (slot.tower) {
          const attacker = enemyOf(slot.tower.owner);
          const army = slot.armies[attacker];
          if (army && army.count > 0) {
            fightArmyVsTower(slot, attacker, l, s, state);
          }
        }
      }
    }
  }

  // 두 군대 동시교전 → 한쪽 전멸까지
  function fightToDeath(slot, line, s, state) {
    let a = slot.armies[0], b = slot.armies[1];
    let guard = 0;
    while (a && a.count > 0 && b && b.count > 0 && guard++ < 100) {
      const aAtk = a.count * C.UNIT_ATK;
      const bAtk = b.count * C.UNIT_ATK;
      a.hp -= bAtk;
      b.hp -= aAtk;
      a.count = a.hp > 0 ? Math.floor(a.hp / C.UNIT_HP) : 0;
      b.count = b.hp > 0 ? Math.floor(b.hp / C.UNIT_HP) : 0;
      if (a.count <= 0) { slot.armies[0] = null; a = null; }
      if (b.count <= 0) { slot.armies[1] = null; b = null; }
    }
    // 생존측 hp 정규화(주둔/계속진군 시 정수 유지)
    normalizeArmy(slot.armies[0]);
    normalizeArmy(slot.armies[1]);
    state.log.push(`${LINE_NAMES[line]} ${s}칸 교전`);
  }

  // 군대 vs 라인 포탑 → 전멸까지(둘 중 하나 0)
  function fightArmyVsTower(slot, attacker, line, s, state) {
    const tower = slot.tower;
    let army = slot.armies[attacker];
    let guard = 0;
    while (army && army.count > 0 && tower.hp > 0 && guard++ < 100) {
      const aAtk = army.count * C.UNIT_ATK;
      const tAtk = C.TOWER_ATK;
      army.hp -= tAtk;
      tower.hp -= aAtk;
      army.count = army.hp > 0 ? Math.floor(army.hp / C.UNIT_HP) : 0;
      if (army.count <= 0) { slot.armies[attacker] = null; army = null; }
    }
    if (tower.hp <= 0) {
      slot.tower = null;
      state.log.push(`${LINE_NAMES[line]} 포탑 파괴`);
    }
    normalizeArmy(slot.armies[attacker]);
  }

  function normalizeArmy(army) {
    if (!army) return;
    if (army.count <= 0) return;
    army.hp = army.count * C.UNIT_HP; // 칩 데미지는 교전 중에만, 교전 종료 후 생존 유닛은 풀피
  }

  // 본진 칸 처리: 적 유닛이 본진 칸 도달 시 본진포탑 → 일꾼 → 본진
  function resolveBase(state) {
    for (let l = 0; l < C.LINES; l++) {
      const slots = state.lines[l];
      for (const baseSlotIdx of [0, 4]) {
        const defender = baseSlotIdx === 0 ? 0 : 1;
        const attacker = enemyOf(defender);
        const slot = slots[baseSlotIdx];
        const army = slot.armies[attacker];
        if (!army || army.count <= 0) continue;
        const dp = state.players[defender];
        // 본진포탑이 있으면 먼저 교전
        if (dp.baseTower) {
          let guard = 0;
          let a = army;
          while (a && a.count > 0 && dp.baseTower.hp > 0 && guard++ < 100) {
            const aAtk = a.count * C.UNIT_ATK;
            dp.baseTower.hp -= aAtk;
            a.hp -= C.TOWER_ATK;
            a.count = a.hp > 0 ? Math.floor(a.hp / C.UNIT_HP) : 0;
            if (a.count <= 0) { slot.armies[attacker] = null; a = null; }
          }
          if (dp.baseTower.hp <= 0) {
            dp.baseTower = null;
            state.log.push(`P${defender} ${LINE_NAMES[l]} 본진포탑 파괴`);
          }
          normalizeArmy(slot.armies[attacker]);
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
            dp.baseHp -= n * C.UNIT_ATK;
            state.log.push(`P${defender} 본진 -${n * C.UNIT_ATK} (HP ${Math.max(0, dp.baseHp)})`);
          }
        }
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
      for (const u of q.units) {
        const slot = state.lines[u.line][spawnSlot(side)];
        if (!slot.armies[side]) slot.armies[side] = { hp: 0, count: 0, marching: 0 };
        slot.armies[side].count += 1;
        slot.armies[side].hp += C.UNIT_HP;
      }
      for (const t of q.towers) {
        const slot = state.lines[t.line][spawnSlot(side)];
        if (!slot.tower) slot.tower = { owner: side, hp: C.TOWER_HP };
      }
      if (q.baseTower && !p.baseTower) {
        p.baseTower = { hp: C.TOWER_HP };
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

  function regenTowers(state) {
    for (let l = 0; l < C.LINES; l++) {
      for (let s = 0; s < C.SLOTS; s++) {
        const t = state.lines[l][s].tower;
        if (t && t.hp < C.TOWER_HP) t.hp = Math.min(C.TOWER_HP, t.hp + C.TOWER_REGEN);
      }
    }
    for (let side = 0; side < 2; side++) {
      const bt = state.players[side].baseTower;
      if (bt && bt.hp < C.TOWER_HP) bt.hp = Math.min(C.TOWER_HP, bt.hp + C.TOWER_REGEN);
    }
  }

  // 6. 정찰: 정찰병이 라인을 적 본진 방향으로 통과하며 일방적으로 피해 받음.
  function resolveScouts(state) {
    for (let side = 0; side < 2; side++) {
      const q = state.queues[side];
      const p = state.players[side];
      for (const sc of q.scouts) {
        if (p.workers <= 0) continue; // 보낼 일꾼 없음
        const result = runScout(state, side, sc.line);
        state.intel[side][sc.line] = result.intel;
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
    let hp = C.SCOUT_HP;
    const start = spawnSlot(side); // 자기 1칸에서 출발
    const enemyBase = enemyBaseSlot(side);
    const visible = {}; // slotIdx -> {count, tower}
    let death = null;
    let fullBase = false;

    // 자기 진영~중앙~적진 순으로 통과 (출발 칸 다음부터 적 본진까지)
    for (let s = start + d; ; s += d) {
      if (s === enemyBase) {
        // 적 본진 도달
        const ep = state.players[enemy];
        // 본진 정보 전부 획득
        fullBase = true;
        // 본진포탑 있으면 정찰병 사망(일꾼 손실), 없으면 무사 귀환
        if (ep.baseTower) {
          return {
            intel: makeScoutIntel(line, visible, null, true, true),
            workerDied: true,
          };
        } else {
          return {
            intel: makeScoutIntel(line, visible, null, true, false),
            workerDied: false,
          };
        }
      }
      if (s < 0 || s >= C.SLOTS) break;
      const slot = slots[s];
      const army = slot.armies[enemy];
      const towerHere = slot.tower && slot.tower.owner === enemy ? slot.tower : null;
      let dmg = 0;
      if (army && army.count > 0) dmg += army.count * C.UNIT_ATK;
      if (towerHere) dmg += C.TOWER_ATK;
      hp -= dmg;
      if (hp <= 0) {
        // 이 칸에서 사망 → 위치만, 수 미공개
        death = { slot: s };
        return {
          intel: makeScoutIntel(line, visible, death, false, false),
          workerDied: true,
        };
      }
      // 살아남음 → 이 칸 내용 정확히 기록
      visible[s] = {
        count: army ? army.count : 0,
        tower: !!towerHere,
      };
    }
    // 루프가 비정상 종료(도달 못함) → 무사 귀환 처리
    return { intel: makeScoutIntel(line, visible, null, false, false), workerDied: false };
  }

  function makeScoutIntel(line, visible, death, reachedBase, baseTowerSeen) {
    return { line, turn: null, visible, death, reachedBase, baseTowerSeen };
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
  const PLAYSTYLES = {
    rush: {
      name: "극한러쉬",
      targetWorkers: 5,      // 일꾼 거의 안 늘림 → 자연히 유닛으로
      wantBaseTower: false,
      attackThreshold: 1,    // 1기만 모여도 바로 보냄(소량씩 = 무지성)
      attackMax: 2,
      reserve: 0,            // 방어 예비 없음
      defends: false,        // 위협 와도 방어 안 함
      scoutChance: 0,
    },
    turtle: {
      name: "1포탑배째기",
      targetWorkers: 12,
      wantBaseTower: true,
      attackThreshold: 12,   // 크게 모은 뒤 한 방 역습
      attackMax: 99,         // 모은 거 전부
      reserve: 3,
      defends: true,
      scoutChance: 0.1,
    },
    economy: {
      name: "무한경제",
      targetWorkers: 18,
      wantBaseTower: true,
      attackThreshold: 16,   // 경제 폭발 후 압도적 물량 한 방
      attackMax: 99,
      reserve: 2,
      defends: true,
      scoutChance: 0.1,
    },
    timing: {
      name: "타이밍러쉬",
      targetWorkers: 7,
      wantBaseTower: false,
      attackThreshold: 6,    // 방어 갖춰지기 전 타이밍에 전부 모아치기
      attackMax: 99,
      reserve: 0,
      defends: true,
      scoutChance: 0.15,
    },
    scout: {
      name: "정찰형",
      targetWorkers: 10,
      wantBaseTower: true,
      attackThreshold: 5,
      attackMax: 99,
      reserve: 1,
      defends: true,
      scoutChance: 0.5,
      opportunist: true,     // 정찰 정보로 약한 라인 집중
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

  // AI가 한 턴(행동 2회)을 계획해 실행. 방어는 턴당 1회로 제한(과방어 = 영구 교착 방지).
  function aiTakeTurn(state, side, playstyle, rng) {
    rng = rng || Math.random;
    const ps = typeof playstyle === "string" ? PLAYSTYLES[playstyle] : playstyle;
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

    // 1) 공격: 임계 이상 모인 라인이 있으면(예비 reserve 남기고) 모은 병력 모아치기
    {
      let target = -1, best = -1;
      for (let l = 0; l < C.LINES; l++) {
        const sendable = garr[l] - ps.reserve;
        if (garr[l] >= ps.attackThreshold && sendable >= 1 && garr[l] > best) {
          best = garr[l]; target = l;
        }
      }
      if (target >= 0) {
        if (ps.opportunist) {
          const weak = weakestEnemyLine(state, side);
          if (weak >= 0 && garr[weak] - ps.reserve >= 1) target = weak;
        }
        const sendable = garr[target] - ps.reserve;
        return { type: "attack", line: target, count: Math.min(ps.attackMax, sendable) };
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

    // 5) 유닛 생산 — 한 라인에 몰아주기(모아치기 준비)
    if (p.gold >= C.COST_UNIT) {
      let target = 0, best = -1;
      for (let l = 0; l < C.LINES; l++) if (garr[l] > best) { best = garr[l]; target = l; }
      return { type: "unit", line: target };
    }

    return null;
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

  // ========================================================================
  // 시뮬레이터 — AI vs AI
  // ========================================================================
  function playGame(playstyleA, playstyleB, seed) {
    const rng = makeRng(seed || 1);
    const state = createState();
    while (state.winner === null && state.turn < C.MAX_TURNS) {
      aiTakeTurn(state, 0, playstyleA, rng);
      aiTakeTurn(state, 1, playstyleB, rng);
      resolveTurn(state, rng);
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
    collectIncome,
    completeProduction,
    resolveScouts,
    runScout,
    garrisonCounts,
    incomingThreat,
    weakestEnemyLine,
    aiTakeTurn,
    aiChooseAction,
    playGame,
    simulate,
    // 방향 헬퍼(테스트용)
    spawnSlot, enemyBaseSlot, dir,
  };
});
