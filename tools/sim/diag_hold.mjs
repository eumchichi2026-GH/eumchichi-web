/*
 * 머묾 구간 진단 (TOOLS · 2026-09-29 1차 수정의 근거 숫자를 다시 내는 스크립트 — rules 의 hold.*_evidence · safety.pers_bucket_evidence)
 *
 *   node tools/sim/diag_hold.mjs --grid [--patch '{"hold.cluster":false}'] [--stride 1] [--adj]
 *       신규 사용자 P0 정책으로 iso1224 격자를 돌려 B1–B5 요약 + 목표 칩별 "시드만 다른 두 세션이 같은 곡으로 끝남"(30·60분) · 칩별 머묾 곡 수.
 *       --patch 는 personalization.<경로> 값을 메모리에서만 바꾼다(파일·rules_hash 그대로 — 실험용). --adj 면 adj660 의 C1 도.
 *   node tools/sim/diag_hold.mjs --turns <run.mjs --json 결과>
 *       페르소나·팔별 90° 꺾임·역행 세션 비율과 꺾임 꼭짓점 위치(머묾 첫 곡 = 0) 분포 — 꺾임이 어디서 생기는지.
 *
 * 수치는 합성 사용자·실카탈로그(데이터 저장소 origin/master, git show) 기준. 엔진·규칙은 작업 트리 그대로.
 */
import fs from "node:fs";
import { parseArgs, loadDeps } from "./lib_env.mjs";
import { makeShared } from "./lib_session.mjs";
import { gridRun, isoSummary, adjSummary, patchRules } from "./lib_grid.mjs";

const A = parseArgs();
const pct = (x) => (100 * x).toFixed(1) + "%";

if (A.turns) {
  const J = JSON.parse(fs.readFileSync(String(A.turns), "utf8"));
  const R = J.records.filter((r) => !r.error && r.shape && r.arm !== "legacy");
  const by = {};
  for (const r of R) {
    const o = by[r.persona + "|" + r.arm] || (by[r.persona + "|" + r.arm] = { n: 0, t: 0, b: 0 });
    o.n++; if (r.shape.turns > 0) o.t++; if (r.shape.back > 0) o.b++;
  }
  const ps = [...new Set(R.map((r) => r.persona))].sort((a, b) => Number(a.slice(1).replace(/\D/g, "")) - Number(b.slice(1).replace(/\D/g, "")));
  console.log("페르소나  wp 꺾임/역행 · frozen 꺾임 · twin 꺾임");
  for (const p of ps) {
    const c = (arm, k) => { const o = by[p + "|" + arm]; return o ? pct(o[k] / o.n) : "-"; };
    console.log(p.padEnd(6), c("wp", "t"), "/", c("wp", "b"), " · ", c("frozen", "t"), " · ", c("twin", "t"));
  }
  for (const arm of ["wp", "frozen", "twin"]) {
    const rs = R.filter((r) => r.arm === arm);
    if (!rs.length) continue;
    const hist = {};
    for (const r of rs) for (const x of r.shape.turn_at || []) hist[x] = (hist[x] || 0) + 1;
    console.log(`${arm}: 꺾임 세션 ${pct(rs.filter((r) => r.shape.turns > 0).length / rs.length)} (${rs.length}세션) · 꼭짓점 위치(머묾 첫 곡 = 0) ${JSON.stringify(hist)}`);
  }
} else if (A.grid) {
  const deps = await loadDeps({ needBaseline: false, needGrids: true });
  const shared = makeShared(deps);
  const patches = A.patch ? JSON.parse(String(A.patch)) : {};
  let R = deps.rules;
  for (const [k, v] of Object.entries(patches)) R = patchRules(R, k, v);
  const stride = Math.max(1, Number(A.stride ?? 1));
  const sc = deps.grids.iso1224({ tables: deps.tables76 }).filter((_, i) => i % stride === 0);
  const runs = gridRun({ deps, shared, scenarios: sc, mode: "p0", rules: R });
  const s = isoSummary(runs);
  const groups = new Map();
  for (const x of runs) if (x.m && x.m.n >= 2 && (x.sc.minutes === 30 || x.sc.minutes === 60)) {
    const k = `${x.sc.now_label}|${x.sc.goal_label}|${x.sc.minutes}`;
    if (!groups.has(k)) groups.set(k, { goal: x.sc.goal_label, ids: [] });
    groups.get(k).ids.push(x.m.last_id);
  }
  const g = {};
  for (const { goal, ids } of groups.values()) {
    const o = g[goal] || (g[goal] = { pairs: 0, same: 0 });
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { o.pairs++; if (ids[i] === ids[j]) o.same++; }
  }
  console.log(`[iso1224 · P0${Object.keys(patches).length ? " · patch " + JSON.stringify(patches) : ""}] ${s.n}세션`);
  console.log(`  B1 도착 오차 중앙/90% ${s.arr50.toFixed(4)} / ${s.arr90.toFixed(4)} · B2 최대 전환 중앙 ${s.jump50.toFixed(3)} · B3 역행 ${pct(s.back)} · 꺾임 ${pct(s.turns)} (머묾 안 ${pct(s.holdTurns)}) · 지그재그 ${s.zig}`);
  console.log(`  B4 첫 곡 거리 중앙 ${s.start50.toFixed(4)} · B5 같은 곡으로 끝남 ${pct(s.sameEnd)} · 칩당 머묾 곡 ${s.holdDistinct.toFixed(1)}`);
  console.log("  칩별 같은 곡으로 끝남: " + Object.entries(g).map(([k, o]) => `${k} ${pct(o.same / o.pairs)}`).join(" · "));
  console.log("  칩별 머묾 곡: " + Object.entries(s.holdDistinctByGoal).map(([k, v]) => `${k} ${v}`).join(" · "));
  if (A.adj) {
    const ar = gridRun({ deps, shared, scenarios: deps.grids.adj660({ tables: deps.tables76 }), mode: "p0", rules: R });
    const a = adjSummary(ar, deps.cat.index.byId);
    console.log(`  [adj660] C1a BPM 차 중앙/90% ${a.bpm50.toFixed(1)} / ${a.bpm90.toFixed(1)} · C1b 보컬↔연주 ${pct(a.flip)} · C1c 2개 이상 ${pct(a.flags2)} · C1d 서로 다른 곡 ${a.distinct}`);
  }
} else {
  console.error("사용법: node tools/sim/diag_hold.mjs --grid [--patch JSON] [--stride k] [--adj] | --turns <run.json>");
  process.exit(2);
}
