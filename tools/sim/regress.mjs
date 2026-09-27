/*
 * 회귀·호환 검사 (TOOLS · 명세 §1 I0·I1 · §11 A1–A4) — 병합 전 필수.
 *
 * 기준 = 이 저장소 76e8bdf 의 engine.js(2.5.1) + rules(v2.4.0) — git show → 임시 import → 삭제(baseline.mjs)
 * 대상 = 작업 트리의 engine/engine.js(2.6.0-wp) + rules/rules.compiled.json(v2.5.0-wp) + engine/personal.js
 * 카탈로그 = 데이터 저장소 origin/master 의 4,117곡(catalog.mjs, 메모리만). 두 엔진에 **같은 곡 객체**를 넣는다.
 *
 * 검사 (--check, 쉼표로 여러 개 · all)
 *   i0        personal 없음(undefined) · personal: null — 출력 JSON 이 기준과 같다.
 *             비교에서 빼는 것은 engine_version · rules_version · rules_hash(최상위와 각 행 trace.rules_hash) 뿐 (A1)
 *   i0off     rules.personalization.enabled = false 인 규칙 사본 + 실제 정책(P0 — 없으면 중립)을 넣어도 기준과 같다 (I0 스위치, I11)
 *   pace      inputs.pace = fast/slow  vs  기준 엔진에 "전환점을 [{up_to:999, at}] 로 바꾼 규칙 사본"(76e8bdf 앱 PACE_TP) (A2)
 *   i1        personal = personal.neutralPolicy(rules) — 곡 순서 · 2.5.1 trace 키 값 · 기존 설명 문구가 같고, 새 trace 키는 p_* 만 (A3)
 *   affinity  aggregateAffinity(items, rules) 2인자 — 무작위 항목 집합 200 + 탐침 기록, 그리고 특징 묶음(makeFeatureBinner) 동일 (A4)
 * 격자 (--grid, 쉼표로 여러 개 · all): iso1224 · adj660 · probe (grids.mjs)
 * 시나리오마다 엔진이 inputs·rules 객체를 바꾸지 않았는지도 본다(순수 함수 — 바꾸면 다음 실행이 오염된다).
 *
 * 불일치 1건이라도 있으면 그 자리에서 멈추고 첫 차이를 출력한 뒤 exit 1. 검사를 돌릴 수 없으면(export·파일 없음) exit 2.
 *
 * 실행 (저장소 루트에서):
 *   node tools/sim/regress.mjs --grid all --check all
 *   node tools/sim/regress.mjs --grid iso1224 --check i0 --limit 100     (빠른 확인: 격자마다 앞 100개)
 *   옵션: --workers N (기본 코어 수 − 2, 1 이면 한 스레드) · --every K (K 개마다 1개) · --data-repo <경로> · --catalog-ref <ref> · --baseline <ref>
 * 엔진 1회 ≈ 130ms(4,117곡). all × all 은 시나리오 1,959개 × 엔진 9회라 한 스레드로 약 40분 — 기본은 여러 스레드로 나눠 돈다.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { DATA_REPO, loadCatalog } from "./catalog.mjs";
import { BASELINE_REF, loadBaseline, loadCurrent, missingExports } from "./baseline.mjs";
import { loadAppTablesAt } from "./app_tables.mjs";
import { GRID_NAMES, applyRulesPatch, gridByName } from "./grids.mjs";

const SCENARIO_CHECKS = ["i0", "i0off", "pace", "i1"];
const ALL_CHECKS = [...SCENARIO_CHECKS, "affinity"];

// ── 인자 ────────────────────────────────────────────────
export function parseArgs(argv) {
  const a = { grid: "all", check: "all", workers: null, limit: null, every: 1, "data-repo": DATA_REPO, "catalog-ref": "origin/master", baseline: BASELINE_REF, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (k === "quiet") { a.quiet = true; continue; }
    if (!(k in a)) throw new Error(`모르는 인자: ${argv[i]}`);
    a[k] = argv[++i];
  }
  const list = (v, all, name) => {
    const xs = String(v).split(",").map((s) => s.trim()).filter(Boolean);
    const out = xs.includes("all") ? [...all] : xs;
    for (const x of out) if (!all.includes(x)) throw new Error(`모르는 ${name}: ${x} (${all.join(" | ")} | all)`);
    return out;
  };
  return {
    grids: list(a.grid, GRID_NAMES, "격자"), checks: list(a.check, ALL_CHECKS, "검사"), checksAll: String(a.check).split(",").includes("all"),
    workers: a.workers == null ? Math.max(1, Math.min(6, os.availableParallelism() - 2)) : Math.max(1, Number(a.workers) || 1),
    limit: a.limit == null ? null : Number(a.limit), every: Math.max(1, Number(a.every) || 1),
    dataRepo: a["data-repo"], catalogRef: a["catalog-ref"], baseline: a.baseline, quiet: a.quiet,
  };
}

// ── 비교 ────────────────────────────────────────────────
/* I0 비교에서 빼는 필드: engine_version · rules_version · rules_hash(최상위, 각 행 trace.rules_hash). 나머지는 그대로 */
export function stripVersions(res) {
  const o = JSON.parse(JSON.stringify(res));
  delete o.engine_version; delete o.rules_version; delete o.rules_hash;
  for (const row of o.sequence || []) if (row && row.trace) delete row.trace.rules_hash;
  return o;
}
/* 첫 차이의 경로와 두 값. 구조가 같은데 JSON 문자열만 다르면(키 순서) 그 사실을 알린다 */
export function firstDiff(a, b, p = "$") {
  if (Object.is(a, b)) return null;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a, tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb || ta !== "object" && ta !== "array") return { path: p, a, b };
  if (ta === "array") {
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = firstDiff(a[i], b[i], `${p}[${i}]`); if (d) return d; }
    return null;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    if (!(k in a)) return { path: `${p}.${k}`, a: "(없음)", b: b[k] };
    if (!(k in b)) return { path: `${p}.${k}`, a: a[k], b: "(없음)" };
    const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d;
  }
  const ka = Object.keys(a).join(","), kb = Object.keys(b).join(",");
  return ka !== kb ? { path: p, a: `키 순서 ${ka}`, b: `키 순서 ${kb}`, keyOrderOnly: true } : null;
}
const ids = (res) => (res && res.sequence ? res.sequence.map((r) => r.song_id) : []);
function sameJson(r0, r1) {
  const a = stripVersions(r0), b = stripVersions(r1);
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  return firstDiff(a, b) || { path: "$", a: "(JSON 문자열만 다름)", b: "" };
}
/* I1: 곡 순서 · 2.5.1 trace 키 값(rules_hash 제외) · 기존 설명이 같고, 새 trace 키는 p_* 만 */
function sameUnderNeutral(r0, rn) {
  const A = r0.sequence || [], B = rn.sequence || [];
  if (A.length !== B.length || A.some((r, i) => r.song_id !== B[i].song_id)) return { path: "$.sequence[*].song_id", a: ids(r0), b: ids(rn) };
  for (const k of ["song_count", "baselines", "genre_restricted", "relaxed_steps"]) {
    const d = firstDiff(r0[k], rn[k], `$.${k}`); if (d) return d;
  }
  for (let i = 0; i < A.length; i++) {
    const ta = A[i].trace || {}, tb = B[i].trace || {};
    for (const k of Object.keys(ta)) {
      if (k === "rules_hash") continue;
      const d = firstDiff(ta[k], tb[k], `$.sequence[${i}].trace.${k}`); if (d) return d;
    }
    for (const k of Object.keys(tb)) if (!(k in ta) && !k.startsWith("p_")) return { path: `$.sequence[${i}].trace.${k}`, a: "(없음)", b: tb[k], note: "새 trace 키는 p_* 만 허용" };
    /* 기존 설명 문구는 순서를 지킨 채 모두 남아 있어야 한다(새 p_* 설명은 끼어들어도 됨) */
    const ea = A[i].explanations || [], eb = B[i].explanations || [];
    let j = 0; for (const e of eb) if (j < ea.length && e === ea[j]) j++;
    if (j < ea.length) return { path: `$.sequence[${i}].explanations`, a: ea, b: eb };
  }
  return null;
}

