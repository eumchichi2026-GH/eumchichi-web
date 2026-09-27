/* 정책(§6.5) · 스트레스(§3.5) · 표 좌표 · 안전 확인(§2.2·§11 B) · 로그 문서(§7.1) · 이벤트 모양(§7.2) · 설명(§4.12.3) · 결정성(I7·H1) */
import test from "node:test";
import assert from "node:assert/strict";
import { P, E, RULES, T0, DAY, MIN, VOCAB, lcg, makeCatalog, makeIndex, song, wpRec, fwRec, plays, ev, postChange, rawOf, modelOf, near } from "./personal_harness.test.mjs";

const CAT = makeCatalog(240);
const IDX = makeIndex(CAT);
const LOW = { v: 0.6, e: 0.5 }, HIGH = { v: 0.3, e: 0.72 };
const CHIP = (c) => ({ mode: "chip", chip: c });
const band = RULES.preference.band;
const R9 = (x) => Math.round(x * 1e9) / 1e9;
const ZA = RULES.personalization.adjacency;
const BASE_W = Object.fromEntries(["tempo", "vocal", "spoken", "genre"].map((f) => [f, band * ZA.base_weights_bands[f] * ZA.scale * 1]));   // 엔진과 같은 곱셈 순서

test("stressOf — 앱 deriveStress 와 같은 식, 불안·짜증·답답·걱정 3 · 우울·지침 2 (§3.5)", () => {
  const S = (l) => { const c = VOCAB.mood_chips.find((x) => x[0] === l); return P.stressOf({ v: c[1], e: c[2] }, RULES); };
  assert.deepEqual(["불안해요", "짜증나요", "답답해요", "걱정돼요", "우울해요", "지쳤어요"].map(S), [3, 3, 3, 3, 2, 2]);
  assert.equal(P.stressOf(null, RULES), null);
  assert.equal(P.stressOf({ v: 1, e: 0 }, RULES), 0);
  assert.equal(P.stressOf({ v: 0, e: 1 }, RULES), 4);
});

test("tablePoint — 칩·자연어(강도 가중)·목표·탭", () => {
  assert.deepEqual(P.tablePoint("current", CHIP("불안해요"), VOCAB), { v: 0.3, e: 0.72 });
  assert.deepEqual(P.tablePoint("target", { target: CHIP("차분해지고 싶어요") }, VOCAB), { v: 0.6, e: 0.3 });
  assert.deepEqual(P.tablePoint("current", CHIP("그냥그래요"), VOCAB), { v: 0.5, e: 0.5 });   // 공백 무시(nlByLabel)
  const one = P.tablePoint("current", { mode: "nl", nl: [{ label: "불안해요", intensity: 3 }] }, VOCAB, RULES);
  near(one.v, 0.24); near(one.e, 0.786);
  const two = P.tablePoint("current", { mode: "nl", nl: [{ label: "불안해요", intensity: 2 }, { label: "지쳤어요", intensity: 1 }] }, VOCAB, RULES);
  near(two.v, (0.3 * 2 + 0.38) / 3); near(two.e, (0.72 * 2 + 0.35) / 3);   // 강도 1 은 중립 쪽으로 0.6 배
  const weak = P.tablePoint("current", { mode: "nl", nl: [{ label: "신나요", intensity: 1 }] }, VOCAB, RULES);
  near(weak.v, 0.5 + 0.32 * 0.6); near(weak.e, 0.5 + 0.3 * 0.6);
  assert.deepEqual(P.tablePoint("target", { mode: "nl", nl: "잠들고 싶어요" }, VOCAB), { v: 0.62, e: 0.08 });
  assert.equal(P.tablePoint("current", { mode: "tap" }, VOCAB), null);
  assert.equal(P.tablePoint("current", CHIP("없는말"), VOCAB), null);
  const ext = { ...VOCAB, mood_chips: [...VOCAB.mood_chips, ["극단", 0.0, 1.0]] };
  assert.deepEqual(P.tablePoint("current", { mode: "nl", nl: [{ label: "극단", intensity: 3 }] }, ext, RULES), { v: 0.04, e: 0.96 });   // nlClamp
});

test("neutralPolicy — I1 항등원 값 (§6.5 중립 열), 엔진에 넣어도 곡 순서가 같다", () => {
  const n = P.neutralPolicy(RULES);
  const want = { v: 1, schema: "wp-policy/1", model_digest: null, stress: null, high_stress: false, tp: null, quit_frac: null, start_offset: 0,
                 start_min_journey: 0.15, hold_radius: 0, hold_min_songs: 5, hold_order: "fit", corridor_bands: null, j_move: null, j_hold: null,
                 mu: RULES.preference.pref_weight, taste_features: null, adj_w: { tempo: 0, vocal: 0, spoken: 0, genre: 0 }, bpm_scale: 60, spoken_scale: 0.5,
                 half_double_fold: false, lambda: RULES.path.jump_weight, discovery_u: null, soft_gates: [], soft_min_pool: 24,
                 artist_cap: RULES.diversity.max_per_artist, artist_cap_by_key: false, exclude_ids: null, replay_ids: [], replay_max: 0 };
  for (const [k, v] of Object.entries(want)) assert.deepEqual(n[k], v, k);
  assert.equal(n.digest, P.digest({ ...n, digest: undefined }));
  for (const seed of ["n:1", "n:2", "n:3"]) {
    const inp = { now: { V: 0.3, A: 0.72 }, target: { V: 0.6, A: 0.3 }, duration_min: 30, seed, user: { disliked: [], recent_played: [] } };
    const a = E.recommend(CAT, RULES, inp).sequence.map((x) => x.song_id);
    const b = E.recommend(CAT, RULES, { ...inp, personal: n }).sequence.map((x) => x.song_id);
    assert.deepEqual(b, a, seed);
  }
});

