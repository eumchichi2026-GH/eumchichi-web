/*
 * 세션 한 번 돌리기 (TOOLS · 명세 §2.2 추천 1회 흐름을 앱과 같은 순서로) — run.mjs · sweep.mjs · demo_personas.mjs 가 쓴다.
 *
 *   팔 wp      RawFacts → personal.normalizeLogs → buildPersonalModel → calibratePoint(+끌기) → suggestMinutes
 *              → resolvePolicy(개인·p0) → engine.recommend A·R → safetyCheck → (위반 시 경로 모수 P0 로 A′ → 그래도면 R)
 *              → recommendExtras → buildRecLog → 저장 → behavior.respond → 저장
 *   팔 frozen  같은 흐름이지만 모델을 쓰지 않는다: 보정·시간 제안 없음, 정책은 resolvePolicy(..., { mode: "p0" })
 *              (학습값 없이 모집단 기본 + 비학습 사실 — 싫어요·최근 창. "모델을 늘 빈 모델로(P0 고정)"의 해석, 보고서에 적음)
 *   팔 twin    fixweb_twin.mjs (76e8bdf 재현)
 * 반환: 세션 기록(지표 계산에 필요한 것만 — 큰 객체는 남기지 않는다).
 */
import { planSession, decideNudge, respond } from "./behavior.mjs";
import { addRec, ingest, toRawFacts, behaviorHistory } from "./lib_store.mjs";
import { pathShape, adjPairs } from "./lib_metrics.mjs";
import { SIM } from "./personas.mjs";

const now = () => performance.now();
const PATH_KEYS = ["tp", "start_offset", "quit_frac", "hold_radius"];

/** 도구가 여러 번 쓰는 파생값 — 계약 곡 목록, 말 비중 게이트 문턱(상위 20%) */
export function makeShared(deps) {
  const contract = [...deps.cat.index.byId.values()];
  const g = (deps.rules.gates || []).find((x) => x.id === "exclude_spoken");
  const vals = contract.map((s) => Number(s.spokenness)).filter(Number.isFinite).sort((a, b) => a - b);
  const p80 = g ? vals[Math.max(0, Math.min(vals.length - 1, Math.ceil(Number(g.value) * vals.length) - 1))] : Infinity;
  return { contract, spoken_gate_th: p80 };
}

const stressLocal = (p, rules) => {
  const S = (rules.personalization && rules.personalization.safety) || {};
  const wv = Number(S.stress_w_v ?? 0.6), wa = Number(S.stress_w_a ?? 0.4);
  return Math.round(4 * Math.min(1, Math.max(0, (1 - p.v) * wv + p.e * wa)));
};

