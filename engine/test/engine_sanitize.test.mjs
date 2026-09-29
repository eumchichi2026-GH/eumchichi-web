/* sanitizePersonal — 경계(rules.personalization.bounds)·모르는 키 버림·동결·고긴장 재적용(I5).
 *   고긴장(stress ≥ safety.high_stress_min 또는 high_stress:true): 발견 칸 없음 · 자동 tp ≥ 표 값 · 이탈 가드 끔 ·
 *   r ≤ 0.035 · s ≤ 0.075 · 전환 배수 ≥ 1(adj_w ≥ band·base·scale, λ ≥ path.jump_weight). */
import test from "node:test";
import assert from "node:assert/strict";

import * as E from "../engine.js";
import { loadRules, neutralPolicy, p0Policy, makeCatalog, makeRng, randomInputs, clone } from "./engine_fixture.test.mjs";

const rules = loadRules();
const Z = rules.personalization, B = Z.bounds, HS = Z.safety.high_stress;
const band = Number(rules.preference.band);
const S = (p, env = { duration_min: 30 }) => E.sanitizePersonal(p, rules, env);

const KEYS = ["v", "schema", "digest", "model_digest", "stress", "high_stress", "tp", "quit_frac", "start_offset", "start_min_journey",
  "hold_radius", "hold_min_songs", "hold_order", "hold_min_pool", "hold_radius_cap", "hold_cluster", "hold_path_q", "hold_break", "pers_bucket", "pers_jitter", "corridor_bands", "j_move", "j_hold", "mu", "taste_features", "adj_w",
  "bpm_scale", "spoken_scale", "half_double_fold", "bpm_offset", "bpm_per_tag", "lambda", "discovery_u", "soft_gates", "soft_min_pool",
  "artist_cap", "artist_cap_by_key", "exclude_ids", "replay_ids", "replay_max"].sort();

test("정책이 없거나 규칙 스위치가 꺼지면 null (I0 경로)", () => {
  for (const p of [undefined, null, 0, "", "x", [], [{}], true]) assert.equal(S(p), null);
  const off = clone(rules); off.personalization.enabled = false;
  assert.equal(E.sanitizePersonal(p0Policy(rules), off, {}), null);
  const none = clone(rules); delete none.personalization;
  assert.equal(E.sanitizePersonal(p0Policy(rules), none, {}), null);
  assert.ok(E.sanitizePersonal(p0Policy(rules), rules), "env 생략 가능");
});

test("모르는 키는 버리고 정해진 키만, 깊게 동결된 사본", () => {
  const p = { ...p0Policy(rules), evil: 1, __proto__x: 2, sequence: ["S0001"] };
  const s = S(p);
  assert.deepEqual(Object.keys(s).sort(), KEYS);
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.adj_w) && Object.isFrozen(s.exclude_ids) && Object.isFrozen(s.soft_gates));
  assert.throws(() => { s.mu = 9; });
  assert.notEqual(s.exclude_ids, p.exclude_ids, "입력 배열을 그대로 쓰지 않는다");
});

test("빈 정책 {} 은 중립 정책과 같은 값(빠진 필드 = 중립)", () => {
  const a = S({}), b = S(neutralPolicy(rules));
  for (const k of KEYS) if (!["digest"].includes(k)) assert.deepEqual(a[k], b[k], k);
  assert.equal(a.hold_order, "fit"); assert.equal(a.corridor_bands, null); assert.equal(a.j_move, null);
  assert.equal(a.mu, Number(rules.preference.pref_weight)); assert.equal(a.lambda, Number(rules.path.jump_weight));
  assert.equal(a.artist_cap, rules.diversity.max_per_artist); assert.equal(a.exclude_ids, null);
  assert.deepEqual(a.adj_w, { tempo: 0, vocal: 0, spoken: 0, genre: 0 });
});