test("P0 — 빈 모델의 resolvePolicy = 기준 실행 R 정책 (§6.5 P0 열, I2)", () => {
  const m = P.emptyModel(RULES);
  const ctx = { now: LOW, target: { v: 0.8, e: 0.8 }, minutes: 30, seed: "u:1" };
  const A = P.resolvePolicy(m, ctx, RULES), R = P.resolvePolicy(m, ctx, RULES, { mode: "p0" });
  assert.equal(A.policy.digest, R.policy.digest);
  const p = R.policy;
  const want = { tp: null, quit_frac: null, start_offset: 0, start_min_journey: 0.15, hold_radius: 0.035, hold_min_songs: 5, hold_order: "last_fixed_progress",
                 corridor_bands: 1, j_move: R9(1.5 * band), j_hold: 0.0125, mu: 0, taste_features: null, lambda: 0.1, discovery_u: null, soft_gates: [],
                 soft_min_pool: 24, artist_cap: 2, artist_cap_by_key: true, replay_ids: [], replay_max: 0, stress: 2, high_stress: false };
  for (const [k, v] of Object.entries(want)) assert.deepEqual(p[k], v, k);
  assert.deepEqual(p.adj_w, BASE_W);
  assert.deepEqual(p.exclude_ids, []);
  // 엔진 sanitizePersonal 이 받아도 값이 그대로다(경계 안)
  const s = E.sanitizePersonal(p, RULES, { duration_min: 30, pace: null });
  for (const k of Object.keys(want)) assert.deepEqual(s[k], p[k], "sanitize " + k);
  assert.deepEqual(s.adj_w, p.adj_w);
  assert.deepEqual(R.explain, []);
  assert.deepEqual(A.explain, []);   // 기본값에서 벗어난 것이 없다
});

test("resolvePolicy — 반환 모양 { policy, user, explain, meta }, 엔진 사용자는 싫어요·최근 창·전체 통계·취향 표", () => {
  const recs = [wpRec("r0", T0, { path: ["S0001", "S0002"] })];
  const events = plays("r0", T0, [{ song: "S0001", c: 1, dur: 30, catalog_s: 200, preview: true }, { song: "S0002", c: 1 }]);
  const { model } = modelOf(rawOf({ recs, events, profile: { dislikedSongs: ["S0100"] }, as_of_ms: T0 + DAY / 3 }), IDX);
  const gs = { S0005: { pos: 5, neg: 5 } };
  const out = P.resolvePolicy(model, { now: LOW, minutes: 30, global_stats: gs, disliked_now: ["S0101"] }, RULES);
  assert.deepEqual(Object.keys(out).sort(), ["explain", "meta", "policy", "user"]);
  assert.deepEqual(Object.keys(out.user).sort(), ["artist_affinity", "disliked", "feature_affinity", "genre_affinity", "global_stats", "like_base", "recent_played", "song_likes"]);
  assert.deepEqual(out.user.disliked, ["S0100", "S0101"]);
  assert.equal(out.user.global_stats, gs);
  assert.deepEqual(out.user.recent_played, ["S0001", "S0002"]);
  assert.equal(out.user.song_likes.S0001.pos, 0.125);                 // 미리듣기 반값
  const ld = out.user.song_likes.S0002.last_days;
  assert.equal(ld, Math.round(ld * 1000) / 1000);                      // 소수 3자리 — 로그 user_affinity 와 같은 값으로 엔진을 돌린다(H3)
  assert.equal(out.meta.schema, "wp-meta/1");
  assert.deepEqual(Object.keys(out.meta.params).sort(), ["artist_cap", "calib", "hold_arm", "lambda", "m", "minutes_bias", "mu", "pi", "pi_used", "recent_window", "soft_gates", "start_arm"]);
  assert.equal(out.meta.policy_digest, out.policy.digest);
  assert.equal(out.meta.model_digest, model.digest);
  const p0 = P.resolvePolicy(model, { now: LOW, minutes: 30 }, RULES, { mode: "p0" });
  assert.deepEqual(p0.user.song_likes, {});                            // 기준 실행 R: 학습값 없음
  assert.deepEqual(p0.user.disliked, ["S0100"]);                       // 비학습 사실은 그대로
});

test("resolvePolicy geometry 모드 — 경로 모수만 P0 로 되돌린다 (§2.2 7단계 A′)", () => {
  const m = structuredClone(P.emptyModel(RULES));
  m.pace.pi = 0.6; m.pace.quit = { f_med: 0.6, n: 6 }; m.start.arm = 0.075; m.hold.arm = 0; m.taste.mu = 0.2; m.taste.E = 5;
  m.gates.soft = ["exclude_spoken"]; m.diversity.artist_cap = 1;
  const ctx = { now: LOW, minutes: 30 };
  const A = P.resolvePolicy(m, ctx, RULES).policy, G = P.resolvePolicy(m, ctx, RULES, { mode: "geometry" }).policy;
  assert.ok(A.tp !== null && A.quit_frac !== null && A.start_offset > 0 && A.hold_radius === 0);
  assert.deepEqual([G.tp, G.quit_frac, G.start_offset, G.hold_radius], [null, null, 0, RULES.personalization.hold.p0_radius]);
  assert.deepEqual([G.mu, G.soft_gates, G.artist_cap], [A.mu, A.soft_gates, A.artist_cap]);
});

test("고긴장 안전 집합 (I5) — 발견 없음 · 자동 가속 없음 · r ≤ 0.035 · s ≤ 0.075 · 배수 ≥ 1, 엔진도 한 번 더 강제", () => {
  const m = structuredClone(P.emptyModel(RULES));
  m.pace.pi = 1; m.start.arm = 0.15; m.hold.arm = 0.05; m.taste.mu = 0.4; m.taste.E = 20;
  for (const f of ["tempo", "vocal", "spoken", "genre", "va"]) { m.adjacency.applied[f] = true; m.adjacency.m[f] = 0.5; }
  const out = P.resolvePolicy(m, { now: HIGH, minutes: 30, seed: "s" }, RULES);
  const p = out.policy;
  assert.equal(p.high_stress, true); assert.equal(p.stress, 3);
  assert.equal(p.discovery_u, null);
  assert.equal(p.tp, null);
  assert.equal(p.hold_radius, 0.035); assert.equal(p.start_offset, 0.075);
  assert.deepEqual(p.adj_w, BASE_W);
  assert.equal(p.lambda, RULES.path.jump_weight);
  const lowOut = P.resolvePolicy(m, { now: LOW, minutes: 30, seed: "s" }, RULES).policy;
  assert.ok(lowOut.discovery_u !== null && lowOut.tp === 0.5 && lowOut.hold_radius === 0.05 && lowOut.start_offset === 0.15);
  const s = E.sanitizePersonal({ ...lowOut, high_stress: true }, RULES, { duration_min: 30 });   // 앱 버그로 고긴장 정책이 느슨하게 와도
  assert.ok(s.hold_radius <= 0.035 && s.start_offset <= 0.075 && s.discovery_u === null && s.tp >= E.transitionAt(RULES, 30));
});

