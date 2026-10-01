/* §3.8 개인 비용의 결합 제한 — 코리도어 정리 (I6, 수용 기준 B7).
 *   이동: J = 1.5·band, corridor_bands = 1 이면 bandIdx ≥ bestBand + 2 인 후보의 key 는 최선 밴드 모든 후보의 key 보다 크다.
 *   머묾: 반경 r > J 이고 반경 안 후보가 있으면, 반경 밖 후보는 선택 키에서 반경 안 후보를 이기지 못한다.
 *   (1) 엔진의 personalKey 로 무작위 후보 목록·μ·배수 10만 조합 — 위반 0.
 *   (2) 실제 recommend(탐욕 1폭 규칙 사본)에서 매 걸음 고른 곡이 기하 최선곡(p_geo_best)보다 한 밴드 넘게 나쁘지 않은지. */
import test from "node:test";
import assert from "node:assert/strict";

import * as E from "../engine.js";
import { loadRules, makeCatalog, makeRng, randomInputs, randomPolicy, clone } from "./engine_fixture.test.mjs";

const rules = loadRules();
const band = Number(rules.preference.band);
const Z = rules.personalization;
const R9 = (x) => Math.round(x * 1e9) / 1e9;

/* 무작위 후보 한 무리 — 정책은 sanitizePersonal 을 거친 실제 모양 */
function randomPolicyFor(r, spec) {
  const raw = {
    mu: r() * 0.6, lambda: 0.1,
    adj_w: { tempo: r() * 2.2 * band, vocal: r() * 2.2 * band, spoken: r() * 2.2 * band, genre: r() * 2.2 * band },
    corridor_bands: spec ? Z.safety.corridor_bands : r.pick([0, 0.5, 1, 1.5, 2]),
    j_move: spec ? Z.safety.j_move_bands * band : r() * Z.safety.j_move_bands * band,
    j_hold: spec ? Z.safety.j_hold : r() * Z.safety.j_hold,
    /* 개인 비용 양자화(2026-09-29) — 없음·규칙 값·경계 안 아무 값. 0 쪽 자름이라 두 정리가 그대로 성립해야 한다 */
    ...(r.chance(0.25) ? {} : { pers_bucket: r.chance(0.5) ? Z.safety.pers_bucket_bands * band : r() * Z.bounds.pers_bucket_bands[1] * band }),
    /* 개인 비용 흔들기(2026-09-29) — 없음·규칙 값·경계 안 아무 값. pj ∈ [0, pers_jitter) 를 키에 더해도 두 정리가 성립해야 한다(경계 상한까지) */
    ...(r.chance(0.3) ? {} : { pers_jitter: r.chance(0.5) ? Z.safety.pers_bucket_bands * band : r() * Z.bounds.pers_jitter_bands[1] * band }),
  };
  return E.sanitizePersonal(raw, rules, { duration_min: 30 });
}
function randomCands(r, P, arrival, rEff) {
  const m = r.int(1, 14);
  const off = r.int(0, 8);
  const cs = Array.from({ length: m }, () => {
    const x = { tempo: r.chance(0.2) ? 0 : r(), vocal: r.chance(0.7) ? 0 : 1, spoken: r(), genre: r.chance(0.6) ? 0 : 1 };
    let adj = 0;
    for (const f of Object.keys(x)) adj += P.adj_w[f] * x[f];
    const first = r.chance(0.1);   // 첫 곡은 앞 곡이 없어 전환 0
    const fit = arrival ? R9(r() * 0.15) : R9((off + r() * 6) * band);
    return { fit, bandIdx: Math.floor(fit / band), pmarg: R9(r() * 2 - 1), adj: first ? 0 : R9(adj) };
  });
  const bestBand = Math.min(...cs.map((c) => c.bandIdx));
  const disc = r.chance(0.1);
  for (const c of cs) {
    c.distCost = arrival ? (c.fit <= rEff ? 0 : c.fit) : c.bandIdx * band;
    c.pj = P.pers_jitter > 0 ? R9(P.pers_jitter * r()) : 0;   // 엔진과 같이 지터 [0, 1) × 폭
    Object.assign(c, E.personalKey({ distCost: c.distCost, fit: c.fit, bandIdx: c.bandIdx, bestBand, arrival, rEff, taste: disc ? 0 : P.mu * c.pmarg, adj: c.adj, pj: c.pj }, P));
  }
  return { cs, bestBand };
}

