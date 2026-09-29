/*
 * 시뮬레이터 실행 + 수용 기준 보고서 (TOOLS · 명세 §9.3 · §11) — 모든 수치는 "합성 사용자" 기준.
 *
 *   node tools/sim/run.mjs --personas all --sessions 10 --reps 5 --arms wp,twin,frozen [--grid] [--json] [--date YYYYMMDD]
 *
 *   --personas  all | P0,P1,…  (P12 을 돌리면 내부 대조 P12F(전체 재생)를 wp 팔로 함께 돌린다 — D11)
 *   --sessions  반복마다 평가 세션 수 (P13 은 앞에 fix-web 형식 10세션이 더 붙는다)
 *   --reps      반복 수 (모수 회복 시험은 10)
 *   --arms      wp(학습) · twin(fix-web 76e8bdf 재현) · frozen(P0 정책 고정)
 *   --grid      신규 사용자 P0 정책과 2.5.1 을 iso1224(B)·adj660(C) 격자로도 잰다 (--grid-sample k: k 번째마다만 — 빠른 점검용)
 *   --h1-runs   결정성 시험 반복 수 (기본 100, 0 이면 건너뜀)
 *   --out       보고서 경로 (기본 docs/personal_eval_<date>.md), --json 이면 같은 이름 .json 도
 *   --external  run.mjs 밖에서 잰 기준 행 JSON(회귀 A1–A4 · 단위 시험 B7 · H2·H3 · check.mjs I · 수동 J) — 표에 함께 넣고 출처 명령을 적는다
 *   --workers   워커 스레드 수 (기본 3 — 워커당 메모리 약 200MB, 1 이면 같은 스레드)
 *   --wait-external N  --external 파일이 아직 없으면(external.mjs 를 동시에 돌리는 중) H5 측정 전에 최대 N분 기다린다
 *   --h5        H5 전용 성능 측정(bench_h5.mjs)을 워커가 끝난 뒤 한 스레드로 (기본 1, 0 이면 건너뜀 — 그러면 H5 는 불합격 처리)
 *               --h5-sessions(기록 세션, 기본 100) · --h5-contexts(입력 수, 기본 24) · --h5-profile(CPU 자기 시간 상위 함수)
 *               --h5-demo all|P1,…|0 (기본 all) — 판정 밖 B8 진단: 데모 프로필(demo/personas) 모델로 같은 입력의 안전 폴백 수(시간 측정 뒤)
 * 명세 §11 의 기준 ID 가운데 이 실행과 --external 이 모두 재지 못한 것은 "측정 안 됨"·불합격으로 표에 넣는다(평가 규칙 — 판정 불가도 불합격).
 *   --data-repo 데이터 저장소 경로 (기본 AZT_DATA_REPO 또는 ../eumchichi-data)
 * 세션 흐름은 앱과 같다(§2.2): RawFacts → normalizeLogs → buildPersonalModel → resolvePolicy(개인·p0) → 엔진 A·R → safetyCheck → recommendExtras → buildRecLog.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, dateTag, loadDeps, writeFileSafe, ROOT } from "./lib_env.mjs";
import { makeShared } from "./lib_session.mjs";
import { runPool } from "./lib_pool.mjs";
import { createTwin } from "./fixweb_twin.mjs";
import { PERSONAS, INTERNAL, SIM, BEHAVIOR } from "./personas.mjs";
import { isoSummary, adjSummary } from "./lib_grid.mjs";
import { evaluate, renderCriteria, personaTable, trajectoryTable, CRIT, SPEC_IDS } from "./lib_report.mjs";
import { benchH5 } from "./bench_h5.mjs";
import { execFileSync } from "node:child_process";

const A = parseArgs();
const tag = dateTag(A.date);
const sessions = Number(A.sessions ?? SIM.sessions), reps = Number(A.reps ?? SIM.reps);
let arms = String(A.arms ?? "wp,twin,frozen").split(",").map((s) => s.trim()).filter(Boolean);
const wantIds = !A.personas || A.personas === "all" ? PERSONAS.map((p) => p.id) : String(A.personas).split(",").map((s) => s.trim());
const h1Runs = Number(A["h1-runs"] ?? CRIT.H1.runs);
const log = (...x) => { if (!A.quiet) console.error(...x); };

const t0 = performance.now();
const RUN_START_MS = Date.now() - 1000;   // --wait-external: 이 시각 뒤에 쓰인 --external 파일만 "새 것"
const deps = await loadDeps({ dataRepo: A["data-repo"] || null, needBaseline: arms.includes("twin") || !!A.grid || wantIds.includes("P13"), needGrids: !!A.grid });
for (const n of deps.notes) log(`[주의] ${n}`);
if (!deps.personal) { arms = arms.filter((a) => a === "twin"); log("[주의] engine/personal.js 가 없어 twin 팔만 돌립니다"); }
const shared = makeShared(deps);
const twin = deps.baseline ? createTwin({ baseline: deps.baseline, catalogIndex: deps.cat.index, tables: deps.tables76 }) : null;
if (!twin) arms = arms.filter((a) => a !== "twin");

const personaList = wantIds.map((id) => PERSONAS.find((p) => p.id === id)).filter(Boolean);
const ids = personaList.map((p) => p.id);
if (wantIds.includes("P12") && arms.includes("wp")) ids.push(INTERNAL.P12F.id);   // D11 내부 대조(전체 재생)
const nWorkers = Math.max(1, Number(A.workers ?? 3));
const h4Total = 80;
const jobs = [];
for (const id of ids) for (let rep = 0; rep < reps; rep++)
  jobs.push({ kind: "persona", id, rep, arms: id === "P12F" ? arms.filter((a) => a === "wp") : arms, sessions,
              h4budget: Math.ceil(h4Total / Math.max(1, ids.length * reps)), wantH1: id === (ids.includes("P1") ? "P1" : ids[0]) && rep === 0 });
/* 격자는 조각으로 나눠 같은 워커 풀에 — 신규 사용자 P0 정책과 2.5.1 */
const GRID_CHUNK = 102;
const gridStride = Math.max(1, Number(A["grid-sample"] ?? 1));   // 1 = 전체. 빠른 점검 때만 k 번째마다
const gridN = {};
if (A.grid && deps.personal && deps.baseline) for (const g of ["iso1224", "adj660"]) {
  const n = deps.grids[g]({ tables: deps.tables76 }).length;
  gridN[g] = n;
  for (const mode of ["p0", "twin"]) for (let from = 0; from < n; from += GRID_CHUNK) jobs.push({ kind: "grid", grid: g, mode, from, to: Math.min(n, from + GRID_CHUNK), patch: null, stride: gridStride });
}