test("경계로 자른다 — 위·아래 모두", () => {
  const hi = S({
    tp: 3, quit_frac: 5, start_offset: 1, start_min_journey: 9, hold_radius: 1, hold_min_songs: 40, corridor_bands: 7, j_move: 1, j_hold: 1,
    mu: 9, adj_w: { tempo: 1, vocal: 1, spoken: 1, genre: 1 }, bpm_scale: 1000, spoken_scale: 9, lambda: 5, soft_min_pool: 999,
    artist_cap: 99, replay_max: 7, hold_min_pool: 999, pers_bucket: 1, hold_break: 1, pers_jitter: 1,
  });
  assert.equal(hi.tp, B.tp[1]); assert.equal(hi.start_offset, B.start_offset[1]); assert.equal(hi.start_min_journey, B.start_min_journey[1]);
  assert.equal(hi.hold_min_songs, B.hold_min_songs[1]); assert.equal(hi.corridor_bands, B.corridor_bands[1]);
  assert.equal(hi.j_move, B.j_move_bands[1] * band); assert.equal(hi.j_hold, B.j_hold[1]);
  assert.equal(hi.mu, Math.max(Z.taste.mu_max, rules.preference.pref_weight));
  for (const f of ["tempo", "vocal", "spoken", "genre"]) assert.equal(hi.adj_w[f], B.adj_w_bands_each[1] * band);
  assert.equal(hi.bpm_scale, B.bpm_scale[1]); assert.equal(hi.spoken_scale, B.spoken_scale[1]); assert.equal(hi.lambda, B.lambda_max);
  assert.equal(hi.soft_min_pool, B.soft_min_pool[1]); assert.equal(hi.artist_cap, rules.diversity.max_per_artist); assert.equal(hi.replay_max, B.replay_max[1]);
  assert.equal(hi.high_stress, false); assert.equal(hi.hold_radius, B.hold_radius[1]); assert.equal(hi.quit_frac, B.quit_frac[1]);
  assert.equal(hi.hold_min_pool, B.hold_min_pool[1]); assert.equal(hi.pers_bucket, B.pers_bucket_bands[1] * band);
  assert.equal(hi.hold_break, B.j_hold[1]); assert.equal(hi.pers_jitter, B.pers_jitter_bands[1] * band);   // 20260930 — 머묾 J · 흔들기 상한(정리 여유)
  assert.equal(hi.hold_radius_cap, B.hold_radius[1]);   // 밀도 적응 반경 상한 = 팔 최댓값(규칙 값 — 정책이 정하지 않는다)
  // stress 9 → 4 → 고긴장 → 반경·시작점 상한까지 같이 걸린다
  const hs = S({ stress: 9, hold_radius: 1, start_offset: 1, quit_frac: 0.5 });
  assert.equal(hs.stress, B.stress[1]); assert.equal(hs.high_stress, true);
  assert.equal(hs.hold_radius, HS.hold_radius_max); assert.equal(hs.start_offset, HS.start_offset_max); assert.equal(hs.quit_frac, null);
  assert.equal(hs.hold_radius_cap, HS.hold_radius_max);   // 고긴장이면 넓혀도 I5 상한까지

  const lo = S({
    tp: -1, quit_frac: -1, start_offset: -1, start_min_journey: 0, hold_radius: -1, hold_min_songs: 0, corridor_bands: -3, j_move: -1, j_hold: -1,
    mu: -1, adj_w: { tempo: -1, vocal: -1, spoken: -1, genre: -1 }, bpm_scale: 1, spoken_scale: 0, lambda: 0, soft_min_pool: 1,
    artist_cap: 0, replay_max: -2, stress: -5, hold_min_pool: -3, pers_bucket: -1, hold_break: -1, pers_jitter: -1,
  });
  assert.equal(lo.tp, B.tp[0]); assert.equal(lo.quit_frac, B.quit_frac[0]); assert.equal(lo.start_offset, 0); assert.equal(lo.start_min_journey, B.start_min_journey[0]);
  assert.equal(lo.hold_radius, 0); assert.equal(lo.hold_min_songs, B.hold_min_songs[0]); assert.equal(lo.corridor_bands, 0);
  assert.equal(lo.j_move, 0); assert.equal(lo.j_hold, 0); assert.equal(lo.mu, 0);
  for (const f of ["tempo", "vocal", "spoken", "genre"]) assert.equal(lo.adj_w[f], 0);
  assert.equal(lo.bpm_scale, B.bpm_scale[0]); assert.equal(lo.spoken_scale, B.spoken_scale[0]);
  assert.equal(lo.lambda, Math.min(Z.adjacency.lambda_range[0], rules.path.jump_weight));
  assert.equal(lo.soft_min_pool, B.soft_min_pool[0]); assert.equal(lo.artist_cap, 1); assert.equal(lo.replay_max, 0); assert.equal(lo.stress, 0);
  assert.equal(lo.high_stress, false);
  assert.equal(lo.hold_min_pool, 0); assert.equal(lo.pers_bucket, 0); assert.equal(lo.hold_break, 0); assert.equal(lo.pers_jitter, 0);
});