// ── 준비 ────────────────────────────────────────────────
async function setup(opts, { needScenarios = true } = {}) {
  const B = await loadBaseline(opts.baseline);
  const C = await loadCurrent();
  if (!C.engine) throw Object.assign(new Error(`engine/engine.js import 실패: ${C.errors.engine && C.errors.engine.message}`), { setup: true });
  if (!C.rules) throw Object.assign(new Error(`rules/rules.compiled.json 읽기 실패: ${C.errors.rules && C.errors.rules.message}`), { setup: true });
  const tables = loadAppTablesAt(opts.baseline);
  /* 카탈로그 특징 묶음·작업 좌표는 대상 엔진·규칙으로 만든다(앱이 쓰는 쪽). 기준 엔진과 묶음이 같은지는 affinity 검사가 본다 */
  const { songs, index } = loadCatalog({ dataRepo: opts.dataRepo, ref: opts.catalogRef, engine: C.engine, rules: C.rules, quiet: true });
  const scenarios = {};
  if (needScenarios) for (const g of opts.grids) {
    let list = gridByName(g, { songs, engine: B.engine, rules: B.rules });
    if (opts.every > 1) list = list.filter((_, i) => i % opts.every === 0);
    if (opts.limit != null) list = list.slice(0, opts.limit);
    scenarios[g] = list;
  }
  return { B, C, tables, songs, index, scenarios };
}

