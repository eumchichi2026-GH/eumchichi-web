/*
 * 성능 측정 (TOOLS · 명세 §11 H5) — 한 스레드, 다른 작업 없이, 명세가 정한 기록 크기(추천 100 · 이벤트 1,200)에서 잰다.
 * **기록은 합성 사용자(시뮬레이터 페르소나) 기록이다.** 시간은 이 기기의 Node 에서 잰 값이다(명세: "노트북 Node").
 *
 *   node tools/sim/bench_h5.mjs [--persona P1] [--history-sessions 100] [--contexts 24] [--model-reps 20] [--policy-reps 200]
 *                               [--profile] [--demo all|P1,P9,…] [--json <경로>] [--quiet]
 *   run.mjs 도 워커가 모두 끝난 뒤 같은 스레드에서 benchH5() 를 부른다(--h5 0 이면 건너뜀) — 워커와 경합한 시뮬레이터 안 시간은 참고로만 둔다.
 *
 * 무엇을 재나 (모두 중앙값, ms — 앞의 warmup 회는 버린다)
 *   history    페르소나를 wp 팔로 history-sessions 세션 돌려 저장소를 만든다 → toRawFacts(추천 최근 100 · 이벤트 최근 1,200, 앱 로그인 창과 같다)
 *   model      normalizeLogs + buildPersonalModel (따로도) — H5 "모델 빌드 ≤ 50ms"
 *   policy     resolvePolicy(personal) · resolvePolicy(p0) — H5 "resolvePolicy ≤ 5ms"
 *   run        iso1224 격자에서 고른 contexts 개 입력마다 engine.recommend 를 정책별로:
 *                2.5.1(76e8bdf 엔진·규칙, personal 없음) · 2.6.0-wp personal 없음 · neutralPolicy · P0 정책 · 개인 정책 · 개인 정책에서 adj_w = 0
 *              — "개인 실행 중앙 ≤ 150ms" 는 개인 정책 실행 A. 나머지 줄은 시간이 어디서 느는지 나눠 보는 분해용
 *   button     앱 recommend()(index.html runPersonalRecommend) 순서: A + R + (안전 확인 · 위반이면 A′ + 확인) + extras
 *              — 명세의 "버튼→결과(A+R+extras) ≤ 400ms" 는 A+R+extras, "전체"는 모델 재빌드·resolvePolicy 2회·safetyCheck·A′·buildRecLog 까지
 *   profile    (--profile) node:inspector CPU 표본으로 개인 실행 A 의 자기 시간(self time) 상위 함수
 *   demo       (--demo, 판정 밖 B8 진단) 앱 데모 프로필 demo/personas/<id>.json 모델로 같은 입력에 앱 순서(A·R·R_path·A′)를 돌려 폴백 수 — 시간 측정 뒤
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { simulate } from "./lib_runner.mjs";
import { toRawFacts } from "./lib_store.mjs";
import { PERSONAS, SIM, materializePersona } from "./personas.mjs";
import { normScenario } from "./lib_env.mjs";
import { q } from "./lib_metrics.mjs";

export const H5_DEFAULTS = { persona: "P1", history_sessions: 100, contexts: 24, model_reps: 20, policy_reps: 200, warmup: 3, profile: false, demo: null };

const now = () => performance.now();
const sum0 = (xs) => xs.reduce((a, b) => a + b, 0);
const med = (xs) => q(xs, 0.5);
const stats = (xs) => ({ n: xs.length, med: q(xs, 0.5), p90: q(xs, 0.9), max: xs.length ? Math.max(...xs) : NaN, min: xs.length ? Math.min(...xs) : NaN });
function timeIt(fn, reps, warmup) {
  for (let i = 0; i < warmup; i++) fn();
  const out = [];
  for (let i = 0; i < reps; i++) { const t = now(); fn(); out.push(now() - t); }
  return out;
}
/* 격자 단어 → 로그 라벨 (lib_grid.labelsOf 와 같은 규칙) */
function labelsOf(sc, vocab) {
  const isMood = vocab.mood_chips.some((c) => c[0] === sc.now_label), isGoal = vocab.goal_chips.some((c) => c[0] === sc.goal_label);
  return {
    current: isMood ? { mode: "chip", chip: sc.now_label } : sc.now_label ? { mode: "nl", nl: [{ label: sc.now_label, intensity: 2 }] } : { mode: "tap" },
    target: isGoal ? { mode: "chip", chip: sc.goal_label } : sc.goal_label ? { mode: "nl", nl: sc.goal_label } : { mode: "tap" },
  };
}