/* buildRecLog 결과에 빠진 필드를 채운다(스텁·부분 구현 대비). 채운 수를 세어 보고서에 적는다 — personal.js 가 채운 값은 절대 덮지 않는다. */
function fillRecLog(body, f, store) {
  const doc = body && typeof body === "object" ? JSON.parse(JSON.stringify(body)) : {};
  let n = 0;
  const put = (obj, k, v) => { if (obj[k] === undefined) { obj[k] = v; n++; } };
  doc.input = doc.input || {};
  const I = doc.input;
  put(I, "app", "web-personal"); put(I, "env", f.env);
  put(I, "current_va", { v: f.fin.current.v, e: f.fin.current.e }); put(I, "target_va", { v: f.fin.target.v, e: f.fin.target.e });
  put(I, "recommend_minutes", f.minutes); put(I, "lyric_preference", "no_preference"); put(I, "genres", []);
  put(I, "input_mode", { current: "chip", target: "chip" }); put(I, "pace_mode", f.pace_user || "auto");
  put(I, "seed", f.seed); put(I, "session_no", f.k);
  put(I, "effective", { lyric: "no_preference", genres: [], minutes: f.minutes });
  put(I, "minutes_base", f.base); put(I, "minutes_suggested", f.suggested); put(I, "relaxed", null);
  put(I, "pace_user", f.pace_user); put(I, "stress", f.stress); put(I, "high_stress", f.stress >= 3);
  put(I, "labels", f.labels); put(I, "table_point", f.table);
  put(I, "calib_applied", f.calib_applied); put(I, "nudged", f.nudged);
  put(I, "personal_policy", f.policy);
  if (!Array.isArray(doc.sequence) || !doc.sequence.length) {
    const phaseOf = (i, seq) => { const t = seq[seq.length - 1].trace, w = seq[i].trace; return Math.abs(w.wp_V - t.wp_V) < 1e-9 && Math.abs(w.wp_A - t.wp_A) < 1e-9 ? "hold" : "move"; };
    const seq = f.final.sequence;
    doc.sequence = [
      ...seq.map((r, i) => ({ song_id: r.song_id, position: i + 1, role: "path", phase: r.trace.p_phase || phaseOf(i, seq), fit: r.trace.va_distance,
        band_size: r.trace.band_size, chosen_by: r.trace.chosen_by, pref_score: r.trace.pref_score, pref_match: !!r.trace.pref_match,
        pref_basis: r.trace.pref_basis || null, quadrant: r.trace.quadrant, wp_V: r.trace.wp_V, wp_A: r.trace.wp_A, song_V: r.trace.song_V, song_A: r.trace.song_A,
        p_pmarg: r.trace.p_pmarg ?? null, p_pers: r.trace.p_pers ?? null, p_adj: r.trace.p_adj ?? null, p_adj_x: r.trace.p_adj_x ?? null,
        p_bpm_diff: r.trace.p_bpm_diff ?? null, p_geo_best: r.trace.p_geo_best ?? null, p_chosen_by: r.trace.p_chosen_by ?? null,
        discovery: !!r.trace.p_discovery, replay: !!r.trace.p_replay, soft_relaxed: !!r.trace.p_soft_relaxed })),
      ...(f.extras.extras || []).map((x, j) => ({ song_id: x.song_id, position: seq.length + j + 1, role: "extra", phase: "extra",
        fit: x.trace ? x.trace.va_distance : null, song_V: x.trace ? x.trace.song_V : null, song_A: x.trace ? x.trace.song_A : null,
        p_pmarg: x.trace ? x.trace.p_pmarg ?? null : null, p_pers: x.trace ? x.trace.p_pers ?? null : null, p_adj: x.trace ? x.trace.p_adj ?? null : null })),
    ];
    n++;
  }
  if (I.personal_meta && I.personal_meta.params && I.personal_meta.params.pi_used === undefined) { I.personal_meta.params.pi_used = f.pi_used_guess; n++; }
  if (n) store.fills += n;
  return doc;
}

/* 모델·정책에서 평가에 쓰는 값만 뽑는다 (없으면 null — 스텁이어도 죽지 않게) */
export function modelSummary(model) {
  if (!model) return null;
  const g = (o, ...ks) => ks.reduce((a, k) => (a == null ? a : a[k]), o);
  const adj = g(model, "adjacency") || {};
  const m = adj.m || {}, ap = adj.applied || {};
  const mApplied = Object.fromEntries(["tempo", "vocal", "spoken", "genre", "va"].map((f) => [f, ap[f] ? Number(m[f] ?? 1) : 1]));
  return {
    digest: model.digest ?? null, pi: g(model, "pace", "pi") ?? null, pace_votes: g(model, "pace", "votes") ?? null,
    quit_f_med: g(model, "pace", "quit", "f_med") ?? null,
    E: g(model, "taste", "E") ?? g(model, "evidence", "E") ?? null, mu: g(model, "taste", "mu") ?? null,
    start_arm: g(model, "start", "arm") ?? null, hold_arm: g(model, "hold", "arm") ?? null,
    length_bias: g(model, "length", "bias_log2") ?? null, base_minutes: g(model, "length", "base_minutes") ?? null,
    m_raw: { ...m }, m_applied: mApplied, applied: { ...ap },
    soft: [...(g(model, "gates", "soft") || [])], recent_window: g(model, "diversity", "recent_window") ?? null,
    artist_cap: g(model, "diversity", "artist_cap") ?? null, replay_n: (g(model, "diversity", "replay_ids") || []).length,
    calib: model.calib ? { current: model.calib.current && model.calib.current.labels ? model.calib.current.labels : {},
                           target: model.calib.target && model.calib.target.labels ? model.calib.target.labels : {} } : null,
    n_legacy: g(model, "source", "n_sessions_legacy") ?? null, n_wp: g(model, "source", "n_sessions_wp") ?? null,
    n_exposures: g(model, "evidence", "n_exposures") ?? null,
    vote_sum: (g(model, "taste", "items") || []).reduce((a, it) => a + (it && it.vote ? Number(it.vote.pos || 0) + Number(it.vote.neg || 0) : 0), 0),
    /* 진단용(보고서 주석) — 학습 자극이 실제로 얼마나 모였나 */
    n_large: { ...(adj.n_large || {}) }, n_trans: adj.n_trans ?? null,
    start_ratio: g(model, "start", "ratio") ?? null, start_n1: g(model, "start", "n1") ?? null, start_up: g(model, "start", "mismatch_up") ?? null,
    vocal_bother_w: g(model, "gates", "evidence", "vocal_bother_w") ?? null, spoken_score: g(model, "gates", "evidence", "spoken_score") ?? null,
    spoken_n: g(model, "gates", "evidence", "spoken_n") ?? null, repetitive_w: g(model, "diversity", "repetitive_sessions_w") ?? null,
  };
}
function policySummary(p, rules) {
  if (!p) return null;
  const band = Number(rules.preference.band);
  return {
    tp: p.tp ?? null, quit_frac: p.quit_frac ?? null, start_offset: p.start_offset ?? 0, hold_radius: p.hold_radius ?? null, hold_order: p.hold_order ?? null,
    mu: p.mu ?? null, lambda: p.lambda ?? null, adj_w: p.adj_w ? { ...p.adj_w } : null, adj_w_bands: p.adj_w ? Object.fromEntries(Object.entries(p.adj_w).map(([k, v]) => [k, v / band])) : null,
    soft_gates: [...(p.soft_gates || [])], artist_cap: p.artist_cap ?? null, exclude_n: p.exclude_ids ? p.exclude_ids.length : null,
    replay_n: (p.replay_ids || []).length, replay_max: p.replay_max ?? null, discovery_u: p.discovery_u ?? null,
    high_stress: !!p.high_stress, stress: p.stress ?? null, digest: p.digest ?? null,
  };
}