/* 검사 가능 여부 — 없는 export 는 검사 이름별로 모은다 */
function capability(ctx) {
  const P = ctx.C.personal, R1 = ctx.C.rules;
  const can = { i0: true, pace: true, i1: !!(P && typeof P.neutralPolicy === "function"),
                i0off: !!(P && (typeof P.neutralPolicy === "function" || typeof P.resolvePolicy === "function")),
                affinity: typeof ctx.C.engine.aggregateAffinity === "function" };
  const why = {};
  const noP = `engine/personal.js 를 불러오지 못했습니다 (${ctx.C.errors.personal && ctx.C.errors.personal.message})`;
  if (!can.i1) why.i1 = P ? "engine/personal.js 에 neutralPolicy export 가 없습니다" : noP;
  if (!can.i0off) why.i0off = P ? "engine/personal.js 에 resolvePolicy·neutralPolicy 가 없어 넣을 정책이 없습니다" : noP;
  if (!ctx.tables.PACE_TP) { can.pace = false; why.pace = `기준 앱(${ctx.B.ref}:index.html)에서 PACE_TP 를 찾지 못했습니다`; }
  if (!can.affinity) why.affinity = "engine.js 에 aggregateAffinity 가 없습니다";
  if (!R1.personalization) why.i0off_note = "규칙에 personalization 절이 아직 없음 — enabled 끔 사본으로만 확인";
  return { can, why };
}

/* i0off 에 넣을 정책: P0(빈 모델의 resolvePolicy p0) → 없으면 neutralPolicy → 둘 다 없으면 null(건너뜀) */
function offPolicy(ctx, sc, rules) {
  const P = ctx.C.personal;
  if (!P) return null;
  const m = sc.meta || {};
  try {
    if (typeof P.resolvePolicy === "function" && typeof P.emptyModel === "function") {
      const pctx = { now: m.now, target: m.target, now_table: m.now, target_table: m.target,
                     labels: { current: { mode: "tap" }, target: { mode: "tap" } }, nudged: { current: false, target: false },
                     minutes: sc.inputs.duration_min, lyric: "no_preference", genres: [], pace_user: null, seed: sc.inputs.seed,
                     global_stats: {}, disliked_now: [], session_no: 1 };
      const out = P.resolvePolicy(P.emptyModel(rules), pctx, rules, { mode: "p0" });
      if (out && out.policy) return out.policy;
    }
  } catch (e) { /* 스텁이 아직 ctx 를 다 못 받으면 중립 정책으로 */ }
  try { return typeof P.neutralPolicy === "function" ? P.neutralPolicy(rules) : null; } catch (e) { return null; }
}