/* node:inspector CPU 표본 — 자기 시간 상위 함수 (함수 이름 · 파일:줄) */
async function withProfile(fn) {
  const inspector = await import("node:inspector");
  const session = new inspector.Session();
  session.connect();
  const post = (m, p = {}) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 200 });
  await post("Profiler.start");
  fn();
  const { profile } = await post("Profiler.stop");
  session.disconnect();
  const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byNode.get(profile.samples[i]);
    const dt = (profile.timeDeltas[i] || 0) / 1000;
    total += dt;
    const cf = n.callFrame;
    const file = cf.url ? path.basename(cf.url.replace(/^file:\/\//, "")) : "";
    const key = `${cf.functionName || "(anonymous)"} ${file}${file ? `:${cf.lineNumber + 1}` : ""}`;
    self.set(key, (self.get(key) || 0) + dt);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([fnName, ms]) => ({ fn: fnName, ms, share: total ? ms / total : NaN }));
  return { total_ms: total, top };
}

/**
 * @param deps   loadDeps() 결과 (baseline 이 있으면 2.5.1 줄도 잰다)
 * @param shared makeShared(deps)
 */
export async function benchH5({ deps, shared, twin = null, opts = {}, log = () => {} }) {
  const o = { ...H5_DEFAULTS, ...opts };
  const { personal, engine, rules, cat } = deps;
  if (!personal) return { error: "engine/personal.js 없음" };
  const base = PERSONAS.find((p) => p.id === o.persona);
  if (!base) return { error: `모르는 페르소나 ${o.persona}` };

  // ── 기록 만들기 (합성 사용자) ──
  const tH = now();
  const persona = materializePersona(base, 0);
  const sim = simulate({ deps, shared, twin, persona, rep: 0, arm: "wp", sessions: Number(o.history_sessions), env: "local" });
  const as_of = sim.lastEnd;
  const raw = toRawFacts(sim.store, { as_of_ms: as_of, vocab: deps.vocab, rules, env: "local" });
  const history = { persona: o.persona, sessions: sim.records.length, errors: sim.records.filter((r) => r.error).length,
                    recs_total: sim.store.recs.length, events_total: sim.store.events.length,
                    recs_window: raw.recommendations.length, events_window: raw.events.length, sim_s: (now() - tH) / 1000 };
  log(`[H5] 기록 ${history.sessions}세션 · 추천 ${history.recs_window} · 이벤트 ${history.events_window} (${history.sim_s.toFixed(0)}s)`);
  /* 시뮬레이터 세션 안에서 잰 시간(워커 없이 한 스레드, 기록이 자라는 중) — 참고 */
  const inSim = sim.records.filter((r) => r.timing).map((r) => r.timing);

  // ── 모델 빌드 ──
  const W = Number(o.warmup);
  const clone = () => JSON.parse(JSON.stringify(raw));
  const rawCopies = Array.from({ length: Number(o.model_reps) + W }, clone);   // 복사 시간은 빼고 잰다
  let norm = null, model = null;
  const tNorm = [], tBuild = [], tModel = [];
  rawCopies.forEach((r, i) => {
    let t = now();
    const nn = personal.normalizeLogs(r, cat.index, rules);
    const a = now() - t;
    t = now();
    const mm = personal.buildPersonalModel(nn, cat.index, rules, { as_of_ms: as_of });
    const b = now() - t;
    if (i >= W) { tNorm.push(a); tBuild.push(b); tModel.push(a + b); }
    norm = nn; model = mm;
  });
  log(`[H5] 모델 빌드 중앙 ${med(tModel).toFixed(1)}ms (normalize ${med(tNorm).toFixed(1)} · build ${med(tBuild).toFixed(1)})`);

  // ── 입력(격자에서 고른 contexts 개) ──
  const grid = deps.grids ? deps.grids.iso1224({ tables: deps.tables76 }) : null;
  if (!grid) return { error: "격자(grids.mjs) 없음", history };
  const stride = Math.max(1, Math.floor(grid.length / Number(o.contexts)));
  const scen = grid.filter((_, i) => i % stride === 0).slice(0, Number(o.contexts));
  const disliked = [...raw.profile.dislikedSongs];
  const ctxOf = (raw0, i) => {
    const sc = normScenario(raw0);
    return { sc, raw0, ctx: { now: sc.now, target: sc.target, now_table: sc.now, target_table: sc.target, labels: labelsOf(sc, deps.vocab),
      nudged: { current: false, target: false }, minutes: sc.minutes, lyric: "no_preference", genres: [], pace_user: null,
      seed: `h5:${i}:${sc.seed}`, global_stats: {}, disliked_now: disliked, session_no: history.sessions + 1, env: "local" } };
  };
  const C = scen.map(ctxOf);

  // ── resolvePolicy ──
  const c0 = C[0].ctx;
  const tPol = timeIt(() => personal.resolvePolicy(model, c0, rules), Number(o.policy_reps), W * 10);
  const tPolP0 = timeIt(() => personal.resolvePolicy(model, c0, rules, { mode: "p0" }), Number(o.policy_reps), W * 10);
  log(`[H5] resolvePolicy 중앙 ${med(tPol).toFixed(2)}ms (p0 ${med(tPolP0).toFixed(2)})`);

  // ── 실행: 정책별 분해 + 앱 버튼 순서 ──
  const neutral = personal.neutralPolicy(rules);
  const empty = personal.emptyModel(rules);
  const rows = { base251: [], none: [], neutral: [], p0: [], personal: [], personal_adj0: [], R: [], safety: [], geo: [], extras: [], reclog: [],
                 button_spec: [], button_full: [] };
  let fallbacks = 0, violations = {}, rpRuns = 0;
  const lanes = {};
  const fillRatio = Number(rules.personalization && rules.personalization.extras && rules.personalization.extras.fill_ratio);
  const inputOf = (ctx, sc, raw0) => ({ now: { V: sc.now.v, A: sc.now.e }, target: { V: sc.target.v, A: sc.target.e },
    stress: personal.stressOf(ctx.now, rules), load: null, genres: [], duration_min: sc.minutes, seed: ctx.seed, gates: [], pace: null });
  /* JIT 예열 — 첫 입력을 한 번씩 */
  {
    const { ctx, sc, raw0 } = C[0];
    const out = personal.resolvePolicy(model, ctx, rules);
    engine.recommend(shared.contract, rules, { ...inputOf(ctx, sc, raw0), user: out.user, personal: out.policy });
    if (deps.baseline) deps.baseline.engine.recommend(shared.contract, deps.baseline.rules, raw0.inputs);
  }
  for (const { ctx, sc, raw0 } of C) {
    const input = inputOf(ctx, sc, raw0);
    let t;
    if (deps.baseline && raw0.inputs) {
      t = now(); deps.baseline.engine.recommend(shared.contract, deps.baseline.rules, raw0.inputs); rows.base251.push(now() - t);
    }
    const userNew = { disliked: [], recent_played: [], global_stats: {} };
    t = now(); engine.recommend(shared.contract, rules, { ...input, user: userNew }); rows.none.push(now() - t);
    t = now(); engine.recommend(shared.contract, rules, { ...input, user: userNew, personal: neutral }); rows.neutral.push(now() - t);
    const p0e = personal.resolvePolicy(empty, ctx, rules);
    t = now(); engine.recommend(shared.contract, rules, { ...input, user: p0e.user, personal: p0e.policy }); rows.p0.push(now() - t);

    // 앱 순서 (index.html runPersonalRecommend — 완화 없음: 가사·장르 조건이 없는 입력)
    const tFull0 = now();
    const m2 = personal.buildPersonalModel(personal.normalizeLogs(clone(), cat.index, rules), cat.index, rules, { as_of_ms: as_of });
    const tFullModel = now() - tFull0;
    let tA = now();
    const out = personal.resolvePolicy(m2, ctx, rules);
    const ref = personal.resolvePolicy(m2, ctx, rules, { mode: "p0" });
    const tResolve = now() - tA;
    t = now();
    const resA = engine.recommend(shared.contract, rules, { ...input, user: out.user, personal: out.policy });
    const a = now() - t; rows.personal.push(a);
    const inputR = { ...input, user: ref.user, personal: ref.policy };
    t = now();
    const resR = engine.recommend(shared.contract, rules, inputR);
    const r = now() - t; rows.R.push(r);
    t = now();
    let safety = personal.safetyCheck(resA, resR, rules);
    /* §2.2 7(2026-09-29): 위반이고 경로 모수가 P0 와 다르면 R_path(곡 레인 P0 + A 경로 모수)로 두 레인 판정 — 그 실행 시간도 안전 확인에 넣는다 */
    const pathDiff = typeof personal.pathParamsDiffer === "function" && personal.pathParamsDiffer(out.policy, ref.policy);
    if (safety && safety.ok === false && pathDiff) {
      const rp = personal.resolvePolicy(m2, ctx, rules, { mode: "path" });
      const resRp = engine.recommend(shared.contract, rules, { ...input, user: rp.user, personal: rp.policy });
      safety = personal.safetyCheck(resA, resR, rules, { resRp });
      rpRuns++;
    }
    let s = now() - t;
    let final = resA, finalInput = { ...input, user: out.user, personal: out.policy }, g = 0, usedOut = out, fallback = null;
    if (safety && safety.ok === false) {
      fallbacks++;
      for (const v of safety.violations || []) violations[v] = (violations[v] || 0) + 1;
      lanes[safety.lane || "한 기준"] = (lanes[safety.lane || "한 기준"] || 0) + 1;
      t = now();
      if (pathDiff) {
        const geo = personal.resolvePolicy(m2, ctx, rules, { mode: "geometry" });
        const in2 = { ...input, user: geo.user, personal: geo.policy };
        const res2 = engine.recommend(shared.contract, rules, in2);
        const s2 = personal.safetyCheck(res2, resR, rules);
        if (s2 && s2.ok !== false) { final = res2; finalInput = in2; usedOut = geo; fallback = "geometry"; }
        else { final = resR; finalInput = inputR; usedOut = ref; fallback = "p0"; }
      } else { final = resR; finalInput = inputR; usedOut = ref; fallback = "p0"; }   // 경로 모수 = P0 → A′ ≡ A
      g = now() - t; rows.geo.push(g);
    }
    rows.safety.push(s);
    t = now();
    const extras = engine.recommendExtras(shared.contract, rules, finalInput, final, { target_sec: sc.minutes * 60 * (fillRatio || 0.85) }) || { extras: [] };
    const x = now() - t; rows.extras.push(x);
    t = now();
    personal.buildRecLog({ ctx, policyOut: out, usedOut, refOut: ref, resA: final, resR, extras, safety, fallback, env: { app: "web-personal", env: "local" }, catalogIndex: cat.index, rules });
    const lg = now() - t; rows.reclog.push(lg);
    rows.button_spec.push(a + r + x);
    rows.button_full.push(tFullModel + tResolve + a + r + s + g + x + lg);

    // 분해: 개인 정책에서 전환 비용만 끈 실행
    if (out.policy && out.policy.adj_w) {
      const pol0 = { ...out.policy, adj_w: Object.fromEntries(Object.keys(out.policy.adj_w).map((f) => [f, 0])) };
      t = now(); engine.recommend(shared.contract, rules, { ...input, user: out.user, personal: pol0 }); rows.personal_adj0.push(now() - t);
    }
  }
  log(`[H5] 개인 실행 A 중앙 ${med(rows.personal).toFixed(1)}ms · A+R+extras ${med(rows.button_spec).toFixed(1)}ms · 전체 ${med(rows.button_full).toFixed(1)}ms`);

  /* B8 진단(판정 밖) — 앱 데모 프로필(demo/personas/<id>.json, 합성 사용자 10세션 RawFacts)로 같은 입력 C 에 앱 순서(A·R·R_path·A′)를 돌려 폴백 수.
   * 브라우저에서 본 "데모 P1 추천 3번 중 2번 폴백"을 Node 에서 같은 흐름으로 다시 잰다. 시간 측정이 끝난 뒤라 H5 값에 섞이지 않는다. */
  let demo = null;
  if (o.demo) {
    const fs = (await import("node:fs")).default;
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "demo", "personas");
    const want = o.demo === true || o.demo === "all" ? fs.readdirSync(dir).filter((f) => /^P\d+\.json$/.test(f)).map((f) => f.replace(/\.json$/, ""))
      : String(o.demo).split(",").map((s) => s.trim()).filter(Boolean);
    want.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    demo = { contexts: C.length, personas: [] };
    for (const id of want) {
      const f = path.join(dir, `${id}.json`);
      if (!fs.existsSync(f)) { demo.personas.push({ id, error: "파일 없음" }); continue; }
      const rawD = JSON.parse(fs.readFileSync(f, "utf8"));
      const mD = personal.buildPersonalModel(personal.normalizeLogs(JSON.parse(JSON.stringify(rawD)), cat.index, rules), cat.index, rules, { as_of_ms: rawD.as_of_ms });
      const row = { id, rules_hash: rawD.demo && rawD.demo.rules_hash, pi: mD.pace ? mD.pace.pi : null, n: 0, path_diff: 0, rp_run: 0, fallback: 0, geometry: 0, p0: 0, violations: {}, lanes: {}, ex: [] };
      for (let i = 0; i < C.length; i++) {
        const { sc, raw0 } = C[i];
        const ctx = { ...C[i].ctx, disliked_now: [...((rawD.profile && rawD.profile.dislikedSongs) || [])], session_no: 11, seed: `h5demo:${id}:${i}:${sc.seed}` };
        const input = inputOf(ctx, sc, raw0);
        const out = personal.resolvePolicy(mD, ctx, rules), ref = personal.resolvePolicy(mD, ctx, rules, { mode: "p0" });
        const resA = engine.recommend(shared.contract, rules, { ...input, user: out.user, personal: out.policy });
        const resR = engine.recommend(shared.contract, rules, { ...input, user: ref.user, personal: ref.policy });
        let s = personal.safetyCheck(resA, resR, rules);
        const pd = typeof personal.pathParamsDiffer === "function" && personal.pathParamsDiffer(out.policy, ref.policy);
        row.n++; if (pd) row.path_diff++;
        if (s && s.ok === false && pd) {
          row.rp_run++;
          const rp = personal.resolvePolicy(mD, ctx, rules, { mode: "path" });
          s = personal.safetyCheck(resA, resR, rules, { resRp: engine.recommend(shared.contract, rules, { ...input, user: rp.user, personal: rp.policy }) });
        }
        if (s && s.ok === false) {
          row.fallback++;
          let fb = "p0";
          if (pd) {
            const geo = personal.resolvePolicy(mD, ctx, rules, { mode: "geometry" });
            const s2 = personal.safetyCheck(engine.recommend(shared.contract, rules, { ...input, user: geo.user, personal: geo.policy }), resR, rules);
            if (s2 && s2.ok !== false) fb = "geometry";
          }
          row[fb]++;
          for (const v of s.violations || []) row.violations[v] = (row.violations[v] || 0) + 1;
          row.lanes[s.lane || "한 기준"] = (row.lanes[s.lane || "한 기준"] || 0) + 1;
          if (row.ex.length < 3) row.ex.push(`${sc.minutes}분 ${(s.violations || []).join("+")}${s.lane ? `(${s.lane})` : ""} → ${fb}`);
        }
      }
      demo.personas.push(row);
      log(`[B8 데모] ${id} 폴백 ${row.fallback}/${row.n} (경로 모수 다름 ${row.path_diff} · R_path ${row.rp_run}) ${JSON.stringify(row.violations)}`);
    }
    demo.total = { n: sum0(demo.personas.map((r) => r.n || 0)), fallback: sum0(demo.personas.map((r) => r.fallback || 0)) };
  }

  let profile = null;
  if (o.profile) {
    const { ctx, sc, raw0 } = C[Math.floor(C.length / 2)];
    const out = personal.resolvePolicy(model, ctx, rules);
    const input = { ...inputOf(ctx, sc, raw0), user: out.user, personal: out.policy };
    profile = await withProfile(() => { for (let i = 0; i < 10; i++) engine.recommend(shared.contract, rules, input); });
    profile.runs = 10;
  }

  const S = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, stats(v)]));
  return {
    synthetic: "합성 사용자", machine: { node: process.version, platform: process.platform, arch: process.arch, cpus: (await import("node:os")).default.cpus()[0]?.model || "?" },
    history, contexts: C.length, context_minutes: C.map((c) => c.sc.minutes),
    model: { total: stats(tModel), normalize: stats(tNorm), build: stats(tBuild), digest: model && model.digest,
             pi: model && model.pace ? model.pace.pi : null, n_exposures: model && model.evidence ? model.evidence.n_exposures : null },
    policy: { personal: stats(tPol), p0: stats(tPolP0) },
    run: S, fallbacks, violations, lanes, rp_runs: rpRuns, demo,
    in_sim: { n: inSim.length, model: stats(inSim.map((x) => x.model_ms).filter(Number.isFinite)), runA: stats(inSim.map((x) => x.runA_ms).filter(Number.isFinite)) },
    profile, opts: o,
  };
}