test("suggestMinutes — 5분 단위 반올림, 5~90 범위", () => {
  const m = structuredClone(P.emptyModel(RULES));
  m.length.S = 0; m.length.W = 0;
  assert.deepEqual(P.suggestMinutes(m, 30, RULES), { minutes: 30, bias_log2: 0, applied: false });
  m.length.W = 10; m.length.S = 10 * (Math.log2(8) - 0.5);
  const s = P.suggestMinutes(m, 8, RULES);
  assert.equal(s.applied, true);
  assert.equal(s.minutes, 5);   // 8·2^−0.45 ≈ 5.9 → 5분
  m.length.S = 10 * (Math.log2(90) + 1);
  assert.equal(P.suggestMinutes(m, 90, RULES).minutes, 90);
});

// ── 경로 모양 · 안전 확인 ─────────────────────────────────
const res = (pts, wps) => ({ sequence: pts.map((c, i) => ({ song_id: "Q" + i, trace: { song_V: c[0], song_A: c[1], wp_V: wps[i][0], wp_A: wps[i][1], va_distance: 0 } })) });

test("pathMetrics — 도착 오차·최대 전환·역행·꺾임·머묾 지그재그·첫 곡 거리 (iso_path_quality 정의)", () => {
  const wps = [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.4, 0.4], [0.4, 0.4]];
  const straight = P.pathMetrics(res([[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.41, 0.4], [0.42, 0.4], [0.4, 0.4]], wps), RULES);
  assert.equal(straight.n, 6);
  assert.equal(straight.arrival, 0);
  near(straight.max_jump, Math.hypot(0.11, 0.1), 1e-6);
  assert.equal(straight.reversals, 0);
  assert.equal(straight.hold_zigzag, false);
  assert.equal(straight.start_dist, 0);
  const back = P.pathMetrics(res([[0.1, 0.1], [0.25, 0.25], [0.18, 0.18], [0.4, 0.4], [0.4, 0.41], [0.4, 0.4]], wps), RULES);
  assert.equal(back.reversals, 1);
  assert.ok(back.turns >= 1);
  const zig = P.pathMetrics(res([[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.41, 0.41], [0.43, 0.43]], wps), RULES);
  assert.equal(zig.hold_zigzag, true);
  near(zig.arrival, Math.hypot(0.03, 0.03), 1e-6);
  assert.deepEqual(P.pathMetrics({ sequence: [] }, RULES), { arrival: null, max_jump: null, reversals: 0, turns: 0, n: 0, hold_zigzag: null, start_dist: null });
  /* 명세 §9.2 의 한 인자 호출 pathMetrics(result) — 규칙 파일과 같은 문턱(명세 보충값)으로 같은 결과 */
  for (const pts of [
    [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.41, 0.4], [0.42, 0.4], [0.4, 0.4]],
    [[0.1, 0.1], [0.25, 0.25], [0.18, 0.18], [0.4, 0.4], [0.4, 0.41], [0.4, 0.4]],
    [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.41, 0.41], [0.43, 0.43]],
  ]) assert.deepEqual(P.pathMetrics(res(pts, wps)), P.pathMetrics(res(pts, wps), RULES));
  assert.deepEqual(P.pathMetrics(res([[0, 0]], [[0, 0]])), P.pathMetrics(res([[0, 0]], [[0, 0]]), RULES));
});

test("safetyCheck — 절대 기준을 넘고 '그리고' 기준 R 보다 over_ref 넘게 나쁠 때만 위반", () => {
  const wps = [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]];   // 머묾은 마지막 한 곡
  const mk = (last) => res([[0.1, 0.1], [0.2, 0.2], last], wps);
  const R = mk([0.3, 0.31]);
  assert.deepEqual(P.safetyCheck(mk([0.3, 0.35]), R, RULES).violations, ["arrival"]);        // 0.05 > 0.04 ∧ > 0.01 + 0.012
  assert.deepEqual(P.safetyCheck(mk([0.3, 0.35]), mk([0.3, 0.345]), RULES).violations, []);   // R 도 멀면(0.045) 허용
  assert.deepEqual(P.safetyCheck(mk([0.3, 0.335]), R, RULES).violations, []);               // 0.035 ≤ 0.04
  assert.deepEqual(P.safetyCheck(mk([0.3, 0.35]), null, RULES).violations, ["arrival"]);    // R 이 없으면 절대 기준만
  assert.deepEqual(P.safetyCheck(res([[0.1, 0.1], [0.4, 0.4], [0.3, 0.3]], wps), R, RULES).violations, ["max_jump"]);
  assert.deepEqual(P.safetyCheck(res([[0.1, 0.1], [0.4, 0.4], [0.3, 0.3]], wps), res([[0.1, 0.1], [0.35, 0.4], [0.3, 0.3]], wps), RULES).violations, []);   // R 도 크게 뛰면 허용
  const back = res([[0.1, 0.1], [0.07, 0.07], [0.3, 0.3]], wps);   // 목표에서 0.03 더 멀어짐 — 역행
  assert.ok(P.safetyCheck(back, R, RULES).violations.includes("reversal"));
  assert.ok(!P.safetyCheck(back, back, RULES).violations.includes("reversal"));   // R 도 같은 만큼 역행하면 개인화 탓이 아니다
  const w2 = [[0.25, 0.25], [0.3, 0.3], [0.3, 0.3]];
  assert.deepEqual(P.safetyCheck(res([[0.25, 0.25], [0.3, 0.3], [0.3, 0.32]], w2), null, RULES).violations, ["hold_zigzag"]);
  assert.ok(P.safetyCheck(res([[0.1, 0.1], [0.3, 0.3]], [[0.1, 0.1], [0.3, 0.3]]), R, RULES).violations.includes("short"));
  const same = P.safetyCheck(R, R, RULES);
  assert.equal(same.ok, true);
  assert.deepEqual(Object.keys(same).sort(), ["A", "R", "ok", "violations"]);
});