test("정리(이동): 10만 조합 — 최선 밴드 + 2 이상은 최선 밴드 어떤 후보도 못 이긴다", () => {
  const r = makeRng("corridor-move");
  let violations = 0, checked = 0;
  for (let t = 0; t < 100000; t++) {
    const P = randomPolicyFor(r, true);
    const { cs, bestBand } = randomCands(r, P, false, 0);
    const bestMax = Math.max(...cs.filter((c) => c.bandIdx === bestBand).map((c) => c.key));
    for (const c of cs) {
      assert.ok(Math.abs(c.pers) <= P.j_move + 1e-12, "|pers| ≤ J");
      if (c.pers < 0) assert.ok(c.bonusOK, "가점은 코리도어 안에서만");
      if (c.bandIdx >= bestBand + 2) { checked++; if (!(c.key > bestMax)) violations++; }
    }
  }
  assert.equal(violations, 0);
  assert.ok(checked > 100000, `검사한 밖 후보 ${checked}`);
});

test("정리(이동, 일반형): corridor·J 가 경계 안 아무 값이어도 bandIdx ≥ bestBand + max(2, ⌊c⌋+1) 은 못 이긴다", () => {
  const r = makeRng("corridor-move-general");
  let violations = 0;
  for (let t = 0; t < 30000; t++) {
    const P = randomPolicyFor(r, false);
    const { cs, bestBand } = randomCands(r, P, false, 0);
    const bestMax = Math.max(...cs.filter((c) => c.bandIdx === bestBand).map((c) => c.key));
    const lim = bestBand + Math.max(2, Math.floor(P.corridor_bands) + 1);
    for (const c of cs) if (c.bandIdx >= lim && !(c.key > bestMax)) violations++;
  }
  assert.equal(violations, 0);
});

test("정리(머묾): 10만 조합 — 반경 r > J 이고 반경 안 후보가 있으면 반경 밖은 못 이긴다", () => {
  const r = makeRng("corridor-hold");
  let violations = 0, checked = 0;
  const arms = Z.hold.arms.filter((a) => a > Z.safety.j_hold);
  for (let t = 0; t < 100000; t++) {
    const P = randomPolicyFor(r, true);
    const rEff = r.pick(arms);
    const { cs } = randomCands(r, P, true, rEff);
    const inside = cs.filter((c) => c.fit <= rEff), outside = cs.filter((c) => c.fit > rEff);
    for (const c of cs) {
      assert.ok(Math.abs(c.pers) <= P.j_hold + 1e-12);
      if (c.pers < 0) assert.ok(c.fit <= rEff, "머묾 가점은 반경 안에서만");
    }
    if (!inside.length || !outside.length) continue;
    const inMax = Math.max(...inside.map((c) => c.key));
    for (const c of outside) { checked++; if (!(c.key > inMax)) violations++; }
  }
  assert.equal(violations, 0);
  assert.ok(checked > 50000, `검사한 밖 후보 ${checked}`);
});

test("정리(머묾): r = 0 이면 가점 없음 — 감점만 j_hold 까지", () => {
  const r = makeRng("corridor-hold0");
  for (let t = 0; t < 20000; t++) {
    const P = randomPolicyFor(r, true);
    const { cs } = randomCands(r, P, true, 0);
    for (const c of cs) { assert.ok(c.pers >= 0 || c.fit <= 0); assert.ok(c.pers <= P.j_hold + 1e-12); }
  }
});