const R = [], F = [], h4 = { cases: [] }, gridRuns = { iso1224: { p0: [], twin: [] }, adj660: { p0: [], twin: [] } };
let h1Sample = null, fillsTotal = 0;
const errorsAll = [];
const tj = performance.now();
let done = 0;
await runPool(jobs, {
  workers: nWorkers, dataRepo: A["data-repo"] || null, needBaseline: !!twin, inline: { deps, shared, twin },
  onResult: (job, res) => {
    done++;
    if (job.kind === "grid") {
      gridRuns[job.grid][job.mode].push({ from: job.from, runs: res.runs });
      if (done % 5 === 0) log(`[${done}/${jobs.length}] 격자 ${job.grid} ${job.mode} ${job.from}… · 누적 ${((performance.now() - tj) / 1000).toFixed(0)}s`);
      return;
    }
    R.push(...res.records); F.push(...res.finals); h4.cases.push(...res.h4cases); fillsTotal += res.fills;
    if (res.h1) h1Sample = res.h1;
    for (const e of res.errors) { errorsAll.push(e); if (errorsAll.length <= 5) log(`  오류 ${e}`); }
    log(`[${done}/${jobs.length}] ${job.id} r${job.rep} · 누적 ${((performance.now() - tj) / 1000).toFixed(0)}s`);
  },
  onFail: (job, err) => { done++; const lines = String(err).split(/\r?\n/); errorsAll.push(`${job.id || job.grid} r${job.rep ?? job.from}: ${lines[0]}`); log(`  작업 실패 ${job.id || job.grid}: ${lines.slice(0, 3).join(" | ")}`); },
});
/* 워커마다 결과가 도착한 순서가 달라도 보고서가 같게 — 정렬 */
const armOrder = { legacy: 0, wp: 1, frozen: 2, twin: 3 };
const byId = (x, y) => (x.persona < y.persona ? -1 : x.persona > y.persona ? 1 : 0);
R.sort((x, y) => byId(x, y) || x.rep - y.rep || armOrder[x.arm] - armOrder[y.arm] || x.k - y.k);
F.sort((x, y) => byId(x, y) || x.rep - y.rep);
h4.cases.sort((x, y) => (x.persona < y.persona ? -1 : x.persona > y.persona ? 1 : 0));