/**
 * 세션 하나. 반환 기록은 run.mjs 의 지표 계산이 읽는다.
 * @param o.arm "wp" | "frozen" | "twin"
 * @param o.k   이 저장소에서 몇 번째 세션인가(1부터, P13 은 옛 세션 포함)
 */
export function runSession({ arm, persona, rep, k, at_ms, store, deps, shared, twin, env = "local", h4 = null, capture = null }) {
  const { engine, personal, rules, cat } = deps;
  const index = cat.index, byId = index.byId;
  /* 난수 키·시드는 rng_id(없으면 id) — 내부 대조 P12F 가 P12 와 같은 난수를 쓰게(같은 행동, 재생 길이만 다름) */
  const rid = persona.rng_id || persona.id;
  const rngKey = `${rid}:${rep}:${k}`;
  const seed = SIM.seed_fmt.replace("{persona}", rid).replace("{rep}", rep).replace("{k}", k);
  const plan = planSession(persona, { rngKey, vocab: deps.vocab });
  const T = {};
  const rec0 = { persona: persona.id, rep, k, arm, at_ms, mood: plan.labels.current.chip, goal: plan.labels.target.chip, pace_user: plan.pace_user };

  let final, resR = null, rec, policy = null, refPolicy = null, model = null, fallback = null, safety = null, minutes, fin, nudged, cal = {}, sug = null, extras = { extras: [] };
  let appName;
  if (arm === "twin") {
    appName = "fix-web";
    const nd = {};
    for (const f of ["current", "target"]) nd[f] = decideNudge(persona, f, { label: plan.labels[f].chip, table: plan.table[f], shown: plan.table[f] }, { rngKey, mode: "arrow" });
    fin = { current: nd.current.point, target: nd.target.point };
    nudged = { current: nd.current.nudged, target: nd.target.nudged };
    minutes = store.profile.recommend_minutes || SIM.minutes_default;
    let t = now();
    const tw = twin.recommend(store, { now: fin.current, target: fin.target, minutes, pace_user: plan.pace_user, seed }, at_ms);
    T.runA_ms = now() - t;
    final = tw.result;
    rec = addRec(store, tw.recDoc, at_ms);
  } else {
    appName = "web-personal";
    const raw = toRawFacts(store, { as_of_ms: at_ms, vocab: deps.vocab, rules, env });
    let t = now();
    const norm = personal.normalizeLogs(raw, index, rules);
    model = personal.buildPersonalModel(norm, index, rules, { as_of_ms: at_ms });
    T.model_ms = now() - t;
    const calModel = arm === "frozen" ? personal.emptyModel(rules) : model;
    fin = {}; nudged = {};
    for (const f of ["current", "target"]) {
      /* labels 인자: 명세(§4.1.3·§9.2)가 "그 필드의 라벨"인지 "{current, target} 전체"인지 못 박지 않아 둘 다로 읽히게 넘긴다 */
      const labArg = { ...plan.labels[f], current: plan.labels.current, target: plan.labels.target };
      const r = personal.calibratePoint(calModel, f, labArg, plan.table[f], rules);
      cal[f] = r || null;
      const shown = r && r.point ? { v: Number(r.point.v), e: Number(r.point.e) } : { ...plan.table[f] };
      const nd = decideNudge(persona, f, { label: plan.labels[f].chip, table: plan.table[f], shown }, { rngKey, mode: "drag" });
      fin[f] = nd.point; nudged[f] = nd.nudged;
    }
    const base = Number(model && model.length && model.length.base_minutes) || store.profile.recommend_minutes || SIM.minutes_default;
    if (arm !== "frozen") sug = personal.suggestMinutes(model, base, rules);
    minutes = sug && Number.isFinite(Number(sug.minutes)) ? Number(sug.minutes) : base;
    const stress = typeof personal.stressOf === "function" ? personal.stressOf(fin.current, rules) : stressLocal(fin.current, rules);
    const calib_applied = { current: cal.current ? cal.current.applied ?? null : null, target: cal.target ? cal.target.applied ?? null : null };
    const ctx = {
      now: fin.current, target: fin.target, now_table: plan.table.current, target_table: plan.table.target, labels: plan.labels, nudged,
      minutes, lyric: "no_preference", genres: [], pace_user: plan.pace_user, seed, global_stats: {}, disliked_now: [...store.profile.dislikedSongs], session_no: k,
      calib_applied, minutes_base: base, minutes_suggested: sug && sug.applied ? minutes : null, env,
    };
    t = now();
    const out = personal.resolvePolicy(model, ctx, rules, { mode: arm === "frozen" ? "p0" : "personal" });
    T.policy_ms = now() - t;
    const ref = arm === "frozen" ? out : personal.resolvePolicy(model, ctx, rules, { mode: "p0" });
    policy = out.policy; refPolicy = ref.policy;
    const input = { now: { V: fin.current.v, A: fin.current.e }, target: { V: fin.target.v, A: fin.target.e }, stress, load: null, genres: [],
                    duration_min: minutes, seed, gates: [], user: out.user, pace: plan.pace_user, personal: out.policy };
    t = now();
    const resA = engine.recommend(shared.contract, rules, input);
    T.runA_ms = now() - t;
    const inputR = { ...input, user: ref.user, personal: ref.policy };
    t = now();
    resR = arm === "frozen" ? resA : engine.recommend(shared.contract, rules, inputR);
    T.runR_ms = now() - t;
    safety = personal.safetyCheck(resA, resR, rules);
    final = resA; let finalInput = input, usedPolicy = out.policy, usedOut = out;
    if (safety && safety.ok === false && arm !== "frozen") {
      /* §2.2 7: 경로 모수(tp·s·이탈 가드·r)를 P0 로 되돌린 A′(resolvePolicy mode "geometry") → 다시 확인 → 그래도 위반이면 R */
      const geo = personal.resolvePolicy(model, ctx, rules, { mode: "geometry" });
      const in2 = { ...input, user: geo.user, personal: geo.policy };
      const res2 = engine.recommend(shared.contract, rules, in2);
      const s2 = personal.safetyCheck(res2, resR, rules);
      if (s2 && s2.ok !== false) { final = res2; finalInput = in2; usedPolicy = geo.policy; usedOut = geo; fallback = "geometry"; }
      else { final = resR; finalInput = inputR; usedPolicy = ref.policy; usedOut = ref; fallback = "p0"; }
    }
    const fillRatio = Number(rules.personalization && rules.personalization.extras && rules.personalization.extras.fill_ratio) || 0.85;
    t = now();
    extras = engine.recommendExtras(shared.contract, rules, finalInput, final, { target_sec: minutes * 60 * fillRatio }) || { extras: [] };
    T.extras_ms = now() - t;
    const body = personal.buildRecLog({ ctx, policyOut: out, usedOut, refOut: ref, resA: final, resR, extras, safety, fallback,
                                        env: { app: "web-personal", env }, catalogIndex: index, rules });
    const piGuess = plan.pace_user === "fast" ? 1 : plan.pace_user === "slow" ? -1 : 0;
    /* 속도 버튼을 직접 눌렀으면 pace_choice (§7.2) — 추천 전이라 rec_id 는 직전 추천(없으면 null). 학습은 추천 문서의 pace_user 로 한다 */
    if (plan.pace_user) {
      const prev = store.recs.length ? store.recs[store.recs.length - 1].id : null;
      const auto = model && Math.abs(Number(model.pace && model.pace.pi) || 0) >= Number(rules.personalization.pace.apply_abs) ? Number(model.pace.pi) : 0;
      store.events.push({ id: `${store.uid}-ev${String(++store.n.ev).padStart(6, "0")}`, created_at_ms: at_ms - 30000, rec_id: prev, type: "pace_choice",
                          payload: { app: "web-personal", env, client_id: `${prev}|pace_choice||${k}`, choice: plan.pace_user, suggested: arm === "frozen" ? 0 : auto, source: "user" } });
    }
    rec = addRec(store, fillRecLog(body, { env, fin, minutes, pace_user: plan.pace_user, seed, k, base, suggested: ctx.minutes_suggested, stress,
                                           labels: plan.labels, table: plan.table, calib_applied, nudged, policy: usedPolicy, final, extras, pi_used_guess: piGuess }, store), at_ms);
    policy = usedPolicy;
    /* 픽스처(§11 H2): 같은 RawFacts·as_of·ctx 로 앱(브라우저)이 다시 계산해 digest 를 맞춰 볼 수 있게 — 실행 A(폴백 전) 기준 */
    if (capture) Object.assign(capture, {
      raw, ctx, as_of_ms: at_ms, mode: arm === "frozen" ? "p0" : "personal",
      engine_input: { now: input.now, target: input.target, stress, load: null, genres: [], duration_min: minutes, seed, gates: [], pace: plan.pace_user },
      model_digest: model && model.digest ? model.digest : null, policy_digest: out.policy && out.policy.digest ? out.policy.digest : null,
      sequence: resA.sequence.map((r) => r.song_id), fallback, used_policy_digest: usedPolicy && usedPolicy.digest ? usedPolicy.digest : null,
    });

    /* H4 설명 충실도: p_smooth 행을 adj_w = 0 으로 다시 돌렸을 때 그 걸음 곡 또는 경로가 바뀌나 (표본 예산 안에서) */
    /* 고긴장 세션은 엔진이 전환 비용 하한(I5)을 다시 걸어 adj_w = 0 이 되지 않으므로 뺀다 */
    if (h4 && h4.budget > 0 && usedPolicy && usedPolicy.adj_w && !usedPolicy.high_stress) {
      const rows = final.sequence.map((r, i) => ({ i, id: r.song_id, smooth: r.trace.p_smooth === true })).filter((r) => r.smooth);
      if (rows.length) {
        h4.budget--;
        const pol0 = { ...usedPolicy, adj_w: Object.fromEntries(Object.keys(usedPolicy.adj_w).map((f) => [f, 0])) };
        const res0 = engine.recommend(shared.contract, rules, { ...finalInput, personal: pol0 });
        const ids0 = res0.sequence.map((r) => r.song_id);
        for (const r of rows) h4.cases.push({ persona: persona.id, changed: ids0[r.i] !== r.id || ids0.join() !== final.sequence.map((x) => x.song_id).join() });
      }
    }
  }

  // ── 듣기 ──
  const history = behaviorHistory(store, { truth: plan.truth, minutes, env });
  const recentPrev = history.recent_sessions.slice(0, 3).flat();
  const out = respond(persona, rec, index, { rngKey, history });
  ingest(store, rec, at_ms, out, { app: appName });

  // ── 기록 ──
  const pathIds = final.sequence.map((r) => r.song_id);
  const shape = pathShape(final);
  const pairs = adjPairs(pathIds, byId);
  const pathPlayed = out.played.filter((p) => p.role === "path" && p.exposed);
  const allPlayed = out.played.filter((p) => p.exposed);
  const fav = persona.favored;
  const isFav = (s) => !!fav && (fav.kind === "genre" ? (s.genres || []).includes(fav.value)
    : fav.kind === "instrumental" ? s.instrumental === true
    : fav.kind === "artist" ? String(s.artist || "").split(";").some((a) => a.trim().toLowerCase().replace(/\s+/g, "") === String(fav.value).toLowerCase()) : false);
  const pathSongs = pathIds.map((id) => byId.get(id)).filter(Boolean);
  const refIds = resR ? resR.sequence.map((r) => r.song_id) : null;
  let wpSame = null;
  if (resR && policy && refPolicy && PATH_KEYS.every((key) => (policy[key] ?? null) === (refPolicy[key] ?? null))
      && final.sequence.length === resR.sequence.length) {
    wpSame = final.sequence.every((r, i) => r.trace.wp_V === resR.sequence[i].trace.wp_V && r.trace.wp_A === resR.sequence[i].trace.wp_A);
  }
  const seqRows = rec.sequence || [];
  const ms = modelSummary(model);
  return {
    ...rec0, rec_id: rec.id, minutes, nudged, fin,
    minutes_suggested: sug ? (sug.applied ? sug.minutes : null) : null, sug_applied: sug ? !!sug.applied : null,
    calib_applied: { current: cal.current ? cal.current.applied ?? null : null, target: cal.target ? cal.target.applied ?? null : null },
    n_path: pathIds.length, n_extra: (extras.extras || []).length + (arm === "twin" ? seqRows.filter((r) => r.role === "extra").length : 0),
    path_ids: pathIds, ref_ids: refIds, changed_n: refIds ? pathIds.filter((id) => !refIds.includes(id)).length : null,
    shape: shape && { arrival: shape.arrival, maxJump: shape.maxJump, back: shape.back, turns: shape.turns, holdZig: shape.holdZig, start: shape.start,
                      arrival_index: shape.arrival_index, n: shape.n, hold_ids: shape.hold_ids, last_id: shape.last_id },
    ref_shape: resR && arm !== "twin" ? (() => { const s = pathShape(resR); return s && { arrival: s.arrival, maxJump: s.maxJump }; })() : null,
    wp_same_as_ref: wpSame,
    pairs: { n: pairs.length, bpm: pairs.map((p) => p.bpm), flips: pairs.filter((p) => p.flip).length, flags2: pairs.filter((p) => p.flags >= 2).length },
    exp_path: pathPlayed.length, skip_path: pathPlayed.filter((p) => p.early_skip).length, like_path: pathPlayed.filter((p) => p.liked).length,
    comp_path: pathPlayed.map((p) => p.completion), n_played: out.played.length, exp_all: allPlayed.length, skip_all: allPlayed.filter((p) => p.early_skip).length,
    like_all: allPlayed.filter((p) => p.liked).length, extra_played: out.played.filter((p) => p.role === "extra").length,
    first_skip: (() => { const p = out.played.find((x) => x.role === "path" && x.position === 1); return p ? !!p.early_skip : null; })(),
    E_change: out.latent.E_change, U: out.latent.U, dist_end: out.latent.dist_end, n_T_over: out.latent.n_T_over, pi_used: out.latent.pi_used,
    responded: out.answers.responded, pace_answer: out.answers.pace_answer, length_dir: out.answers.length_dir, codes: out.answers.codes,
    quit: out.quit,
    fav_path: fav ? pathSongs.filter(isFav).length : null,
    spoken_high_path: pathSongs.filter((s) => s.feature_bins && s.feature_bins.spokenness === "high").length,
    spoken_gate_path: pathSongs.filter((s) => Number(s.spokenness) >= shared.spoken_gate_th).length,
    repeats_path: pathIds.filter((id) => recentPrev.includes(id)).length,
    replay_rows: seqRows.filter((r) => r.role === "path" && (r.replay === true || r.p_replay === true)).length
      || final.sequence.filter((r) => r.trace && r.trace.p_replay === true).length,
    discovery_rows: final.sequence.filter((r) => r.trace && r.trace.p_discovery === true).length,
    p_pmarg_abs: (() => { const v = seqRows.filter((r) => r.role === "path" && Number.isFinite(r.p_pmarg)).map((r) => Math.abs(r.p_pmarg)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })(),
    policy: policySummary(policy, rules), ref_policy: refPolicy ? { tp: refPolicy.tp ?? null, hold_radius: refPolicy.hold_radius ?? null } : null,
    params: rec.input && rec.input.personal_meta ? rec.input.personal_meta.params || null : null,
    model: ms, fallback, safety_ok: safety ? safety.ok !== false : null, safety_violations: safety && safety.violations ? [...safety.violations] : [],
    stress: rec.input ? rec.input.stress ?? null : null, timing: T,
  };
}