test("양자화(pers_bucket) — 0 쪽으로 자른다: |pers| 는 커지지 않고 부호가 같으며 칸 폭의 정수배, 칸보다 작으면 0 (흔들기 모드면 머묾 걸음만)", () => {
  const r = makeRng("corridor-bucket");
  for (let t = 0; t < 20000; t++) {
    const P = randomPolicyFor(r, true);
    const Q = { ...P, pers_bucket: null };
    const arrival = r.chance(0.5);
    const x = { distCost: r.int(0, 5) * band, fit: r() * 0.1, bandIdx: 2, bestBand: r.int(0, 3), arrival, rEff: r.pick([0, 0.035]),
                taste: (r() - 0.5) * 0.08, adj: r() * 0.03 };
    const a = E.personalKey(x, P), b = E.personalKey(x, Q);
    assert.ok(Math.abs(a.pers) <= Math.abs(b.pers) + 1e-12, "|pers| 가 커지지 않는다");
    assert.ok(a.pers === 0 || Math.sign(a.pers) === Math.sign(b.pers), "부호 유지");
    assert.equal(a.bonusOK, b.bonusOK);
    if (P.pers_bucket > 0 && P.pers_jitter > 0 && !arrival) assert.equal(a.pers, b.pers, "흔들기 모드의 이동 걸음은 자르지 않는다");
    else if (P.pers_bucket > 0) {
      const q = Math.round(a.pers / P.pers_bucket);
      assert.ok(Math.abs(a.pers - q * P.pers_bucket) <= 1e-9, "칸 폭의 정수배(R9 반올림 안)");
      if (Math.abs(b.pers) < P.pers_bucket - 1e-9) assert.equal(a.pers, 0, "칸보다 작은 차이는 0");
    } else assert.equal(a.pers, b.pers);
  }
});

test("흔들기(pers_jitter, 20260929) — key = R9(distCost + clamp(자르기 전 값 + pj, −J, J)) (머묾은 양자화한 값 + pj), pj 는 pers(기록)에 들어가지 않고 폭이 없으면 이전 키와 같다", () => {
  const r = makeRng("corridor-jitter");
  for (let t = 0; t < 20000; t++) {
    const P = randomPolicyFor(r, true);
    const arrival = r.chance(0.5);
    const x = { distCost: r.int(0, 5) * band, fit: r() * 0.1, bandIdx: 2, bestBand: r.int(0, 3), arrival, rEff: r.pick([0, 0.035]),
                taste: (r() - 0.5) * 0.08, adj: r() * 0.03 };
    const pj = P.pers_jitter > 0 ? R9(P.pers_jitter * r()) : 0;
    const a = E.personalKey({ ...x, pj }, P), b = E.personalKey(x, P);
    assert.equal(a.pers, b.pers, "pj 는 pers 를 바꾸지 않는다");
    const J = arrival ? P.j_hold : P.j_move;
    let raw = x.taste + x.adj; if (!a.bonusOK && raw < 0) raw = 0;
    let kp = R9((arrival && P.pers_bucket > 0 ? a.pers : raw) + pj); if (!a.bonusOK && kp < 0) kp = 0;
    kp = R9(Math.max(-J, Math.min(J, kp)));
    assert.equal(a.key, pj > 0 && kp !== a.pers ? R9(x.distCost + kp) : b.key);
    assert.ok(a.pj >= 0 && (!(P.pers_jitter > 0) ? a.pj === 0 : a.pj < P.pers_jitter + 1e-12), "실제로 더해진 몫 ∈ [0, 폭)");
    assert.ok(Math.abs(R9(a.pers + a.pj)) <= J + 1e-12, "흔든 뒤에도 |pers + pj| ≤ J");
    const none = E.personalKey({ ...x, pj }, { ...P, pers_jitter: null });
    assert.equal(none.pj, 0, "흔들기 폭이 없으면 pj 를 무시");
  }
  // 경계: sanitize 가 흔들기 폭을 bounds.pers_jitter_bands 로 자른다 — 머묾 정리 여유(j_hold + pj < 가장 작은 비영 팔)
  const hi = E.sanitizePersonal({ pers_jitter: 1, j_hold: 1 }, rules, { duration_min: 30 });
  const minArm = Math.min(...Z.hold.arms.filter((a) => a > 0));
  assert.ok(hi.j_hold + hi.pers_jitter < minArm, `j_hold ${hi.j_hold} + 흔들기 ${hi.pers_jitter} < ${minArm}`);
  assert.ok(Z.safety.j_move_bands * band + hi.pers_jitter < 2 * band, "이동: J + pj < 2 band");
});

