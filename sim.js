/*
 * DEADLINE 밸런스 테스트 — Node 실행용
 *   node sim.js          → 전투 단위 테스트 + 기본 매치업 100판 승률
 */
const E = require("./engine.js");
const { C } = E;

// ---------- 전투 단위 테스트 ----------
function assert(cond, msg) {
  if (!cond) { console.error("  ✗ FAIL: " + msg); process.exitCode = 1; }
  else console.log("  ✓ " + msg);
}

// 헬퍼: 빈 상태에서 특정 칸에 군대/포탑 놓고 전투만 돌림
function setArmy(state, line, slot, owner, count) {
  state.lines[line][slot].armies[owner] = { hp: count * C.UNIT_HP, count, marching: 0 };
}
function setTower(state, line, slot, owner) {
  state.lines[line][slot].tower = { owner, hp: C.TOWER_HP };
}

console.log("== 전투 밸런스 단위 테스트 ==");

// 1기 vs 포탑 → 포탑 승
{
  const s = E.createState();
  setTower(s, 0, 1, 0);        // P0 포탑 at pos1
  setArmy(s, 0, 1, 1, 1);      // P1 유닛 1기 같은 칸
  E.resolveCombat(s);
  assert(s.lines[0][1].tower && s.lines[0][1].tower.hp === 10, "1기 vs 포탑: 포탑 생존(HP10)");
  assert(!s.lines[0][1].armies[1], "1기 vs 포탑: 유닛 전멸");
}

// 2기 동시 vs 포탑 → 동귀어진
{
  const s = E.createState();
  setTower(s, 0, 1, 0);
  setArmy(s, 0, 1, 1, 2);
  E.resolveCombat(s);
  assert(!s.lines[0][1].tower, "2기 vs 포탑: 포탑 파괴");
  assert(!s.lines[0][1].armies[1], "2기 vs 포탑: 유닛도 전멸(동귀어진)");
}

// 3기 동시 vs 포탑 → 포탑 파괴, 1기 침투
{
  const s = E.createState();
  setTower(s, 0, 1, 0);
  setArmy(s, 0, 1, 1, 3);
  E.resolveCombat(s);
  assert(!s.lines[0][1].tower, "3기 vs 포탑: 포탑 파괴");
  assert(s.lines[0][1].armies[1] && s.lines[0][1].armies[1].count === 1, "3기 vs 포탑: 1기 생존 침투");
}

// 순차 1+1 → 포탑 승 (회복 메커니즘)
{
  const s = E.createState();
  setTower(s, 0, 1, 0);
  // 1차
  setArmy(s, 0, 1, 1, 1);
  E.resolveCombat(s);
  E.resolveTurn ? null : null;
  // 포탑 회복 시뮬: 턴 종료 회복을 직접 적용(엔진 regen은 resolveTurn 내부)
  const t = s.lines[0][1].tower;
  for (let i = 0; i < 5; i++) if (t.hp < C.TOWER_HP) t.hp = Math.min(C.TOWER_HP, t.hp + C.TOWER_REGEN);
  // 2차
  setArmy(s, 0, 1, 1, 1);
  E.resolveCombat(s);
  assert(s.lines[0][1].tower && !s.lines[0][1].armies[1], "순차 1+1: 포탑이 회복 후 막아냄(포탑 승)");
}

// 3기 vs 2기 유닛전 → 1기 생존
{
  const s = E.createState();
  setArmy(s, 0, 2, 0, 3);
  setArmy(s, 0, 2, 1, 2);
  E.resolveCombat(s);
  assert(s.lines[0][2].armies[0] && s.lines[0][2].armies[0].count === 1, "3기 vs 2기: 공격측 1기 생존");
  assert(!s.lines[0][2].armies[1], "3기 vs 2기: 방어측 전멸");
}

// 3차 변경 기능 테스트
{
  // 교차: owner0 slot1 3기 marching, owner1 slot2 2기 marching → 3vs2, 승자 1기 slot2 전진
  const s = E.createState();
  s.lines[0][1].armies[0] = { hp: 30, count: 3, marching: 3 };
  s.lines[0][2].armies[1] = { hp: 20, count: 2, marching: 2 };
  E.resolveMovement(s);
  const a = s.lines[0][2].armies[0];
  assert(a && a.count === 1 && a.marching === 1, "교차 전투: 승자 1기 전진(slot2), marching 동기화");
  assert(!s.lines[0][2].armies[1] && !s.lines[0][1].armies[1], "교차 전투: 패자 전멸");
}
{
  // 다중 본진포탑(hp40=2개) vs 3유닛 → 포탑 생존
  const s = E.createState();
  s.players[1].baseTower = { hp: 40 };
  s.lines[0][4].armies[0] = { hp: 30, count: 3, marching: 0 };
  E.resolveBase(s);
  assert(s.players[1].baseTower && s.players[1].baseTower.hp === 10, "본진포탑2(hp40) vs 3유닛: 포탑 생존(hp10)");
  assert(!s.lines[0][4].armies[0], "본진포탑2 vs 3유닛: 유닛 전멸");
}
{
  // 유닛 3마리 한 행동 생산
  const s = E.createState(); s.players[0].gold = 1000;
  E.applyAction(s, 0, { type: "unit", line: 0, count: 3 });
  assert(s.queues[0].units.length === 3 && s.players[0].gold === 850, "유닛 3마리/행동 생산(150G)");
}
{
  // 공격연구1 → effAtk 12
  const s = E.createState(); s.players[0].research.atk = 1;
  s.players[1].baseTower = { hp: 20 };
  s.lines[0][4].armies[0] = { hp: 30, count: 3, marching: 0 };
  E.resolveBase(s);
  assert(!s.players[1].baseTower, "공격연구1 3유닛(ATK12): 본진포탑1 파괴");
}