// ── 실제 엔진으로 한 번의 추천 흐름 (§2.2) + 로그 문서 (§7.1) ─────
function flow({ model, ctx, env = { app: "web-personal", env: "local" }, targetSec = null }) {
  const inputs = (out) => ({ now: { V: ctx.now.v, A: ctx.now.e }, target: { V: ctx.target.v, A: ctx.target.e }, duration_min: ctx.minutes, seed: ctx.seed,
                             pace: ctx.pace_user ?? null, user: out.user, personal: out.policy });
  const A = P.resolvePolicy(model, ctx, RULES), R = P.resolvePolicy(model, ctx, RULES, { mode: "p0" });
  const resA = E.recommend(CAT, RULES, inputs(A)), resR = E.recommend(CAT, RULES, inputs(R));
  const safety = P.safetyCheck(resA, resR, RULES);
  const extras = E.recommendExtras(CAT, RULES, inputs(A), resA, { target_sec: targetSec ?? ctx.minutes * 60 * RULES.personalization.extras.fill_ratio });
  return { A, R, resA, resR, safety, extras, env };
}

test("한 번의 추천 흐름 — A·R 실행, 안전 확인, 더 들을 곡, buildRecLog 문서 모양 (§2.2·§7.1)", () => {
  const liked = ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006"];
  const recs = [wpRec("r0", T0, { path: ["S0010", "S0011"], input: { pace_user: "fast" } })];
  const { model } = modelOf(rawOf({ recs, profile: { likedSongs: liked }, as_of_ms: T0 + DAY }), IDX);
  const ctx = { now: { v: 0.45, e: 0.2 }, target: { v: 0.8, e: 0.85 }, now_table: { v: 0.45, e: 0.2 }, target_table: { v: 0.8, e: 0.85 },
                labels: { current: { mode: "tap" }, target: CHIP("신나고 싶어요") }, nudged: { current: false, target: true }, minutes: 30, lyric: "no_preference",
                genres: [], pace_user: null, seed: "u:2026-09-28:2", session_no: 2, global_stats: {}, minutes_base: 30, minutes_suggested: null,
                global_stats_digest: "gs1", log_extra: { filters: { pool: 10 }, nl_text: null, nl_v2: null } };
  const F = flow({ model, ctx, targetSec: 3600 });   // 경로만으로 30분·0.85 를 넘기므로 더 들을 곡이 나오게 목표를 늘린다
  assert.equal(F.safety.ok, true, F.safety.violations.join());
  assert.equal(F.safety.A.hold_zigzag, false);   // 마지막 곡 고정 + 진행 방향 순 — 지그재그 0
  const doc = P.buildRecLog({ ctx, policyOut: F.A, resA: F.resA, resR: F.resR, extras: F.extras, safety: F.safety, fallback: null, env: F.env,
                              catalogIndex: IDX, rules: RULES, refOut: F.R });
  const inp = doc.input;
  for (const [k, v] of Object.entries({ app: "web-personal", env: "local", seed: "u:2026-09-28:2", session_no: 2, minutes_base: 30, minutes_suggested: null,
                                        relaxed: null, pace_user: null, stress: 2, high_stress: false, lyric_preference: "no_preference", recommend_minutes: 30,
                                        pace_mode: "auto" })) assert.deepEqual(inp[k], v, k);
  assert.deepEqual(inp.effective, { lyric: "no_preference", genres: [], minutes: 30 });
  assert.deepEqual(inp.input_mode, { current: "tap", target: "chip" });
  assert.deepEqual(inp.nudged, { current: false, target: true });
  assert.deepEqual(inp.filters, { pool: 10 });   // 기존 필드는 log_extra 로 그대로
  assert.deepEqual(inp.table_point, { current: { v: 0.45, e: 0.2 }, target: { v: 0.8, e: 0.85 } });
  const pp = inp.personal_policy;
  assert.ok(pp && !Object.isFrozen(pp) && Array.isArray(pp.exclude_ids) && Array.isArray(pp.replay_ids));
  assert.equal(pp.digest, F.A.policy.digest);
  assert.equal(pp.tp, F.A.policy.tp);
  const meta = inp.personal_meta;
  for (const k of ["schema", "personal_version", "engine_version", "rules_hash", "model_digest", "policy_digest", "as_of_ms", "cursor", "evidence", "params", "fallback",
                   "safety", "reference_ids", "changed_n", "explain_codes", "catalog_n", "catalog_digest", "global_stats_digest"]) assert.ok(k in meta, k);
  assert.equal(meta.schema, "wp-meta/1");
  assert.equal(meta.engine_version, E.ENGINE_VERSION);
  assert.equal(meta.fallback, null);
  assert.deepEqual(meta.reference_ids, F.resR.sequence.map((x) => x.song_id));
  const rIds = new Set(meta.reference_ids);
  assert.equal(meta.changed_n, F.resA.sequence.filter((x) => !rIds.has(x.song_id)).length);
  assert.deepEqual(meta.explain_codes, F.A.explain.map((c) => c.id));
  near(meta.params.pi_used, 0.6);
  assert.equal(meta.catalog_n, 240);
  assert.equal(meta.global_stats_digest, "gs1");
  assert.deepEqual(Object.keys(meta.evidence).sort(), ["E", "n_exposures", "n_pace_votes", "n_transitions"]);
  assert.ok(inp.user_affinity && inp.user_affinity.song_likes.S0001);
  // 시퀀스 행
  const n = F.resA.sequence.length;
  const path = doc.sequence.filter((r) => r.role === "path"), extra = doc.sequence.filter((r) => r.role === "extra");
  assert.equal(path.length, n);
  assert.deepEqual(path.map((r) => r.position), Array.from({ length: n }, (_, i) => i + 1));
  for (const k of ["song_id", "position", "role", "fit", "band_size", "chosen_by", "pref_score", "pref_match", "pref_basis", "quadrant", "wp_V", "wp_A", "song_V",
                   "song_A", "phase", "p_pmarg", "p_pers", "p_adj", "p_adj_x", "p_bpm_diff", "p_geo_best", "p_chosen_by", "discovery", "replay", "soft_relaxed"])
    assert.ok(k in path[0], k);
  assert.ok(path.every((r) => r.phase === "move" || r.phase === "hold"));
  assert.equal(path.findIndex((r) => r.phase === "hold") + 1, 5);   // π 0.6 → 5번째 도착
  assert.ok(extra.length > 0 && extra.length === F.extras.extras.length);
  assert.deepEqual(extra.map((r) => r.position), extra.map((_, j) => n + j + 1));
  assert.ok(extra.every((r) => r.phase === "extra" && "p_pers" in r && "p_adj_x" in r));
  const json = JSON.stringify(doc);
  assert.deepEqual(JSON.parse(json), doc);
  assert.ok(json.length < 200 * 1024);
  // 로그 ↔ 정규화 계약: 이 문서를 다시 읽으면 같은 사실이 나온다
  const back = P.normalizeLogs(rawOf({ recs: [{ id: "new", created_at_ms: T0 + 2 * DAY, ...doc }] }), IDX, RULES).sessions[0];
  assert.equal(back.app, "web-personal");
  assert.deepEqual(back.path.map((r) => r.phase), path.map((r) => r.phase));
  assert.deepEqual(back.path.map((r) => r.pmarg), path.map((r) => r.p_pmarg));
  assert.deepEqual(back.used, meta.params);
  assert.equal(back.policy.digest, pp.digest);
  assert.deepEqual(back.input.labels, ctx.labels);
  assert.deepEqual(back.extras.length, extra.length);
});