test("중립(J·corridor = null)은 자르지 않는다 — pers = μ·pmarg + adj 그대로", () => {
  const r = makeRng("corridor-neutral");
  for (let t = 0; t < 5000; t++) {
    const P = { corridor_bands: null, j_move: null, j_hold: null };
    const taste = r() - 0.5, adj = r() * 0.05, distCost = r.int(0, 5) * band;
    const k = E.personalKey({ distCost, fit: 0.1, bandIdx: 3, bestBand: 0, arrival: r.chance(0.5), rEff: 0, taste, adj }, P);
    assert.equal(k.pers, taste + adj);
    assert.equal(k.key, R9(distCost + (taste + adj)));
  }
});

test("실제 recommend(탐욕 1폭): 매 걸음 고른 곡은 기하 최선곡보다 한 밴드 넘게 나쁘지 않고, 머묾은 반경 안이 있으면 반경 안", () => {
  const greedy = clone(rules);
  greedy.search.beam_width = 1; greedy.search.expand_per_step = 1;
  const catalog = makeCatalog(rules);
  const coords = E.workingCoords(catalog, rules);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const r = makeRng("corridor-int");
  let moves = 0, holds = 0;
  for (let t = 0; t < 250; t++) {
    const inp = randomInputs(r, catalog, rules);
    const P = randomPolicy(r, rules, catalog, { spec: true });
    delete P.tp; delete P.quit_frac;
    const res = E.recommend(catalog, greedy, { ...inp, personal: P });
    if (!res.sequence.length) continue;
    const rEff = res.personal.hold_radius_used;
    for (const row of res.sequence) {
      const tr = row.trace;
      assert.notEqual(tr.p_chosen_by, "beam", "1폭 탐색에서는 경로 단위 선택이 없다");
      const wp = [tr.wp_V, tr.wp_A];
      const geoFit = dist(coords.get(tr.p_geo_best), wp);
      if (tr.p_phase === "move") {
        moves++;
        const geoBand = Math.floor((geoFit + 1e-6) / band);
        assert.ok(tr.va_distance < (geoBand + 2) * band + 1e-5, `이동 ${row.song_id} fit ${tr.va_distance} vs 기하 ${geoFit}`);
      } else if (rEff > Z.safety.j_hold && geoFit <= rEff - 1e-5) {
        holds++;
        assert.ok(tr.va_distance <= rEff + 1e-5, `머묾 ${row.song_id} fit ${tr.va_distance} > r ${rEff}`);
      }
    }
  }
  assert.ok(moves > 500 && holds > 10, `이동 ${moves} · 머묾 ${holds}`);
});

test("빔 탐색에서도 걸음마다 |p_pers| ≤ J, 가점(p_pers<0)은 p_corridor 일 때만", () => {
  const catalog = makeCatalog(rules);
  const r = makeRng("corridor-beam");
  for (let t = 0; t < 80; t++) {
    const inp = randomInputs(r, catalog, rules);
    const P = randomPolicy(r, rules, catalog, { spec: t % 2 === 0 });
    const res = E.recommend(catalog, rules, { ...inp, personal: P });
    const S = E.sanitizePersonal(P, rules, { duration_min: inp.duration_min ?? 30 });
    for (const row of res.sequence) {
      const J = row.trace.p_phase === "hold" ? S.j_hold : S.j_move;
      if (J != null) assert.ok(Math.abs(row.trace.p_pers) <= J + 1e-6, `${row.trace.p_pers} vs ${J}`);
      if (row.trace.p_pers < 0 && S.corridor_bands != null) assert.equal(row.trace.p_corridor, true);
    }
  }
});