/* H1 결정성: 같은 RawFacts·as_of·ctx·시드로 100회 — 모델 digest·정책 digest·시퀀스 */
let h1 = null;
if (h1Sample && h1Runs > 0) {
  const { personal, engine, rules, cat } = deps;
  const seen = new Set();
  const ctx = { now: { v: 0.3, e: 0.72 }, target: { v: 0.6, e: 0.3 }, now_table: { v: 0.3, e: 0.72 }, target_table: { v: 0.6, e: 0.3 },
                labels: { current: { mode: "chip", chip: "불안해요" }, target: { mode: "chip", chip: "차분해지고 싶어요" } }, nudged: { current: false, target: false },
                minutes: 30, lyric: "no_preference", genres: [], pace_user: null, seed: "h1:determinism", global_stats: {}, disliked_now: [], session_no: 99 };
  for (let i = 0; i < h1Runs; i++) {
    const raw = JSON.parse(JSON.stringify(h1Sample.raw));
    const model = personal.buildPersonalModel(personal.normalizeLogs(raw, cat.index, rules), cat.index, rules, { as_of_ms: h1Sample.at });
    const out = personal.resolvePolicy(model, { ...ctx, disliked_now: [...raw.profile.dislikedSongs] }, rules);
    const res = engine.recommend(shared.contract, rules, { now: { V: 0.3, A: 0.72 }, target: { V: 0.6, A: 0.3 }, stress: 3, load: null, genres: [], duration_min: 30,
                                                           seed: ctx.seed, gates: [], user: out.user, pace: null, personal: out.policy });
    seen.add(`${model.digest}|${out.policy && out.policy.digest}|${res.sequence.map((r) => r.song_id).join(",")}`);
  }
  h1 = { runs: h1Runs, distinct: seen.size, persona: h1Sample.persona };
  log(`H1 ${h1Runs}회 → ${seen.size}가지`);
}

/* 격자 */
let grid = null;
if (Object.keys(gridN).length) {
  const flat = (g, mode) => gridRuns[g][mode].sort((x, y) => x.from - y.from).flatMap((c) => c.runs);
  const isoP0 = flat("iso1224", "p0"), isoTw = flat("iso1224", "twin");
  /* B6g: 신규 사용자 P0 정책(경로 모수 = 표 tp · s 0)과 2.5.1 의 경유지가 같은가 — 같은 시나리오끼리 */
  const twKey = new Map(isoTw.map((x) => [`${x.sc.now_label}|${x.sc.goal_label}|${x.sc.minutes}|${x.sc.seed}`, x.wpkey]));
  const b6pairs = isoP0.map((x) => [x.wpkey, twKey.get(`${x.sc.now_label}|${x.sc.goal_label}|${x.sc.minutes}|${x.sc.seed}`)]).filter(([a, b]) => a != null && b != null);
  grid = {
    iso: { p0: isoSummary(isoP0), twin: isoSummary(isoTw), n: gridN.iso1224, b6: { n: b6pairs.length, same: b6pairs.filter(([a, b]) => a === b).length } },
    adj: { p0: adjSummary(flat("adj660", "p0"), deps.cat.index.byId), twin: adjSummary(flat("adj660", "twin"), deps.cat.index.byId), n: gridN.adj660 },
    fallback: !!deps.grids.fallback,
  };
}

/* --external 파일을 다른 프로세스(external.mjs)가 동시에 만드는 중이면 끝날 때까지 기다린다(--wait-external 분) —
 * external.mjs 는 모든 측정이 끝난 뒤 파일을 쓰므로, 파일이 생기면 기계가 조용해진 것이다(H5 를 경합 없이 재려고) */
