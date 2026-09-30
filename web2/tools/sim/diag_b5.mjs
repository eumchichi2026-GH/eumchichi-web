/*
 * B5 진단 (TOOLS · 평가 담당 · 명세 §11 B5 "시드만 다른 두 세션이 같은 곡으로 끝남 ≤ 35%") — 판정 밖, 근거 숫자만.
 *
 *   node tools/sim/diag_b5.mjs [--stride 1]
 *
 * 신규 사용자 P0 정책으로 iso1224 격자를 돌려(diag_hold 와 같은 흐름) 목표 칩마다
 *   · 목표 좌표(마지막 경유지, 작업 좌표)에서 카탈로그 곡의 k 번째로 가까운 거리(k = 1, 2, 3, 5, 12)와 0.036 · 0.05 안 곡 수
 *   · 격자 세션의 도착 오차(마지막 곡 ↔ 목표) 중앙·최대, 서로 다른 마지막 곡 수, 같은 곡으로 끝남(30·60분)
 * 를 낸다. 목적: "B5 는 봉투(B1 도착 90% ≤ 0.036) 안에서 닿지 못한다"는 주장이 카탈로그 밀도로 설명되는지 확인.
 * 수치는 실카탈로그(데이터 저장소 origin/master, git show)·작업 트리 엔진·규칙 기준. 사용자 기록은 쓰지 않는다(신규 사용자 정책).
 */
import { parseArgs, loadDeps, normScenario } from "./lib_env.mjs";
import { makeShared } from "./lib_session.mjs";
import { gridRun } from "./lib_grid.mjs";
import { pathShape, q } from "./lib_metrics.mjs";

const A = parseArgs();
const deps = await loadDeps({ needBaseline: false, needGrids: true });
const shared = makeShared(deps);
const stride = Math.max(1, Number(A.stride ?? 1));
const sc = deps.grids.iso1224({ tables: deps.tables76 }).filter((_, i) => i % stride === 0);
const runs = gridRun({ deps, shared, scenarios: sc, mode: "p0" });

/* 목표 칩별 목표 좌표(작업 좌표) — 한 시나리오의 마지막 경유지. 같은 칩이면 같아야 한다(다르면 표시) */
const { personal, engine, rules } = deps;
const tgt = new Map();
for (const raw of sc) {
  const n = normScenario(raw), g = n.goal_label;
  if (tgt.has(g)) continue;
  const ctx = { now: n.now, target: n.target, labels: { current: { mode: "tap" }, target: { mode: "tap" } }, nudged: { current: false, target: false },
                minutes: 30, lyric: "no_preference", genres: [], pace_user: null, seed: "diag_b5", global_stats: {}, disliked_now: [], session_no: 1 };
  const pol = personal.resolvePolicy(personal.emptyModel(rules), ctx, rules);
  const res = engine.recommend(shared.contract, rules, { now: { V: n.now.v, A: n.now.e }, target: { V: n.target.v, A: n.target.e },
                                                          stress: null, load: null, genres: [], duration_min: 30, seed: "diag_b5", gates: [], user: pol.user, pace: null, personal: pol.policy });
  const m = pathShape(res);
  if (m && m.waypoints && m.waypoints.length) tgt.set(g, m.waypoints.at(-1));
}
const coords = deps.cat.index.coords;   // Map song_id → [V, A] 작업 좌표 (엔진 workingCoords)
const pts = [...coords.values()].map((p) => (Array.isArray(p) ? p : [Number(p.V ?? p.v ?? p[0]), Number(p.A ?? p.e ?? p[1])]));
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—");
console.log(`iso1224 · P0 · ${runs.length}세션 (합성 입력, 실카탈로그 ${pts.length}곡)`);
console.log("목표 칩 | 1·2·3·5·12번째로 가까운 곡 거리 | 0.036 안 · 0.05 안 곡 수 | 격자 도착 오차 중앙·최대 | 서로 다른 마지막 곡 | 같은 곡으로 끝남(30·60분)");
const chip = [];
for (const [g, t] of tgt) {
  const ds = pts.map((p) => Math.hypot(p[0] - t[0], p[1] - t[1])).sort((a, b) => a - b);
  const mine = runs.filter((x) => x.m && x.m.n >= 2 && x.sc.goal_label === g);
  const arr = mine.map((x) => x.m.arrival);
  const groups = new Map();
  for (const x of mine) if (x.sc.minutes === 30 || x.sc.minutes === 60) {
    const k = `${x.sc.now_label}|${x.sc.minutes}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x.m.last_id);
  }
  let pairs = 0, same = 0;
  for (const ids of groups.values()) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { pairs++; if (ids[i] === ids[j]) same++; }
  chip.push({ g, ds, mine, pairs, same, n036: ds.filter((d) => d <= 0.036).length });
  console.log(`${g} | ${[1, 2, 3, 5, 12].map((k) => f3(ds[k - 1])).join(" · ")} | ${ds.filter((d) => d <= 0.036).length} · ${ds.filter((d) => d <= 0.05).length} | ${f3(q(arr, 0.5))} · ${f3(Math.max(...arr))} | ${new Set(mine.map((x) => x.m.last_id)).size} | ${pairs ? ((100 * same) / pairs).toFixed(1) + "%" : "—"} (${pairs}쌍)`);
}
/* 산술 반사실(엔진을 돌리지 않음): 가장 성긴 칩에서 세션의 비율 f 가 두 번째로 가까운 곡으로 끝났다면
 * (1) 격자 도착 오차 90%(B1g ≤ 0.036)는? (2) 그 칩의 같은 곡으로 끝남 ≈ f² + (1−f)² (시드가 둘 중 하나를 고르게 고른다고 볼 때) → 전체 B5 는?
 * 봉투의 다른 조건(역행·지그재그·도착 상한)은 이 계산이 보지 않는다 — "B1 산술만으로는 불가능하지 않다"를 보이는 용도. */
{
  const all = runs.filter((x) => x.m && x.m.n >= 2);
  const sp = chip.slice().sort((a, b) => a.n036 - b.n036)[0];
  const rate = (c) => (c.pairs ? c.same / c.pairs : 0);
  console.log(`반사실(산술) — 가장 성긴 칩 '${sp.g}'(0.036 안 ${sp.n036}곡)의 세션 비율 f 가 두 번째 곡(거리 ${f3(sp.ds[1])})으로 끝나면:`);
  for (const f of [0, 0.25, 0.3, 0.5]) {
    const own = sp.mine.slice().sort((a, b) => a.m.arrival - b.m.arrival);
    const moved = new Set(own.slice(0, Math.round(f * own.length)));
    const arr = all.map((x) => (moved.has(x) ? Math.max(x.m.arrival, sp.ds[1]) : x.m.arrival));
    const spSame = f === 0 ? rate(sp) : Math.max(0, rate(sp) - (1 - (f * f + (1 - f) * (1 - f))));
    const b5 = (chip.reduce((a, c) => a + (c === sp ? spSame : rate(c)), 0)) / chip.length;
    console.log(`  f ${f.toFixed(2)} → 격자 도착 90% ${f3(q(arr, 0.9))} (≤ 0.036) · '${sp.g}' 같은 곡 끝 ${(100 * spSame).toFixed(1)}% · 전체 B5 ${(100 * b5).toFixed(1)}% (≤ 35%)`);
  }
}