/* ── CLI ── */
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const { parseArgs, loadDeps, writeFileSafe, ROOT } = await import("./lib_env.mjs");
  const { makeShared } = await import("./lib_session.mjs");
  const { createTwin } = await import("./fixweb_twin.mjs");
  const A = parseArgs();
  const log = (...x) => { if (!A.quiet) console.error(...x); };
  const deps = await loadDeps({ dataRepo: A["data-repo"] || null, needBaseline: true, needGrids: true });
  const shared = makeShared(deps);
  const twin = deps.baseline ? createTwin({ baseline: deps.baseline, catalogIndex: deps.cat.index, tables: deps.tables76 }) : null;
  const opts = {};
  if (A.persona) opts.persona = String(A.persona);
  for (const [k, key] of [["history-sessions", "history_sessions"], ["contexts", "contexts"], ["model-reps", "model_reps"], ["policy-reps", "policy_reps"], ["warmup", "warmup"]])
    if (A[k] != null) opts[key] = Number(A[k]);
  if (A.profile) opts.profile = true;
  if (A.demo) opts.demo = A.demo;
  const res = await benchH5({ deps, shared, twin, opts, log });
  const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
  console.log(`H5 (합성 사용자 기록 ${res.history ? `${res.history.persona} ${res.history.sessions}세션 · 추천 ${res.history.recs_window} · 이벤트 ${res.history.events_window}` : "—"}, ${res.machine ? `${res.machine.cpus} · Node ${res.machine.node}` : ""})`);
  if (res.error) { console.log(`  오류: ${res.error}`); process.exit(2); }
  console.log(`  모델 빌드 중앙 ${f(res.model.total.med)} ms (90% ${f(res.model.total.p90)} · 최대 ${f(res.model.total.max)}) = normalizeLogs ${f(res.model.normalize.med)} + buildPersonalModel ${f(res.model.build.med)}`);
  console.log(`  resolvePolicy 중앙 ${res.policy.personal.med.toFixed(2)} ms (p0 ${res.policy.p0.med.toFixed(2)})`);
  for (const [k, lab] of [["base251", "2.5.1 엔진(personal 없음)"], ["none", "2.6.0-wp personal 없음"], ["neutral", "neutralPolicy"], ["p0", "P0 정책(신규 회원)"],
                          ["personal", "개인 정책 실행 A"], ["personal_adj0", "개인 정책 · adj_w = 0"], ["R", "기준 실행 R"], ["safety", "safetyCheck"], ["geo", "A′(위반 때만)"],
                          ["extras", "recommendExtras"], ["reclog", "buildRecLog"], ["button_spec", "A+R+extras"], ["button_full", "앱 recommend() 전체"]])
    console.log(`  ${lab.padEnd(24)} 중앙 ${f(res.run[k].med)} · 90% ${f(res.run[k].p90)} · 최대 ${f(res.run[k].max)} ms (n ${res.run[k].n})`);
  console.log(`  안전 폴백 ${res.fallbacks}/${res.contexts} ${JSON.stringify(res.violations)} · 레인 ${JSON.stringify(res.lanes)} · R_path 실행 ${res.rp_runs}`);
  if (res.demo) { console.log(`  B8 진단 — 데모 프로필 × 입력 ${res.demo.contexts}개: 폴백 ${res.demo.total.fallback}/${res.demo.total.n}`); for (const r of res.demo.personas) console.log(`    ${r.id} 폴백 ${r.fallback}/${r.n} (geometry ${r.geometry} · p0 ${r.p0}) · 경로 모수 다름 ${r.path_diff} · R_path ${r.rp_run} · ${JSON.stringify(r.violations)} ${r.ex.join(" / ")}`); }
  if (res.profile) { console.log(`  CPU 자기 시간 상위 (개인 실행 ${res.profile.runs}회, 합 ${f(res.profile.total_ms)} ms)`); for (const t of res.profile.top) console.log(`    ${(t.share * 100).toFixed(1).padStart(5)}%  ${t.fn}`); }
  if (A.json) { const fs = (await import("node:fs")).default; fs.writeFileSync(path.resolve(String(A.json)), JSON.stringify(res, null, 1)); log(`→ ${A.json}`); }
}