/* 이전 실행이 남긴 같은 이름 파일(이 실행 시작 전 시각)은 없는 것으로 본다 — 다시 재는 중이면 새 파일을 기다린다 */
const extFresh = () => { try { return fs.statSync(path.resolve(String(A.external))).mtimeMs >= RUN_START_MS; } catch (e) { return false; } };
if (A.external && A["wait-external"] && !extFresh()) {
  const until = performance.now() + Number(A["wait-external"]) * 60000;
  log(`--external ${A.external} 을 기다립니다 (최대 ${A["wait-external"]}분 — 이 실행 시작 뒤에 쓰인 파일만)`);
  while (!extFresh() && performance.now() < until) await new Promise((r) => setTimeout(r, 5000));
  if (!extFresh()) log(`[주의] --external ${A.external} 이 이 실행 뒤에 새로 쓰이지 않았습니다 — 있는 파일을 그대로 읽습니다`);
}
/* H5 전용 측정 — 워커가 모두 끝난 뒤 이 스레드 하나로(경합 없이), 추천 100·이벤트 1,200 합성 기록 */
let h5 = null;
if (Number(A.h5 ?? 1) !== 0 && deps.personal) {
  const d5 = deps.grids ? deps : { ...deps, grids: (await loadDeps({ dataRepo: A["data-repo"] || null, needBaseline: false, needGrids: true })).grids };
  const opts = { profile: !!A["h5-profile"] };
  if (A["h5-sessions"] != null) opts.history_sessions = Number(A["h5-sessions"]);
  if (A["h5-contexts"] != null) opts.contexts = Number(A["h5-contexts"]);
  opts.demo = A["h5-demo"] != null ? (String(A["h5-demo"]) === "0" ? null : String(A["h5-demo"])) : "all";   // B8 진단(판정 밖): 데모 프로필 폴백 — 시간 측정 뒤
  try { h5 = await benchH5({ deps: d5, shared, twin, opts, log }); }
  catch (e) { h5 = { error: String(e && e.message || e) }; log(`[H5] 실패 ${h5.error}`); }
}

// ── 보고서 ──
const { results } = evaluate(R, F, { grid, h1, h4, h5 }, deps.rules);
/* run.mjs 밖에서 잰 기준(회귀 A1–A4 · 단위 시험 B7 · 재현 H2·H3 · 정적 검사 I · 앱 수동 J) — --external <json>
 * 모양: { rows: [{ id, group, title, target, value, pass(true|false|null), source(실행한 명령), note? }] }. 값은 그 명령의 출력 그대로 옮긴다 */