test("buildRecLog — 익명(정책 없음)과 기준 추천 폴백", () => {
  const ctx = { now: LOW, target: { v: 0.8, e: 0.8 }, labels: { current: CHIP("편안해요"), target: CHIP("신나고 싶어요") }, minutes: 30, seed: "g:1", session_no: 1 };
  const resAnon = E.recommend(CAT, RULES, { now: { V: 0.6, A: 0.5 }, target: { V: 0.8, A: 0.8 }, duration_min: 30, seed: "g:1" });
  const anon = P.buildRecLog({ ctx, resA: resAnon, env: { app: "web-personal", env: "prod" }, rules: RULES });
  assert.equal(anon.input.personal_policy, null);
  assert.equal(anon.input.personal_meta, null);
  assert.equal(anon.input.user_affinity, null);
  assert.equal(anon.input.app, "web-personal");
  assert.equal(anon.input.seed, "g:1");
  assert.deepEqual(anon.input.labels, ctx.labels);
  assert.ok(anon.sequence.every((r) => r.p_pers === null && (r.phase === "move" || r.phase === "hold")));   // 경유지로 구간을 다시 잰다
  // 폴백 p0: R 을 그대로 썼다
  const m = structuredClone(P.emptyModel(RULES)); m.pace.pi = 0.8;
  const F = flow({ model: m, ctx });
  const doc = P.buildRecLog({ ctx, policyOut: F.A, refOut: F.R, resA: F.resR, resR: F.resR, fallback: "p0", safety: { ok: false, violations: ["arrival"], A: null, R: null },
                              rules: RULES, env: { app: "web-personal", env: "local" } });
  assert.equal(doc.input.personal_meta.fallback, "p0");
  assert.equal(doc.input.personal_policy.digest, F.R.policy.digest);
  assert.equal(doc.input.personal_meta.params.pi_used, 0);   // 실제로 쓴 정책의 π — 다음 속도 답의 기준
  assert.equal(doc.input.personal_meta.changed_n, 0);
  assert.deepEqual(doc.input.personal_meta.safety.violations, ["arrival"]);
});

// ── 이벤트 모양 ─────────────────────────────────────────
test("validateEvent — §7.2 이벤트 모양", () => {
  const C = { app: "web-personal", env: "prod", client_id: "r|t|s|1" };
  const exit = { ...C, song_id: "S1", position: 2, queue_pos: 2, role: "path", instance: 1, started: true, listened_s: 120, duration_s: 200, catalog_s: 200,
                 completion: 0.6, preview: false, cause: "next", prev_song_id: "S0", prev_completion: 1, bg_credit_s: 0, seek_fwd_s: 0, liked: false, disliked: false };
  assert.deepEqual(P.validateEvent("track_exit", exit), { ok: true, errors: [] });
  assert.equal(P.validateEvent("track_exit", { ...exit, cause: "autoplay_fail", started: true }).ok, false);
  assert.equal(P.validateEvent("track_exit", { ...exit, cause: "skip" }).ok, false);
  assert.equal(P.validateEvent("track_exit", { ...exit, position: 0 }).ok, false);
  assert.equal(P.validateEvent("track_exit", { ...exit, client_id: undefined }).ok, false);
  assert.equal(P.validateEvent("like", { ...C, song_id: "S1", position: 1, role: "path" }).ok, false);   // on 필수(B13)
  assert.equal(P.validateEvent("like", { ...C, song_id: "S1", on: true, position: 1, role: "path" }).ok, true);
  assert.equal(P.validateEvent("dislike_reason", { ...C, song_id: "S1", reason: "arrival_mismatch", position: 7, role: "path", phase: "hold" }).ok, true);
  assert.equal(P.validateEvent("dislike_reason", { ...C, song_id: "S1", reason: "boring" }).ok, false);
  const pc = { ...C, change: 1, touched: true, pace_answer: "faster", length_dir: null, rec_id: "r", heard: { S1: 120 }, misfit_reasons: ["length"],
               reasons_source: { length: "user" }, ai_codes_removed_by_user: [], note_ai: null };
  assert.equal(P.validateEvent("post_change", pc).ok, true);
  assert.equal(P.validateEvent("post_change", { ...pc, change: 3 }).ok, false);
  assert.equal(P.validateEvent("post_change", { ...pc, pace_answer: "fast" }).ok, false);
  for (const [t, p] of [["pace_choice", { choice: "fast", suggested: 0.6, source: "user" }], ["calib_reset", { field: "current", label: "불안해요" }],
                        ["auto_gate_off", { gate: "exclude_spoken" }], ["personal_reset", { procedure: "pace" }], ["personal_toggle", { on: false }],
                        ["compare_view", { changed_n: 3 }], ["track_skip", { song_id: "S1", direction: "next", position: 2, listened_s: 5, completion: 0.02, started: true }],
                        ["track_complete", { song_id: "S1", position: 1, completion_rate: 1 }], ["sequence_complete", { minutes: 30 }]])
    assert.deepEqual(P.validateEvent(t, { ...C, ...p }), { ok: true, errors: [] }, t);
  assert.equal(P.validateEvent("mystery", { ...C }).ok, false);
  assert.equal(P.validateEvent("like", null).ok, false);
});