test("숫자가 아닌 값(NaN·Infinity·문자열·객체)은 빠진 것으로 — 중립값", () => {
  const n = S({});
  const bad = S({ tp: NaN, mu: "0.5", lambda: Infinity, hold_radius: "0.05", start_offset: {}, corridor_bands: "1", j_move: NaN, stress: "3",
    adj_w: { tempo: "1", vocal: NaN }, discovery_u: "0.3", artist_cap: null, replay_max: undefined, half_double_fold: "yes", hold_order: 3 });
  for (const k of KEYS) if (k !== "digest") assert.deepEqual(bad[k], n[k], k);
});

test("목록 필드: 문자열 ID 만·중복 제거·앞에서부터 상한", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `S${String(i % 180).padStart(4, "0")}`);
  const s = S({ exclude_ids: [...ids, 3, null, { id: "x" }], replay_ids: ids, soft_gates: ["exclude_spoken", "nope", "exclude_spoken", 7] });
  assert.equal(s.exclude_ids.length, B.exclude_ids_max);
  assert.equal(new Set(s.exclude_ids).size, s.exclude_ids.length);
  assert.deepEqual(s.exclude_ids.slice(0, 3), ["S0000", "S0001", "S0002"]);
  assert.equal(s.replay_ids.length, B.replay_ids_max);
  assert.deepEqual(s.soft_gates, ["exclude_spoken"]);
  assert.equal(S({ exclude_ids: null }).exclude_ids, null);
  assert.deepEqual(S({ exclude_ids: [] }).exclude_ids, []);
  assert.deepEqual(S({ replay_ids: "S0001" }).replay_ids, []);
});

test("taste_features: 올바른 spec 만, 최대 taste_features_max 개, 빈 목록은 null", () => {
  const good = Z.taste.extra_features_available[0];
  const s = S({ taste_features: [good, { id: 1 }, { id: "x", field: "y", bins: 7 }, { ...good, id: "a" }, { ...good, id: "b" }, { ...good, id: "c" }] });
  assert.deepEqual(s.taste_features.map((f) => f.id), ["popularity", "a", "b"].slice(0, B.taste_features_max));
  assert.equal(s.taste_features[0].zero_is_unknown, true);
  assert.equal(S({ taste_features: [] }).taste_features, null);
  assert.equal(S({ taste_features: [{ id: 1 }] }).taste_features, null);
});

test("hold_order 는 열거값만, discovery_u 는 [0, 1) 만", () => {
  for (const o of ["fit", "last_fixed_progress", "last_fixed_smooth"]) assert.equal(S({ hold_order: o }).hold_order, o);
  assert.equal(S({ hold_order: "random" }).hold_order, "fit");
  assert.equal(S({ discovery_u: 0 }).discovery_u, 0);
  assert.equal(S({ discovery_u: 0.999 }).discovery_u, 0.999);
  for (const u of [1, 1.2, -0.01]) assert.equal(S({ discovery_u: u }).discovery_u, null);
});

test("BPM 환산값은 정책이 아니라 규칙에서 채운다", () => {
  const s = S({ bpm_offset: 0, bpm_per_tag: 1 });
  assert.equal(s.bpm_offset, Z.adjacency.bpm_offset); assert.equal(s.bpm_per_tag, Z.adjacency.bpm_per_tag);
});