let extSrc = null;
if (A.external) {
  const ext = JSON.parse(fs.readFileSync(path.resolve(String(A.external)), "utf8"));
  extSrc = ext.generated || null;
  for (const r of ext.rows || []) results.push({ id: r.id, group: r.group, title: r.title, target: r.target, value: r.value, pass: r.pass ?? null,
                                                note: [r.note, r.source ? `외부 측정: \`${r.source}\`` : null].filter(Boolean).join(" · ") });
  const G = "ABCDEFGHIJ", num = (id) => { const m = /^[A-Z](\d+)/.exec(id); return m ? Number(m[1]) : 0; };
  const order = results.map((r, i) => ({ r, i }));
  order.sort((x, y) => G.indexOf(x.r.group) - G.indexOf(y.r.group) || num(x.r.id) - num(y.r.id) || x.i - y.i);
  results.splice(0, results.length, ...order.map((x) => x.r));
}
let extNotes = [];
if (A.external) { const ext = JSON.parse(fs.readFileSync(path.resolve(String(A.external)), "utf8")); extNotes = ext.notes || []; }
/* 명세 §11 기준 ID 전부가 표에 있게 — 이 실행·--external 모두 재지 못한 기준은 "측정 안 됨"·불합격, 판정 불가(null)도 불합격 */
const have = new Set(results.map((r) => r.id));
let nUnmeasured = 0;
for (const s of SPEC_IDS) if (!have.has(s.id)) {
  nUnmeasured++;
  results.push({ id: s.id, group: s.group, title: s.title, target: s.target, value: "측정 안 됨", pass: false,
                 note: s.how ? `이 실행에서 재지 않음 — ${s.how}` : "이 실행에서 재지 않음" });
}
for (const r of results) if (r.pass !== true && r.pass !== false) {
  r.pass = false; nUnmeasured++;
  r.note = [r.note, "판정 불가(자료 없음) → 불합격 처리"].filter(Boolean).join(" · ");
}
{
  const G = "ABCDEFGHIJ", num = (id) => { const m = /^[A-Z](\d+)/.exec(id); return m ? Number(m[1]) : 0; };
  const order = results.map((r, i) => ({ r, i }));
  order.sort((x, y) => G.indexOf(x.r.group) - G.indexOf(y.r.group) || num(x.r.id) - num(y.r.id) || x.i - y.i);
  results.splice(0, results.length, ...order.map((x) => x.r));
}
const head = (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch (e) { return "?"; } })();
const dirty = (() => { try { return execFileSync("git", ["-C", ROOT, "status", "--short"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean).length; } catch (e) { return null; } })();
const nPass = results.filter((r) => r.pass === true).length, nFail = results.filter((r) => r.pass === false).length;
/* 측정 안 됨 = 위에서 채운 행 + 값·주석에 "측정 안 됨" 이 있는 불합격 행(외부 행 · 자극이 없어 시험되지 않은 D7 등) */
nUnmeasured = results.filter((r) => r.pass === false && (/^측정 안 됨/.test(String(r.value)) || /측정 안 됨|판정 불가/.test(String(r.note || "")))).length;
const errRows = R.filter((r) => r.error);
const firstErrs = [...new Set(errRows.map((r) => r.error.split(" | ")[0]))].slice(0, 5);
const md = `# web-personal 개인화 평가 — 합성 사용자

> 생성 ${tag} · \`tools/sim/run.mjs\` 가 만든 파일입니다. 손으로 고치지 말고 다시 돌리세요.
> **모든 수치는 합성 사용자(시뮬레이터 페르소나, 명세 §9.4) 기준입니다.** 실제 효과는 로그가 쌓인 뒤 5단계(재생 평가)에서 잽니다.
> 시뮬레이터는 개인화의 **기제**가 설계대로 움직이는지를 보일 뿐, 실제 사용자에게서의 효과를 뜻하지 않습니다.

## 실행 조건

- 저장소 \`${head}\`${dirty ? ` (+ 커밋 안 된 변경 ${dirty}개 파일)` : ""} · 엔진 ${deps.engine.ENGINE_VERSION} · 규칙 ${deps.rules.rules_version} (\`${deps.rules.rules_hash}\`) · personal ${deps.personal ? deps.personal.PERSONAL_VERSION ?? "?" : "없음"}
- 쌍둥이(twin): fix-web \`76e8bdf\` 엔진 ${deps.baseline ? deps.baseline.engine.ENGINE_VERSION : "—"} · 규칙 ${deps.baseline ? deps.baseline.rules.rules_version : "—"} + 앱 규칙(buildHeardItems 2.5.0 암묵 표 · 로컬 최근 60 · PACE_TP 사본 · 옛 더 들을 곡)
- 카탈로그 ${deps.cat.index.n}곡 · digest \`${deps.cat.index.digest}\` (데이터 ${deps.cat.source.ref} ${String(deps.cat.source.sha || "").slice(0, 7)})
- 페르소나 ${personaList.map((p) => p.id).join(" · ")}${wantIds.includes("P12") && arms.includes("wp") ? " (+ 내부 대조 P12F)" : ""} · 반복 ${reps} · 세션 ${sessions} · 팔 ${arms.join(" · ")}${A.grid ? ` · 격자 iso1224 ${grid ? grid.iso.p0.n : "—"} / adj660 ${grid ? grid.adj.p0.n : "—"}${gridStride > 1 ? ` (**${gridStride}번째마다 표본 — 수용 판정용 아님**)` : ""}${grid && grid.fallback ? " (대체 격자)" : ""}` : ""}
- 세션 기록 ${R.length}개 (오류 ${errRows.length}, 작업 오류 ${errorsAll.length}) · 워커 ${nWorkers} · 실행 ${((performance.now() - t0) / 1000).toFixed(0)}초
- buildRecLog 결과에 빠져 시뮬레이터가 채운 필드 ${fillsTotal}개${fillsTotal ? " — personal.js 구현이 덜 됐거나 명세 §7.1 필드가 빠짐(값은 덮지 않고 빈 곳만 채움)" : ""}
- 팔: **wp** = web-personal 학습 · **twin** = fix-web 재현 · **frozen** = web-personal 정책을 P0(학습값 없이 모집단 기본 + 싫어요·최근 창)으로 고정
${extSrc ? `- run.mjs 밖에서 잰 기준(--external): ${extSrc} — 표의 각 행에 실행한 명령을 적었다\n` : ""}${extNotes.map((n) => `- ${n}`).join("\n")}${extNotes.length ? "\n" : ""}${h5 && !h5.error ? `- H5 전용 측정: ${h5.machine.cpus} · Node ${h5.machine.node} · 워커가 끝난 뒤 한 스레드 · 합성 기록 ${h5.history.persona} ${h5.history.sessions}세션(추천 ${h5.history.recs_window} · 이벤트 ${h5.history.events_window}) · 입력 ${h5.contexts}개\n` : ""}${deps.notes.length ? deps.notes.map((n) => `- 주의: ${n}`).join("\n") + "\n" : ""}${firstErrs.length ? firstErrs.map((e) => `- 오류 예: \`${e.slice(0, 300)}\``).join("\n") + "\n" : ""}
## 수용 기준 (§11) — 합격 ${nPass} · 불합격 ${nFail} (그중 측정 안 됨·판정 불가 ${nUnmeasured})