/* 시나리오 하나에 요청된 검사를 모두 — 첫 불일치를 돌려준다(없으면 null). skipped 는 이 시나리오에서 못 돌린 검사 */
function runScenario(ctx, sc, checks, cap) {
  const E0 = ctx.B.engine, E1 = ctx.C.engine;
  const R0 = applyRulesPatch(ctx.B.rules, sc.rules_patch), R1 = applyRulesPatch(ctx.C.rules, sc.rules_patch);
  const cat = ctx.songs;
  let r0 = null;
  const base = () => (r0 ||= E0.recommend(cat, R0, sc.inputs));
  const fail = (check, variant, d, a, b) => ({ grid: sc.grid, id: sc.id, check, variant, diff: d, seqA: ids(a), seqB: ids(b) });
  const done = [], skipped = [];
  /* 엔진은 순수 함수여야 한다 — 입력·규칙 객체를 바꾸면 다음 실행이 오염되므로 그 자체를 불일치로 본다 */
  const snapIn = JSON.stringify(sc.inputs), snapR1 = JSON.stringify(R1);
  for (const check of checks) {
    if (!cap.can[check]) { skipped.push(check); continue; }
    if (check === "i0") {
      const r1 = E1.recommend(cat, R1, sc.inputs);
      let d = sameJson(base(), r1); if (d) return { mismatch: fail("i0", "personal 없음", d, base(), r1) };
      const rn = E1.recommend(cat, R1, { ...sc.inputs, personal: null });
      d = sameJson(base(), rn); if (d) return { mismatch: fail("i0", "personal: null", d, base(), rn) };
    } else if (check === "i0off") {
      const Roff = { ...R1, personalization: { ...(R1.personalization || {}), enabled: false } };
      const pol = offPolicy(ctx, sc, R1);
      if (!pol) { skipped.push(check); continue; }
      const r1 = E1.recommend(cat, Roff, { ...sc.inputs, personal: pol });
      const d = sameJson(base(), r1); if (d) return { mismatch: fail("i0off", "personalization.enabled=false + 정책", d, base(), r1) };
    } else if (check === "pace") {
      for (const pace of ["fast", "slow"]) {
        const Rp = { ...R0, iso: { ...R0.iso, transition_point: ctx.tables.PACE_TP[pace] } };
        const a = E0.recommend(cat, Rp, sc.inputs), b = E1.recommend(cat, R1, { ...sc.inputs, pace });
        const d = sameJson(a, b); if (d) return { mismatch: fail("pace", pace, d, a, b) };
      }
    } else if (check === "i1") {
      const rn = E1.recommend(cat, R1, { ...sc.inputs, personal: ctx.C.personal.neutralPolicy(R1) });
      const d = sameUnderNeutral(base(), rn); if (d) return { mismatch: fail("i1", "neutralPolicy", d, base(), rn) };
    }
    done.push(check);
  }
  if (JSON.stringify(sc.inputs) !== snapIn) return { mismatch: { grid: sc.grid, id: sc.id, check: "purity", variant: "엔진이 inputs 객체를 바꿈", diff: firstDiff(JSON.parse(snapIn), JSON.parse(JSON.stringify(sc.inputs))) } };
  if (JSON.stringify(R1) !== snapR1) return { mismatch: { grid: sc.grid, id: sc.id, check: "purity", variant: "엔진이 rules 객체를 바꿈", diff: firstDiff(JSON.parse(snapR1), JSON.parse(JSON.stringify(R1))) } };
  return { mismatch: null, done, skipped };
}