test("고긴장 재적용(I5): stress ≥ high_stress_min 또는 high_stress:true", () => {
  const atDef = E.transitionAt(rules, 30);
  const hot = { tp: 0.5, quit_frac: 0.3, discovery_u: 0.4, hold_radius: 0.05, start_offset: 0.15, adj_w: { tempo: 0, vocal: 0, spoken: 0, genre: 0 }, lambda: 0.1 };
  for (const extra of [{ stress: Z.safety.high_stress_min }, { stress: 4 }, { high_stress: true }, { high_stress: true, stress: 0 }]) {
    const s = S({ ...hot, ...extra });
    assert.equal(s.high_stress, true);
    assert.equal(s.discovery_u, null, "발견 칸 없음");
    assert.equal(s.tp, atDef, "자동 속도는 표보다 빠를 수 없다");
    assert.equal(s.quit_frac, null, "이탈 가드 끔");
    assert.equal(s.hold_radius, HS.hold_radius_max);
    assert.equal(s.start_offset, HS.start_offset_max);
    for (const [f, b] of Object.entries(Z.adjacency.base_weights_bands))
      assert.ok(Math.abs(s.adj_w[f] - band * b * Z.adjacency.scale * HS.adj_mult_min) < 1e-12, `adj_w.${f} ≥ 기본(배수 ≥ 1)`);
    assert.ok(s.lambda >= rules.path.jump_weight * HS.adj_mult_min);
  }
  // 이미 더 엄격하면 그대로, 더 느린 tp 는 그대로
  const strict = S({ stress: 3, tp: 0.9, adj_w: { tempo: 2 * band, vocal: 2 * band, spoken: 2 * band, genre: 2 * band }, lambda: 0.2, hold_radius: 0.02, start_offset: 0.075 });
  assert.equal(strict.tp, 0.9); assert.equal(strict.adj_w.tempo, 2 * band); assert.equal(strict.lambda, 0.2);
  assert.equal(strict.hold_radius, 0.02); assert.equal(strict.start_offset, 0.075);
  // 고긴장 아님: 그대로
  const calm = S({ ...hot, stress: Z.safety.high_stress_min - 1 });
  assert.equal(calm.high_stress, false); assert.equal(calm.discovery_u, 0.4); assert.equal(calm.tp, 0.5);
  assert.equal(calm.hold_radius, 0.05); assert.equal(calm.start_offset, 0.15); assert.equal(calm.quit_frac, 0.3);
  // 고긴장 tp 하한은 감상 시간별 표 값
  for (const d of [10, 20, 45]) assert.equal(S({ stress: 3, tp: 0.5 }, { duration_min: d }).tp, Math.max(0.5, E.transitionAt(rules, d)));
});

test("이탈 가드: '천천히'를 누른 세션·규칙에서 끈 경우 null", () => {
  assert.equal(S({ quit_frac: 0.4 }, { duration_min: 30, pace: "slow" }).quit_frac, null);
  assert.equal(S({ quit_frac: 0.4 }, { duration_min: 30, pace: "fast" }).quit_frac, 0.4);
  const off = clone(rules); off.personalization.pace.quit_guard.enabled = false;
  assert.equal(E.sanitizePersonal({ quit_frac: 0.4 }, off, {}).quit_frac, null);
});

test("엔진 경로에서도 고긴장이 다시 걸린다 — 정책이 어겨도 결과는 안전 집합 안", () => {
  const catalog = makeCatalog(rules);
  const r = makeRng("hs-engine");
  let n = 0;
  for (let t = 0; t < 30; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: r.pick([20, 30, 45, 60]) };
    const P = { ...p0Policy(rules), stress: 3, tp: 0.5, quit_frac: 0.2, hold_radius: 0.05, start_offset: 0.15, discovery_u: 0.5, mu: 0.5,
                adj_w: { tempo: 0, vocal: 0, spoken: 0, genre: 0 } };
    const res = E.recommend(catalog, rules, { ...inp, personal: P });
    if (!res.sequence.length) continue;
    n++;
    assert.ok(res.personal.tp_used >= E.transitionAt(rules, inp.duration_min) - 1e-12);
    assert.ok(res.personal.hold_radius_used <= HS.hold_radius_max);
    assert.ok(res.personal.start_offset_used <= HS.start_offset_max);
    assert.equal(res.personal.discovery_step, null);
    assert.ok(res.sequence.every((row) => row.trace.p_discovery === false));
    // '빠르게'를 직접 누르면 선언이 이긴다
    const fast = E.recommend(catalog, rules, { ...inp, pace: "fast", personal: P });
    assert.equal(fast.personal.tp_used, Z.pace.manual_tp.fast);
  }
  assert.ok(n > 15);
});