기준을 조용히 바꾸지 않는다(§11). 불합격 항목은 아래 값 그대로 팀 결정에 올린다.

${renderCriteria(results)}

## 페르소나 × 팔 요약 (6~10세션, 합성 사용자)

${personaTable(R)}

## 학습 궤적 (wp 팔, 세션별 반복 평균, 합성 사용자)

${["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P9", "P10"].filter((id) => wantIds.includes(id)).map((id) => `### ${id} ${PERSONAS.find((p) => p.id === id).name}\n\n${trajectoryTable(R, id)}`).join("\n\n")}

${grid ? `## 격자 상세 (신규 사용자 P0 정책 vs 2.5.1, 합성 입력)

| 지표 | P0 | 2.5.1 |
|---|---|---|
| 도착 오차 중앙 / 90% | ${grid.iso.p0.arr50.toFixed(3)} / ${grid.iso.p0.arr90.toFixed(3)} | ${grid.iso.twin.arr50.toFixed(3)} / ${grid.iso.twin.arr90.toFixed(3)} |
| 최대 전환 중앙 / 90% | ${grid.iso.p0.jump50.toFixed(3)} / ${grid.iso.p0.jump90.toFixed(3)} | ${grid.iso.twin.jump50.toFixed(3)} / ${grid.iso.twin.jump90.toFixed(3)} |
| 머묾 구간 꺾임 세션 | ${(grid.iso.p0.holdTurns * 100).toFixed(1)}% | ${(grid.iso.twin.holdTurns * 100).toFixed(1)}% |
| 목표 칩별 서로 다른 머묾 곡 | ${Object.entries(grid.iso.p0.holdDistinctByGoal).map(([g, n]) => `${g} ${n}`).join(" · ")} | ${Object.entries(grid.iso.twin.holdDistinctByGoal).map(([g, n]) => `${g} ${n}`).join(" · ")} |
| 인접 쌍 수 | ${grid.adj.p0.pairs} | ${grid.adj.twin.pairs} |
` : ""}
## 관찰 (자동 집계, 합성 사용자)

- 이탈 가드(quit_frac · quit_song)가 켜진 wp 세션: ${(() => { const ids = [...new Set(R.filter((r) => r.arm === "wp" && !r.error && r.ks != null).map((r) => r.persona))]; return ids.map((id) => { const rows = R.filter((r) => r.arm === "wp" && r.persona === id && !r.error && r.ks != null); const n = rows.filter((r) => r.policy && (r.policy.quit_frac != null || r.policy.quit_song != null)).length; return n ? `${id} ${n}/${rows.length}` : null; }).filter(Boolean).join(" · ") || "없음"; })()}
  — P13 은 옛 기록(fix-web)에서 끝까지 듣지 않은 마지막 곡이 저장되지 않아(B11) 도달 비율이 (n−1)/n 로 읽히고, 그것만으로 가드가 켜질 수 있다(P9 는 의도한 자극).
- 안전 폴백: ${(() => { const rows = R.filter((r) => r.arm === "wp" && r.fallback); const v = {}; for (const r of rows) for (const x of r.safety_violations || []) v[x] = (v[x] || 0) + 1; return rows.length ? `${rows.length}세션 — 위반 ${Object.entries(v).map(([k, n]) => `${k} ${n}`).join(" · ")}` : "없음"; })()}

## 시뮬레이터 가정 (명세가 정하지 않아 여기서 정한 것)