// ── affinity (A4) ───────────────────────────────────────
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/* 무작위 항목 집합 — vote 없는 옛 모양만(명세 I0). 이유 코드는 규칙에 없는 것(arrival_mismatch·length·모르는 코드)까지 섞는다 */
export function randomItemSets(songs, n = 200, seed = 0x5eed) {
  const rnd = mulberry32(seed);
  const pickOf = (xs) => xs[Math.floor(rnd() * xs.length)];
  const REASONS = [undefined, null, "not_my_taste", "vocal_bother", "path_jump", "mood_mismatch", "too_repetitive", "arrival_mismatch", "length", "모르는_코드"];
  const sets = [[]];
  while (sets.length < n) {
    const size = Math.floor(rnd() * 41);
    const items = [];
    for (let i = 0; i < size; i++) {
      const s = pickOf(songs), it = {};
      if (rnd() < 0.9) it.song_id = s.song_id;
      if (rnd() < 0.95) it.artist = rnd() < 0.1 ? `${s.artist};${pickOf(songs).artist}` : s.artist;
      if (rnd() < 0.9) it.genres = s.genres;
      if (rnd() < 0.9) it.feature_bins = s.feature_bins;
      const r = rnd();
      if (r < 0.3) it.liked = true; else if (r < 0.45) { it.disliked = true; it.reason = pickOf(REASONS); } else if (r < 0.5) { it.liked = true; it.disliked = true; }
      if (rnd() < 0.1) it.pinned = true;
      if (rnd() < 0.5) it.completion = rnd() < 0.2 ? 0.8 : rnd();
      if (rnd() < 0.15) it.skipped = true;
      if (rnd() < 0.8) it.days = rnd() < 0.2 ? 0 : Math.round(rnd() * 6000) / 100;
      items.push(it);
    }
    sets.push(items);
  }
  return sets;
}
function checkAffinity(ctx) {
  const E0 = ctx.B.engine, E1 = ctx.C.engine, R0 = ctx.B.rules, R1 = ctx.C.rules;
  /* 특징 묶음 — 기준·대상 엔진이 같은 카탈로그에 같은 묶음을 내야 두 경로의 곡 객체가 같다 */
  const b0 = E0.makeFeatureBinner(ctx.songs, R0), b1 = E1.makeFeatureBinner(ctx.songs, R1);
  let d = firstDiff(b0.cuts, b1.cuts, "$.cuts");
  if (d) return { mismatch: { grid: "catalog", id: "makeFeatureBinner", check: "affinity", variant: "특징 묶음 경계", diff: d } };
  for (const s of ctx.songs) {
    d = firstDiff(b0(s), b1(s), `$.feature_bins[${s.song_id}]`);
    if (d) return { mismatch: { grid: "catalog", id: s.song_id, check: "affinity", variant: "특징 묶음", diff: d } };
  }
  const sets = randomItemSets(ctx.songs, 200);
  const probeSets = (ctx.scenarios.probe || []).filter((sc) => sc.meta.mu === 0 && sc.meta.seed_k === 1).map((sc) => sc.meta.items);
  let n = 0;
  for (const [label, list] of [["무작위", sets], ["탐침", probeSets]]) {
    for (let i = 0; i < list.length; i++) {
      const a = E0.aggregateAffinity(list[i], R0), b = E1.aggregateAffinity(list[i], R1);
      if (JSON.stringify(a) !== JSON.stringify(b))
        return { mismatch: { grid: "items", id: `${label}#${i}`, check: "affinity", variant: `항목 ${list[i].length}개`, diff: firstDiff(a, b) || { path: "$", a: "(JSON 문자열만 다름)", b: "" } } };
      n++;
    }
  }
  return { mismatch: null, n, bins: ctx.songs.length };
}

