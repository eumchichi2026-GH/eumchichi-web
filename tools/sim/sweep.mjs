/*
 * 규칙 스윕 (TOOLS · 명세 §4.8.2 D7) — personalization 절의 값 하나(또는 둘의 곱)를 바꿔 가며 신규 사용자 P0 정책을
 * 격자로 돌리고, ISO 봉투(B1–B5)를 지키는 값 중 구성 목표(C1)를 가장 많이 달성하는 **가장 작은 값**을 고른다. 입력은 합성 격자.
 *
 *   node tools/sim/sweep.mjs --param adjacency.scale --values 0,0.5,1,1.5,2 --grid adj660,iso1224
 *   node tools/sim/sweep.mjs --param adjacency.scale --values 0,0.5,1,1.5,2 --param2 adjacency.half_double_fold --values2 false,true
 *   node tools/sim/sweep.mjs --param hold.order --values last_fixed_progress,last_fixed_smooth --grid iso1224
 *
 *   --param/--values    personalization.<경로> (접두어 생략 가능) 와 값 목록 (숫자·true/false·문자열)
 *   --param2/--values2  둘째 축(선택) — 곱으로 돈다
 *   --grid              adj660,iso1224 (기본 둘 다) · --grid-sample k: k 번째마다만(빠른 점검, 판정용 아님)
 *   --workers           워커 스레드 수 (기본 3) · --out 파일에도 쓰기(기본은 표준 출력만) · --date YYYYMMDD
 * 출력: 조합별 표 + 채택값 + 규칙 근거 문자열 초안([measured] …). 규칙 파일은 고치지 않는다(D7 값은 평가 담당이 옮긴다).
 * 봉투를 지키는 조합이 하나도 없으면 봉투를 완화하지 않고(§11) 어긋난 봉투 기준(B1–B5) 수가 가장 적은 조합 안에서 같은 순서로 고르고
 * "봉투 밖 — 팀 결정 필요"로 표시한다.
 */
import path from "node:path";
import { parseArgs, dateTag, loadDeps, writeFileSafe, ROOT } from "./lib_env.mjs";
import { makeShared } from "./lib_session.mjs";
import { runPool } from "./lib_pool.mjs";
import { isoSummary, adjSummary, envelopeOk, envelopeFails, compositionScore } from "./lib_grid.mjs";
import { CRIT } from "./lib_report.mjs";

const A = parseArgs();
if (!A.param || !A.values) {
  console.error("사용: node tools/sim/sweep.mjs --param adjacency.scale --values 0,0.5,1,1.5,2 [--param2 … --values2 …] [--grid adj660,iso1224]");
  process.exit(2);
}
const parseVal = (x) => (x === "true" ? true : x === "false" ? false : x !== "" && Number.isFinite(Number(x)) ? Number(x) : x);
const vals = (s) => String(s).split(",").map((x) => parseVal(x.trim()));
const axes = [{ param: String(A.param).replace(/^personalization\./, ""), values: vals(A.values) }];
if (A.param2 && A.values2) axes.push({ param: String(A.param2).replace(/^personalization\./, ""), values: vals(A.values2) });
const grids = String(A.grid ?? "adj660,iso1224").split(",").map((s) => s.trim()).filter((g) => g === "adj660" || g === "iso1224");
const stride = Math.max(1, Number(A["grid-sample"] ?? 1));
const tag = dateTag(A.date);
const log = (...x) => console.error(...x);

const deps = await loadDeps({ dataRepo: A["data-repo"] || null, needBaseline: true, needGrids: true });
if (!deps.personal) { console.error("engine/personal.js 가 없어 P0 정책을 만들 수 없습니다"); process.exit(1); }
for (const n of deps.notes) log(`[주의] ${n}`);
const shared = makeShared(deps);

/* 조합 = 축들의 곱. 첫 축의 현재 규칙 값도 표에 표시한다 */
const combos = [[]];
for (const ax of axes) { const next = []; for (const c of combos) for (const v of ax.values) next.push([...c, [ax.param, v]]); combos.splice(0, combos.length, ...next); }
const current = axes.map((ax) => { let o = deps.rules.personalization; for (const k of ax.param.split(".")) o = o == null ? undefined : o[k]; return o; });

const CHUNK = 102;
const jobs = [];
const sizes = Object.fromEntries(grids.map((g) => [g, deps.grids[g]({ tables: deps.tables76 }).length]));
combos.forEach((patch, ci) => { for (const g of grids) for (let from = 0; from < sizes[g]; from += CHUNK) jobs.push({ kind: "grid", grid: g, mode: "p0", from, to: Math.min(sizes[g], from + CHUNK), patch, stride, ci }); });
for (const g of grids) for (let from = 0; from < sizes[g]; from += CHUNK) jobs.push({ kind: "grid", grid: g, mode: "twin", from, to: Math.min(sizes[g], from + CHUNK), patch: null, stride, ci: -1 });