// ── 설명 ────────────────────────────────────────────────
function richModel() {
  const m = structuredClone(P.emptyModel(RULES));
  m.pace.pi = 0.6; m.counts_for_explain.pace = { fast: 1, slow: 0, faster: 1, ok: 0, slower: 0 };
  m.adjacency.applied.tempo = true; m.adjacency.m.tempo = 1.7; m.adjacency.m_applied.tempo = 1.7;
  m.counts_for_explain.adjacency.tempo = { large_n: 8, large_y: 4, small_n: 10, small_y: 1 };
  m.taste.E = 7; m.taste.mu = 0.5 * 7 / 15;
  m.counts_for_explain.taste = { likes: 4, completes: 3, skips: 1, pins_song: 0, pins_artist: 0, n_items: 8,
                                 groups: { p0: 0.5, top: [{ kind: "genre", key: "재즈", label: "재즈", score: 0.7, likes: 4, completes: 3, skips: 0, pins: 0, dislikes: 0 }], bottom: [] } };
  m.gates.soft = ["exclude_spoken"]; m.gates.evidence.vocal_bother_w = 2;
  m.hold.arm = 0.02;
  return m;
}

test("explainPolicy — 칩 ≤ 3, 기본값에서 벗어난 것만, 고정 우선순위, 횟수로 말한다", () => {
  const m = richModel();
  const out = P.resolvePolicy(m, { now: LOW, minutes: 30, seed: "e:1" }, RULES);
  assert.deepEqual(out.explain.map((c) => c.id), ["pace", "adjacency", "taste"]);
  assert.equal(out.explain[0].text, "빠르게 도착 · 5번째 곡 (‘빠르게’ 1번 · ‘더 빨리’ 1번 기준)");
  assert.match(out.explain[1].text, /빠르기 흐름을 1\.7배 신경 써서 이어요 \(크게 바뀐 뒤 8번 중 4번 넘김\)/);
  assert.equal(out.explain[2].text, "재즈 취향 반영 (좋아요 4 · 끝까지 3)");
  assert.deepEqual(out.explain.map((c) => c.procedure), ["pace", "adjacency", "taste"]);
  assert.deepEqual(out.meta.explain_codes, ["pace", "adjacency", "taste"]);
  // 시작점·좌표 보정이 있으면 연결보다 앞선다
  m.start.arm = 0.075; m.counts_for_explain.start = { first_n: 5, first_rej: 3 };
  const withStart = P.explainPolicy(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy, m, RULES);
  assert.deepEqual(withStart.map((c) => c.id), ["pace", "start", "adjacency"]);
  assert.match(withStart[1].text, /첫 곡 5번 중 3번/);
  assert.match(withStart[0].text, /^빠르게 도착 \(/);   // ctx 가 없으면 도착 곡 번호 없이
  // 게이트·머묾만 벗어났으면 그것만
  const m2 = structuredClone(P.emptyModel(RULES)); m2.gates.soft = ["exclude_spoken"]; m2.gates.evidence.vocal_bother_w = 2; m2.hold.arm = 0.02;
  const e2 = P.resolvePolicy(m2, { now: LOW, minutes: 30 }, RULES).explain;
  assert.deepEqual(e2.map((c) => c.id), ["gate_spoken", "hold"]);
  assert.match(e2[0].text, /‘가사·목소리가 거슬려요’ 2번/);
  assert.deepEqual(P.explainPolicy(P.neutralPolicy(RULES), P.emptyModel(RULES), RULES), []);
  assert.deepEqual(P.explainPolicy(null, m, RULES), []);
});

test("explainPolicy — 이번에 고른 단어에 좌표 보정이 걸렸을 때", () => {
  const recs = [0, 1, 2].map((k) => wpRec("c" + k, T0, { path: ["S0001"], input: { current_va: { v: 0.3, e: 0.62 }, nudged: { current: true, target: false } } }));
  const { model } = modelOf(rawOf({ recs, as_of_ms: T0 }), IDX);
  const ctx = { now: { v: 0.3, e: 0.643 }, now_table: { v: 0.3, e: 0.72 }, labels: { current: CHIP("불안해요"), target: CHIP("차분해지고 싶어요") },
                target_table: { v: 0.6, e: 0.3 }, minutes: 30 };
  const out = P.resolvePolicy(model, ctx, RULES);
  assert.equal(out.explain[0].id, "calib_current");
  assert.equal(out.explain[0].text, "‘불안해요’ 내 기준 위치로 (활력 −0.08 · 직접 옮김 3번)");
  assert.deepEqual(out.meta.params.calib.current, { label: "불안해요", dv: 0, de: -0.077143 });
  assert.equal(out.meta.params.calib.target, null);
});

test("explainModel — 카드 11장, 빈 모델은 모두 '기본값', 추이·바뀜 표시 (§4.12.3)", () => {
  const ids = ["calib_current", "calib_target", "pace", "start", "length", "hold", "taste", "adjacency", "gates", "diversity", "discovery"];
  const empty = P.explainModel(P.emptyModel(RULES), RULES);
  assert.deepEqual(empty.map((c) => c.id), ids);
  for (const c of empty) {
    for (const k of ["id", "title", "text", "evidence", "confidence", "is_default", "changed", "series", "reset_procedure"]) assert.ok(k in c, c.id + "." + k);
    assert.equal(c.is_default, true, c.id);
    assert.equal(c.confidence, 1, c.id);
    assert.ok(c.text.length > 0);
  }
  const m = richModel();
  const hist = [{ rec_id: "a", at_ms: T0, params: { pi: 0, mu: 0.1, hold_arm: 0.035, start_arm: 0, minutes_bias: 0, m: { tempo: 1, vocal: 1, spoken: 1, genre: 1, va: 1 },
                                                    soft_gates: [], artist_cap: 2, recent_window: 60 } },
                { rec_id: "b", at_ms: T0 + DAY, params: { pi: 0.3, mu: 0.2, hold_arm: 0.035, start_arm: 0, minutes_bias: 0, m: { tempo: 1, vocal: 1, spoken: 1, genre: 1, va: 1 },
                                                          soft_gates: [], artist_cap: 2, recent_window: 60 } }];
  const cards = Object.fromEntries(P.explainModel(m, RULES, { history: hist }).map((c) => [c.id, c]));
  assert.equal(cards.pace.is_default, false);
  assert.equal(cards.pace.changed, true);
  assert.deepEqual(cards.pace.series.map((x) => x.value), [0, 0.3]);
  assert.match(cards.pace.text, /자동\(나에게 맞춤\): 빠르게 — ‘빠르게’ 1번 · ‘더 빨리’ 1번 기준/);
  assert.equal(cards.hold.is_default, false);
  assert.equal(cards.hold.changed, true);
  assert.match(cards.taste.text, /취향 반영 강도: .+ \(기록 8곡\)/);
  assert.deepEqual(cards.taste.detail.top, ["재즈 · 좋아요 4 · 끝까지 들음 3"]);
  assert.equal(cards.gates.is_default, false);
  assert.equal(cards.adjacency.is_default, false);
  assert.equal(cards.calib_current.is_default, true);
  assert.equal(cards.calib_current.changed, false);
  assert.equal(cards.pace.reset_procedure, "pace");
  assert.ok(cards.taste.confidence >= 2 && cards.taste.confidence <= 5);
});

// ── 결정성 · digest ─────────────────────────────────────
function richRaw() {
  const r = lcg(9), recs = [], events = [];
  for (let k = 0; k < 12; k++) {
    const at = T0 + k * DAY, id = (k % 3 ? "w" : "f") + k;
    const ids = Array.from({ length: 8 }, () => "S" + String(Math.floor(r() * 240)).padStart(4, "0"));
    if (k % 3) {
      recs.push(wpRec(id, at, { path: ids, holdFrom: 6, input: { pace_user: k === 4 ? "fast" : null, personal_meta: { params: { pi_used: 0 } } } }));
      events.push(...plays(id, at, ids.map((s) => ({ song: s, c: Math.round(r() * 100) / 100, listened: Math.round(r() * 200) }))));
      events.push(postChange(id, at + 30 * MIN, { pace_answer: ["faster", "ok", null][k % 3], reasons: k % 4 ? {} : { too_repetitive: "user" }, positions: [7] }));
    } else {
      recs.push(fwRec(id, at, { path: ids }));
      events.push(ev(null, at + MIN, "track_complete", { song_id: ids[0], completion_rate: 1 }));
    }
  }
  return rawOf({ recs, events, profile: { likedSongs: ["S0003", "S0004"], playlists: ["S0005"], dislikedSongs: ["S0006"] }, as_of_ms: T0 + 13 * DAY });
}

test("결정성 — 같은 (RawFacts, as_of_ms, ctx, seed) 100회 → 모델·정책 digest·로그 문서 100% 동일 (I7·H1)", () => {
  const raw = richRaw();
  const ctx = { now: LOW, target: { v: 0.8, e: 0.8 }, minutes: 30, seed: "u:2026-09-28:1", labels: { current: CHIP("편안해요"), target: CHIP("신나고 싶어요") } };
  const once = () => {
    const { model } = modelOf(structuredClone(raw), IDX);
    const out = P.resolvePolicy(model, ctx, RULES);
    return model.digest + "|" + out.policy.digest + "|" + P.digest(P.buildRecLog({ ctx, policyOut: out, rules: RULES, env: { app: "web-personal", env: "local" } }));
  };
  const first = once();
  for (let i = 0; i < 99; i++) assert.equal(once(), first);
  assert.match(first, /^[0-9a-f]{8}\|[0-9a-f]{8}\|[0-9a-f]{8}$/);
  // 기준 시각이 바뀌면(감쇠) 모델도 바뀐다
  assert.notEqual(modelOf(raw, IDX, RULES, raw.as_of_ms + 30 * DAY).model.digest, modelOf(raw, IDX).model.digest);
  assert.equal(P.emptyModel(RULES).digest, P.emptyModel(RULES).digest);
});

test("digest — 키 순서와 무관한 fnv1a32 hex 8자리", () => {
  assert.equal(P.digest({ a: 1, b: [1, { c: 2, d: null }] }), P.digest({ b: [1, { d: null, c: 2 }], a: 1 }));
  assert.notEqual(P.digest({ a: 1 }), P.digest({ a: 2 }));
  assert.equal(P.digest({ a: 1, u: undefined }), P.digest({ a: 1 }));
  assert.match(P.digest([]), /^[0-9a-f]{8}$/);
  assert.equal(P.digest("x"), E.fnv1a32('"x"').toString(16).padStart(8, "0"));
});

test("성능 — 추천 100·이벤트 1,200 모델 빌드 (H5 목표 ≤ 50ms)", (t) => {
  const r = lcg(3), recs = [], events = [];
  for (let k = 0; k < 100; k++) {
    const at = T0 + k * DAY / 3, id = "p" + k;
    const ids = Array.from({ length: 12 }, () => "S" + String(Math.floor(r() * 240)).padStart(4, "0"));
    recs.push(wpRec(id, at, { path: ids.slice(0, 9), extras: ids.slice(9), holdFrom: 6 }));
    events.push(...plays(id, at, ids.slice(0, 11).map((s, i) => ({ song: s, pos: i + 1, role: i < 9 ? "path" : "extra", c: Math.round(r() * 100) / 100, listened: 30 + Math.round(r() * 150) }))));
    events.push(postChange(id, at + 60 * MIN, { pace_answer: "ok" }));
  }
  const raw = rawOf({ recs, events, as_of_ms: T0 + 40 * DAY });
  assert.equal(raw.events.length, 1200);
  modelOf(raw, IDX);   // 준비(JIT)
  const t0 = performance.now();
  const N = 5;
  for (let i = 0; i < N; i++) modelOf(raw, IDX);
  const ms = (performance.now() - t0) / N;
  const t1 = performance.now();
  const { model } = modelOf(raw, IDX);
  for (let i = 0; i < 20; i++) P.resolvePolicy(model, { now: LOW, minutes: 30, seed: "x" + i }, RULES);
  const msPol = (performance.now() - t1 - ms) / 20;
  t.diagnostic(`모델 빌드 ${ms.toFixed(1)}ms · resolvePolicy ${Math.max(0, msPol).toFixed(2)}ms`);
  assert.ok(ms < 250, `모델 빌드 ${ms}ms`);   // 시험 기계 편차를 감안한 느슨한 상한 — 목표 50ms 는 진단 출력으로 본다
});

test("무작위 기록 60개 — 정규화→모델→정책→엔진 A/R→안전 확인→로그→재정규화가 오류 없이 돌고, 정책은 sanitizePersonal 의 고정점", () => {
  const causes = ["complete", "next", "prev", "jump", "new_rec", "pagehide", "session_end", "autoplay_fail"];
  const reasons = ["path_jump", "not_my_taste", "mood_mismatch", "vocal_bother", "too_repetitive", "arrival_mismatch", "length"];
  const moods = VOCAB.mood_chips.map((c) => c[0]), goals = VOCAB.goal_chips.map((c) => c[0]);
  for (let u = 0; u < 60; u++) {
    const r = lcg(1000 + u), pick = (a) => a[Math.floor(r() * a.length)];
    const recs = [], events = [];
    const nS = 1 + Math.floor(r() * 8);
    for (let k = 0; k < nS; k++) {
      const at = T0 + k * DAY * r() * 3 + k * MIN, id = "u" + u + "r" + k;
      const ids = Array.from({ length: 3 + Math.floor(r() * 7) }, () => "S" + String(Math.floor(r() * 240)).padStart(4, "0"));
      const mName = pick(moods), gName = pick(goals);
      const mood = VOCAB.mood_chips.find((c) => c[0] === mName), goal = VOCAB.goal_chips.find((c) => c[0] === gName);
      const nud = r() < 0.4;
      if (r() < 0.3) recs.push(fwRec(id, at, { path: ids, input: { current_va: { v: mood[1], e: mood[2] }, pace_mode: pick(["auto", "fast", "slow"]) } }));
      else recs.push(wpRec(id, at, { path: ids.map((s) => ({ id: s, pmarg: Math.round((r() - 0.5) * 100) / 100, discovery: r() < 0.1, replay: r() < 0.1 })),
        holdFrom: 1 + Math.floor(r() * ids.length), input: {
          labels: { current: CHIP(mood[0]), target: CHIP(goal[0]) }, table_point: { current: { v: mood[1], e: mood[2] }, target: { v: goal[1], e: goal[2] } },
          current_va: { v: mood[1] + (nud ? (r() - 0.5) * 0.2 : 0), e: mood[2] }, target_va: { v: goal[1], e: goal[2] }, nudged: { current: nud, target: false },
          pace_user: pick([null, null, "fast", "slow"]), personal_meta: { params: { pi_used: Math.round((r() - 0.5) * 100) / 50 } } } }));
      const played = ids.slice(0, Math.floor(r() * ids.length) + 1).map((s) => ({ song: s, c: Math.round(r() * 100) / 100, cause: pick(causes), listened: Math.round(r() * 200) }));
      if (recs.at(-1).input.app === "web-personal") events.push(...plays(id, at, played));
      else for (const p of played) events.push({ id: id + p.song + r(), created_at_ms: at + MIN, rec_id: r() < 0.2 ? null : id, type: pick(["track_complete", "track_skip", "track_autoplay_failed", "track_milestone"]),
                                                payload: { song_id: p.song, completion_rate: p.c, direction: pick(["next", "prev", "jump"]), milestone: pick([25, 50, 75]) } });
      if (r() < 0.5) events.push(ev(id, at + 40 * MIN, "dislike_reason", { song_id: pick(ids), reason: pick(reasons), position: 1 + Math.floor(r() * ids.length) }));
      if (r() < 0.6) { const rs = {}; for (const x of reasons) if (r() < 0.2) rs[x] = pick(["user", "ai"]);
        events.push(postChange(id, at + 50 * MIN, { change: pick([-2, -1, 0, 1, 2]), pace_answer: pick([null, "faster", "ok", "slower"]), length_dir: pick([null, "long", "short"]), reasons: rs, positions: r() < 0.5 ? [1 + Math.floor(r() * 3)] : undefined })); }
    }
    const raw = rawOf({ recs, events, profile: { likedSongs: ["S0001", "S0002"].slice(0, u % 3), dislikedSongs: u % 4 ? [] : ["S0003"], favorite_tracks: u % 5 ? [] : ["S0004"] },
                        as_of_ms: T0 + 30 * DAY });
    const { model } = modelOf(raw, IDX);
    const mood = pick(VOCAB.mood_chips), goal = pick(VOCAB.goal_chips);
    const ctx = { now: { v: mood[1], e: mood[2] }, target: { v: goal[1], e: goal[2] }, now_table: { v: mood[1], e: mood[2] }, target_table: { v: goal[1], e: goal[2] },
                  labels: { current: CHIP(mood[0]), target: CHIP(goal[0]) }, minutes: pick([10, 15, 20, 30, 45, 60]), pace_user: pick([null, null, "fast", "slow"]), seed: "fz:" + u };
    for (const mode of ["personal", "p0", "geometry"]) {
      const out = P.resolvePolicy(model, ctx, RULES, { mode });
      const s = E.sanitizePersonal(out.policy, RULES, { duration_min: ctx.minutes, pace: ctx.pace_user });
      for (const k of Object.keys(out.policy)) if (k !== "schema") assert.deepEqual(s[k], out.policy[k], `u${u} ${mode} ${k}`);
      assert.ok(out.explain.length <= 3);
    }
    const F = flow({ model, ctx });
    const doc = P.buildRecLog({ ctx, policyOut: F.A, refOut: F.R, resA: F.resA, resR: F.resR, extras: F.extras, safety: F.safety, env: F.env, catalogIndex: IDX, rules: RULES });
    const back = P.normalizeLogs(rawOf({ recs: [...recs, { id: "new" + u, created_at_ms: T0 + 31 * DAY, ...doc }], events }), IDX, RULES);
    assert.equal(back.sessions.at(-1).app, "web-personal");
    assert.equal(P.explainModel(model, RULES).length, 11);
  }
});