// ── 출력 ────────────────────────────────────────────────
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 300 ? s.slice(0, 300) + " …" : s; };
function printMismatch(m) {
  console.error(`\n✗ 불일치 — 검사 ${m.check} (${m.variant}) · 격자 ${m.grid} · ${m.id}`);
  const d = m.diff || {};
  console.error(`  첫 차이 ${d.path}${d.note ? ` — ${d.note}` : ""}${d.keyOrderOnly ? " — 값은 같고 키 순서만 다름(JSON 직렬화 기준이라 불일치)" : ""}`);
  console.error(`    기준(2.5.1): ${short(d.a)}`);
  console.error(`    대상       : ${short(d.b)}`);
  if (m.seqA || m.seqB) {
    console.error(`  곡 순서 기준: ${(m.seqA || []).join(" ")}`);
    console.error(`  곡 순서 대상: ${(m.seqB || []).join(" ")}`);
  }
}

// ── 워커 ────────────────────────────────────────────────
async function workerMain() {
  const { opts, w, W, checks } = workerData;
  try {
    const ctx = await setup(opts);
    const cap = capability(ctx);
    for (const g of opts.grids) {
      const list = ctx.scenarios[g];
      let n = 0;
      const skipped = {};
      for (let i = w; i < list.length; i += W) {
        const r = runScenario(ctx, list[i], checks, cap);
        if (r.mismatch) { parentPort.postMessage({ type: "mismatch", m: r.mismatch }); return; }
        for (const s of r.skipped) skipped[s] = (skipped[s] || 0) + 1;
        n++;
        if (n % 20 === 0) parentPort.postMessage({ type: "progress", grid: g, n: 20 });
      }
      parentPort.postMessage({ type: "progress", grid: g, n: n % 20, done: true, skipped });
    }
    parentPort.postMessage({ type: "done" });
  } catch (e) {
    parentPort.postMessage({ type: "error", message: String(e && e.stack || e), setup: !!(e && e.setup) });
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }
  const t0 = performance.now();
  let ctx;
  try { ctx = await setup(opts); }
  catch (e) { console.error(`준비 실패: ${e.message}`); process.exit(2); }
  const { can, why } = capability(ctx);
  const V1 = ctx.C.engine.ENGINE_VERSION, V0 = ctx.B.engine.ENGINE_VERSION;
  console.log(`기준 ${ctx.B.ref} (engine ${V0}, rules ${ctx.B.rules.rules_version}) ↔ 대상 작업 트리 (engine ${V1}, rules ${ctx.C.rules.rules_version}${ctx.C.personal ? `, personal ${ctx.C.personal.PERSONAL_VERSION ?? "?"}` : ""})`);
  console.log(`카탈로그 ${ctx.index.n}곡 digest ${ctx.index.digest} · 격자 ${opts.grids.map((g) => `${g} ${ctx.scenarios[g].length}`).join(" · ")} · 검사 ${opts.checks.join(",")}`);

  /* 명세 §9.2 export 점검(참고) — 없는 것은 해당 검사에서 exit 2 */
  const need = { engine: ["recommend", "recommendExtras", "aggregateAffinity", "sanitizePersonal", "adjFeatures", "adjCost", "workingCoords", "makeExtraBinner", "seededUniform", "fnv1a32", "songCount", "transitionAt", "makeFeatureBinner"],
                 personal: ["neutralPolicy", "resolvePolicy", "emptyModel"] };
  const missE = missingExports(ctx.C.engine, need.engine), missP = missingExports(ctx.C.personal, need.personal);
  if (missE.length) console.log(`  참고: engine.js 에 아직 없는 export — ${missE.join(", ")}`);
  if (missP.length) console.log(`  참고: personal.js 에 아직 없는 export — ${missP.join(", ")}`);
  if (why.i0off_note && opts.checks.includes("i0off")) console.log(`  참고: ${why.i0off_note}`);
  /* 돌릴 수 없는 검사: 이름으로 요청했으면 exit 2, --check all 이면 경고하고 나머지만 돈다(마지막 줄에 다시 적는다) */
  const blocked = opts.checks.filter((c) => !can[c]);
  if (blocked.length) {
    for (const c of blocked) console.error(`${opts.checksAll ? "⚠ 건너뜀" : "✗ 돌릴 수 없음"} — 검사 ${c}: ${why[c]}`);
    if (!opts.checksAll) process.exit(2);
    opts.checks = opts.checks.filter((c) => can[c]);
  }

  const summary = [];
  if (opts.checks.includes("affinity")) {
    const r = checkAffinity(ctx);
    if (r.mismatch) { printMismatch(r.mismatch); process.exit(1); }
    summary.push(["items", "affinity", `${r.n}/${r.n} 항목 집합 · 특징 묶음 ${r.bins}곡`]);
  }
  const checks = opts.checks.filter((c) => SCENARIO_CHECKS.includes(c));
  const total = Object.values(ctx.scenarios).reduce((a, l) => a + l.length, 0);
  if (checks.length && total) {
    const counts = Object.fromEntries(opts.grids.map((g) => [g, 0]));
    const skippedAll = {};
    const onProgress = (msg) => {
      counts[msg.grid] += msg.n;
      if (msg.skipped) for (const [k, v] of Object.entries(msg.skipped)) skippedAll[`${msg.grid}:${k}`] = (skippedAll[`${msg.grid}:${k}`] || 0) + v;
      const done = Object.values(counts).reduce((a, b) => a + b, 0);
      if (opts.quiet) return;
      const line = `  진행 ${done}/${total} (${((performance.now() - t0) / 1000).toFixed(0)}s)`;
      if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
      else {   // 파이프·로그 파일에는 10% 마다 한 줄
        const step = Math.floor((done * 10) / total);
        if (step > (onProgress.last ?? -1)) { onProgress.last = step; console.log(line); }
      }
    };
    let mismatch = null;
    if (opts.workers <= 1) {
      const cap = { can, why };
      outer: for (const g of opts.grids) for (const sc of ctx.scenarios[g]) {
        const r = runScenario(ctx, sc, checks, cap);
        if (r.mismatch) { mismatch = r.mismatch; break outer; }
        onProgress({ grid: g, n: 1, skipped: Object.fromEntries(r.skipped.map((s) => [s, 1])) });
      }
    } else {
      const W = Math.min(opts.workers, total);
      mismatch = await new Promise((resolve, reject) => {
        const workers = [];
        let finished = 0, settled = false;
        const stopAll = () => { for (const wk of workers) wk.terminate(); };
        for (let w = 0; w < W; w++) {
          const wk = new Worker(new URL(import.meta.url), { workerData: { opts, w, W, checks } });
          workers.push(wk);
          wk.on("message", (msg) => {
            if (settled) return;
            if (msg.type === "progress") onProgress(msg);
            else if (msg.type === "mismatch") { settled = true; stopAll(); resolve(msg.m); }
            else if (msg.type === "error") { settled = true; stopAll(); reject(Object.assign(new Error(msg.message), { setup: msg.setup })); }
            else if (msg.type === "done" && ++finished === W) { settled = true; resolve(null); }
          });
          wk.on("error", (e) => { if (!settled) { settled = true; stopAll(); reject(e); } });
        }
      }).catch((e) => { console.error(`\n워커 실패: ${e.message}`); process.exit(2); });
    }
    if (!opts.quiet && process.stdout.isTTY) process.stdout.write("\n");
    if (mismatch) { printMismatch(mismatch); process.exit(1); }
    for (const g of opts.grids) {
      const n = ctx.scenarios[g].length;
      const cases = new Set(ctx.scenarios[g].map((s) => s.case)).size;
      for (const c of checks) {
        const sk = skippedAll[`${g}:${c}`] || 0;
        summary.push([g, c, `${n - sk}/${n} 일치${g === "probe" ? ` (사례 ${cases}개)` : ""}${sk ? ` · 건너뜀 ${sk}` : ""}`]);
      }
    }
  }
  console.log("\n격자       검사      결과");
  for (const [g, c, r] of summary) console.log(`${g.padEnd(10)} ${c.padEnd(9)} ${r}`);
  console.log(`${blocked.length ? `요청한 검사 중 돌린 것은 모두 일치 — ⚠ 건너뛴 검사: ${blocked.join(", ")}` : "모두 일치"} · ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

if (isMainThread) {
  const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  if (isMain) await main();
} else await workerMain();