const got = new Map();   // `${ci}|${grid}` → [{from, runs}]
const t0 = performance.now();
let done = 0;
await runPool(jobs, {
  workers: Math.max(1, Number(A.workers ?? 3)), dataRepo: A["data-repo"] || null, needBaseline: true, inline: { deps, shared, twin: null },
  onResult: (job, res) => {
    const k = `${job.ci}|${job.grid}`;
    if (!got.has(k)) got.set(k, []);
    got.get(k).push({ from: job.from, runs: res.runs });
    if (++done % 10 === 0) log(`[${done}/${jobs.length}] ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  },
  onFail: (job, err) => { done++; log(`  실패 ${job.grid} ${job.from}: ${String(err).split(/\r?\n/)[0]}`); },
});
const runsOf = (ci, g) => (got.get(`${ci}|${g}`) || []).sort((a, b) => a.from - b.from).flatMap((c) => c.runs);

const rows = combos.map((patch, ci) => {
  const iso = grids.includes("iso1224") ? isoSummary(runsOf(ci, "iso1224")) : null;
  const adj = grids.includes("adj660") ? adjSummary(runsOf(ci, "adj660"), deps.cat.index.byId) : null;
  return { patch, iso, adj, env: iso ? envelopeOk(iso, CRIT) : null, score: adj ? compositionScore(adj, CRIT) : null };
});
const ref = { iso: grids.includes("iso1224") ? isoSummary(runsOf(-1, "iso1224")) : null, adj: grids.includes("adj660") ? adjSummary(runsOf(-1, "adj660"), deps.cat.index.byId) : null };

/* 채택: 봉투를 지키는 조합(iso 가 없으면 전부) 중 구성 점수 최대 → 첫 축 값이 가장 작은 것(숫자) → 입력 순서 (§4.8.2)
 * 봉투를 지키는 조합이 하나도 없으면(§11 "봉투는 완화하지 않는다 — 가장 좋은 점을 채택하고 차이를 보고") 어긋난 봉투 기준(B1–B5) 수가
 * 가장 적은 조합으로 좁힌 뒤 같은 순서로 고른다. 이때 채택값은 "봉투 밖 — 팀 결정 필요"로 표시한다 */
const byRule = (a, b) => (b.r.score ?? 0) - (a.r.score ?? 0)
  || (typeof a.r.patch[0][1] === "number" && typeof b.r.patch[0][1] === "number" ? a.r.patch[0][1] - b.r.patch[0][1] : 0) || a.i - b.i;
for (const r of rows) r.fails = r.iso ? envelopeFails(r.iso, CRIT) : [];
let cand = rows.map((r, i) => ({ r, i })).filter((x) => x.r.env !== false);
const outside = !cand.length && rows.length > 0;
if (outside) {
  const minFails = Math.min(...rows.map((r) => r.fails.length));
  cand = rows.map((r, i) => ({ r, i })).filter((x) => x.r.fails.length === minFails);
}
cand.sort(byRule);
const pick = cand.length ? cand[0].r : null;

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—"), f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "—");
const label = (patch) => patch.map(([p, v]) => `${p}=${v}`).join(" · ");
const line = (name, iso, adj, env, score, fails = []) =>
  `| ${name} | ${iso ? `${f3(iso.arr50)} / ${f3(iso.arr90)}` : "—"} | ${iso ? f3(iso.jump50) : "—"} | ${iso ? `${pct(iso.back)} / ${pct(iso.turns)} / ${pct(iso.zig)}` : "—"} | ${iso ? f3(iso.start50) : "—"} | ${iso ? `${pct(iso.sameEnd)} / ${f1(iso.holdDistinct)}` : "—"} | ${env === null ? "—" : env ? "✅" : `❌ ${fails.join("·")}`} | ${adj ? `${f1(adj.bpm50)} / ${f1(adj.bpm90)}` : "—"} | ${adj ? pct(adj.flip) : "—"} | ${adj ? pct(adj.flags2) : "—"} | ${adj ? adj.distinct : "—"} | ${score ?? "—"} |`;
const table = rows.map((r) => `${label(r.patch)} → ${r.adj ? `BPM 차 중앙 ${f1(r.adj.bpm50)}/90% ${f1(r.adj.bpm90)}·보컬↔연주 ${pct(r.adj.flip)}·2개 이상 ${pct(r.adj.flags2)}·곡 ${r.adj.distinct}·C ${r.score}` : ""}`
  + `${r.iso ? `${r.adj ? "·" : ""}도착 ${f3(r.iso.arr50)}/${f3(r.iso.arr90)}·최대 전환 ${f3(r.iso.jump50)}·꺾임 ${pct(r.iso.turns)}·같은 곡 끝 ${pct(r.iso.sameEnd)}·머묾 곡 ${f1(r.iso.holdDistinct)}${r.env ? "" : `(봉투 밖 ${r.fails.join("·")})`}` : ""}`).join("; ");
const refTxt = ref.adj || ref.iso ? ` 2.5.1 참고: ${ref.adj ? `BPM ${f1(ref.adj.bpm50)}/${f1(ref.adj.bpm90)}·보컬↔연주 ${pct(ref.adj.flip)}·2개 이상 ${pct(ref.adj.flags2)}·곡 ${ref.adj.distinct}` : ""}${ref.iso ? `${ref.adj ? "·" : ""}꺾임 ${pct(ref.iso.turns)}·같은 곡 끝 ${pct(ref.iso.sameEnd)}·머묾 곡 ${f1(ref.iso.holdDistinct)}` : ""}.` : "";
const head = `[measured] sweep_${tag}(합성 격자${grids.map((g) => ` ${g}`).join("·")}, 신규 사용자 P0${stride > 1 ? `, ${stride}번째마다 표본` : ""}): `;
const evidence = !pick ? "(조합 없음 — 팀 결정 필요)"
  : !outside ? head + table + `.${refTxt} 봉투(B1–B5)를 지키며 구성 목표(C1)를 가장 많이 달성한 가장 작은 값 ${label(pick.patch)} 채택.`
  : head + table + `.${refTxt} 봉투(B1–B5)를 모두 지키는 조합이 없다 — 봉투는 완화하지 않고(§11), 어긋난 봉투 기준이 가장 적은 조합(${pick.fails.join("·")} 만 불합격) 중 구성 목표(C1)를 가장 많이 달성한 가장 작은 값 ${label(pick.patch)} 채택. ${pick.fails.join("·")} 불합격은 팀 결정 필요.`;
const md = `# 규칙 스윕 — ${axes.map((a) => a.param).join(" × ")} (합성 격자)

> 생성 ${tag} · \`tools/sim/sweep.mjs\`. 신규 사용자 기본 정책(P0 = 빈 모델의 resolvePolicy)을 격자로 돌린 **합성 입력** 결과입니다.
> 현재 규칙 값: ${axes.map((a, i) => `${a.param} = ${JSON.stringify(current[i])}`).join(" · ")} · 엔진 ${deps.engine.ENGINE_VERSION} · 규칙 ${deps.rules.rules_version} · 카탈로그 ${deps.cat.index.n}곡
> 격자 ${grids.map((g) => `${g} ${sizes[g]}${stride > 1 ? `(${stride}번째마다)` : ""}`).join(" · ")}${deps.grids.fallback ? " (대체 격자)" : ""}

| 조합 | 도착 오차 중앙/90% | 최대 전환 중앙 | 역행/꺾임/지그재그 | 첫 곡 거리 | 같은 곡 끝/머묾 곡 | 봉투 | BPM 차 중앙/90% | 보컬↔연주 | 2개 이상 | 서로 다른 곡 | C 점수 |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.map((r) => line(label(r.patch), r.iso, r.adj, r.env, r.score, r.fails)).join("\n")}
${line("2.5.1 (참고)", ref.iso, ref.adj, null, null)}

- 봉투: 도착 중앙 ≤ ${CRIT.B1.med} · 90% ≤ ${CRIT.B1.grid_p90} · 최대 전환 중앙 ≤ ${CRIT.B2.grid_med} · 역행 ≤ 1.5% · 꺾임 ≤ 12% · 지그재그 0% · 첫 곡 ≤ ${CRIT.B4.med} · 같은 곡 끝 ≤ 35% · 머묾 곡 ≥ 12
- C 점수(0–4): BPM 차 중앙 ≤ ${CRIT.C1.bpm_med}·90% ≤ ${CRIT.C1.bpm_p90} / 보컬↔연주 ≤ 7% / 2개 이상 ≤ 28% / 서로 다른 곡 ≥ ${CRIT.C1.distinct}
- **채택: ${pick ? label(pick.patch) : "없음"}**${outside && pick ? ` — 봉투를 모두 지키는 조합이 없어 어긋난 봉투 기준이 가장 적은 조합(${pick.fails.join("·")} 불합격) 중에서 골랐다: **봉투 밖 — 팀 결정 필요**` : ""}

근거 문자열 초안 (\`personalization.*_evidence\` 에 옮긴다 — adjacency.scale·half_double_fold 는 평가 담당이 D7 결정으로 옮기고 rules_hash 를 다시 쓴다):

> ${evidence}
`;
console.log(md);
if (A.out) log(`→ ${path.relative(ROOT, writeFileSafe(A.out, md))}`);