{
  // 돌파: P0 진군 3기가 적 1칸(slot3) 라인포탑 격파 후 같은 턴 본진 진입→일꾼 타격
  const s = E.createState();
  s.lines[0][3].armies[0] = { hp: 30, count: 3, marching: 3 };
  s.lines[0][3].tower = { owner: 1, hp: 20 }; // 적 라인포탑
  const w0 = s.players[1].workers;
  E.resolveMovement(s); E.resolveCombat(s); E.advanceHalted(s); E.resolveBase(s);
  const atBase = s.lines[0][4].armies[0];
  assert(!s.lines[0][3].tower, "돌파: 적 1칸 포탑 격파");
  assert(atBase && atBase.count === 1, "돌파: 승자 1기가 본진칸 진입");
  assert(s.players[1].workers === w0 - 1, "돌파: 같은 턴 본진 일꾼 타격");
}

// ---------- 온라인 락스텝 결정성 테스트 ----------
// 두 측 행동을 (A) side0 먼저 / (B) side1 먼저 적용해도 resolveTurn 결과가 동일해야
// 클라이언트-권위 락스텝이 성립한다(각 측 applyAction이 서로 독립).
console.log("\n== 온라인 락스텝 결정성 테스트 ==");
{
  const a0 = [
    { type: "worker" },
    { type: "unit", line: 0, count: 3 },
    { type: "tower", line: 1, count: 1 },
  ];
  const a1 = [
    { type: "unit", line: 2, count: 2 },
    { type: "research", branch: "atk" },
    { type: "baseTower", count: 1 },
  ];
  function build(order) {
    const s = E.createState();
    s.players[0].gold = 1000; s.players[1].gold = 1000;
    // 공격 명령이 의미있도록 주둔 병력 동일 배치
    s.lines[0][1].armies[0] = { hp: 20, count: 2, marching: 0 };
    s.lines[0][3].armies[1] = { hp: 20, count: 2, marching: 0 };
    const acts = order === 0
      ? [[0, a0], [1, a1], [0, [{ type: "attack", line: 0, count: 2 }]], [1, [{ type: "attack", line: 0, count: 2 }]]]
      : [[1, a1], [0, a0], [1, [{ type: "attack", line: 0, count: 2 }]], [0, [{ type: "attack", line: 0, count: 2 }]]];
    for (const [side, list] of acts) for (const act of list) E.applyAction(s, side, act);
    E.resolveTurn(s);
    return s;
  }
  const sA = build(0), sB = build(1);
  // log는 적용 순서에 따라 줄 순서만 다를 수 있어 비교에서 제외(게임 상태 아님)
  sA.log = []; sB.log = [];
  assert(JSON.stringify(sA) === JSON.stringify(sB),
    "양측 행동 적용 순서 무관: resolveTurn 결과 동일(락스텝 성립)");
}

// ---------- AI vs AI 전체 매트릭스 (양방향 평균) ----------
console.log("\n== AI vs AI 매트릭스 (행이 열을 이기는 승률, 양방향 평균 N=각 60판) ==");
const N = 60;
const order = ["rush", "turtle", "economy", "timingAtk", "timingDef", "scout", "greedyTurtle"];
const label = (k) => E.PLAYSTYLES[k].name;
// win[a][b] = a가 b를 이긴 비율(양방향 평균)
const win = {};
for (const a of order) { win[a] = {}; }
for (let i = 0; i < order.length; i++) {
  for (let j = i + 1; j < order.length; j++) {
    const a = order[i], b = order[j];
    const r1 = E.simulate(a, b, N);   // a=0측
    const r2 = E.simulate(b, a, N);   // a=1측
    const aWin = (r1.aRate + r2.bRate) / 2;
    const bWin = (r1.bRate + r2.aRate) / 2;
    win[a][b] = aWin; win[b][a] = bWin;
  }
}
const pad = (s, n) => String(s).padEnd(n);
const p3 = (x) => (x * 100).toFixed(0).padStart(3);
let header = pad("", 9);
for (const b of order) header += pad(label(b), 9);
console.log(header + "  평균");
for (const a of order) {
  let row = pad(label(a), 9);
  let sum = 0, cnt = 0;
  for (const b of order) {
    if (a === b) { row += pad("  -", 9); continue; }
    row += pad("   " + p3(win[a][b]) + "%", 9);
    sum += win[a][b]; cnt++;
  }
  console.log(row + "  " + p3(sum / cnt) + "%");
}
console.log("\n목표: 방어>러쉬, 경제>방어, 러쉬·타이밍>경제, 방어>타이밍 / 평균 40~60%대");