- 행동 모형 숫자는 \`tools/sim/personas.mjs\` 한 곳(BEHAVIOR). [보충] 표시 값: 조기 넘김 곡은 상태를 움직이지 않음(${BEHAVIOR.state_min_completion}), 완주 판정 ${BEHAVIOR.complete_at},
  조기 넘김 때 들은 비율 U(${BEHAVIOR.skip_c.join(", ")}), mood_mismatch 조건(첫 곡이 실제 상태에서 ${BEHAVIOR.mood_mismatch_dist} 넘게) · arrival_mismatch 조건(마지막 곡이 참목표에서 ${BEHAVIOR.arrival_mismatch_dist} 넘게),
  속도 답은 「듣고 난 뒤」 제출(${BEHAVIOR.post_p})과 독립으로 ${BEHAVIOR.pace_answer_p}, 세션 간격 하한 ${SIM.min_gap_h}시간, 습관 단어 3개는 페르소나별로 이 파일에서 정함.
- fix-web 쌍둥이의 P7 은 끌기가 없어 화살표(0.05 칸)로 같은 조건에서 옮긴다. 더 들을 곡은 fix-web 에서 재생 큐 밖이라 쌍둥이는 경로 곡만 듣는다.
- 한 세션의 이유 코드 위치는 \`note_ai.positions\` 한 목록에 모은다(코드별 위치를 가르지 않음 — 앱의 AI 분류 모양).
- frozen 팔: "모델을 늘 빈 모델로(P0 고정)"를 기준 실행 R 과 같은 정책(resolvePolicy mode "p0" — 학습값 없이 모집단 기본 + 싫어요·최근 창 60)으로 읽었다.
  완전한 빈 모델이면 최근 창도 비어 같은 곡이 세션마다 되풀이되므로 "학습 몫"(E5) 비교가 흐려진다. 좌표 보정·감상 시간 제안도 frozen 에서는 쓰지 않는다.
- P11 의 "답·코드 무작위" = 응답한 세션에서 이유 코드마다 10% 로 고름(위치 무작위), 속도 답은 세 값 균등. P12F(D11 대조)는 P12 와 같은 난수 키를 쓴다.
- 안전 폴백 A′ 는 resolvePolicy(mode "geometry"), 기록은 buildRecLog({ usedOut, refOut }) — 앱과 같은 순서(§2.2 7).
- 지표(E·D5 등)는 두 앱이 모두 재생하는 **경로 곡**으로 잰다. E[change] 는 잡음 N(0, ${BEHAVIOR.change_sd}) 을 적분한 기대값.
- H2(Node vs 브라우저)·H3(replay.mjs)는 이 실행이 재지 않는다 — \`demo_personas.mjs --fixtures\` 픽스처와 \`replay.mjs\` 로 확인하고, 잰 값은 --external 로 표에 넣는다.
`;
/* .json 은 세션 기록의 요약만(곡 목록·곡별 배열·모델 보정 표는 뺀다 — 저장소에 올릴 크기로) */
function slimRecord(r) {
  const o = { ...r };
  for (const k of ["path_ids", "ref_ids", "comp_path", "fin", "params"]) delete o[k];
  if (r.pairs) o.pairs = { n: r.pairs.n, flips: r.pairs.flips, flags2: r.pairs.flags2 };
  if (r.shape) o.shape = { ...r.shape, hold_ids: undefined, last_id: undefined };
  if (r.comp_path) o.comp_mean = r.comp_path.length ? r.comp_path.reduce((a, b) => a + b, 0) / r.comp_path.length : null;
  if (r.model) o.model = { ...r.model, calib: undefined };
  return o;
}
const outPath = A.out || path.join("docs", `personal_eval_${tag}.md`);
const f = writeFileSafe(outPath, md);
log(`→ ${path.relative(ROOT, f)} (합격 ${nPass} · 불합격 ${nFail})`);
if (A.json) {
  const j = writeFileSafe(outPath.replace(/\.md$/, ".json"), JSON.stringify({ generated: tag, synthetic: "합성 사용자", results, grid, h1, h5, h4: { n: h4.cases.length, changed: h4.cases.filter((c) => c.changed).length },
    records: R.map(slimRecord), final: F }, (k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e5) / 1e5 : v)));
  log(`→ ${path.relative(ROOT, j)}`);
}
