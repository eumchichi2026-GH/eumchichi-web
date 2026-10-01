/* I0 · I1 회귀 — 엔진 2.6.0-wp(새 규칙) vs 기준 엔진 2.5.1(76e8bdf 규칙), 합성 카탈로그 300곡.
 *   I0  personal 없음(또는 enabled=false) → JSON 이 같다(버전·해시 필드만 제외).
 *       inputs.pace fast/slow → 2.5.1 에 '전환점 사본 규칙'([{up_to:999, at}])을 준 결과와 같다(앱 PACE_TP 경로).
 *       aggregateAffinity(items, rules) 2인자 → 같다. makeFeatureBinner → 같다.
 *   I1  중립 정책 → 곡 순서·2.5.1 trace 키 값·설명이 같다(p_* 키와 최상위 personal 만 추가).
 *       중립 정책에 μ·λ 만 바꾼 것 → 2.5.1 에 pref_weight·jump_weight 를 바꾼 규칙 사본과 같다(덧셈 순서까지 같은지 확인). */
import test from "node:test";
import assert from "node:assert/strict";

import * as E from "../engine.js";
import { loadRules, loadBaseline, makeCatalog, makeRng, randomInputs, randomItems, randomPolicy, stripVersions, neutralPolicy, clone } from "./engine_fixture.test.mjs";

const rules = loadRules();
const { engine: B, rules: baseRules } = await loadBaseline();
const catalog = makeCatalog(rules);
const N = 300;

const cases = (key, n) => { const r = makeRng(key); return Array.from({ length: n }, () => randomInputs(r, catalog, rules)); };

test("기준 엔진이 2.5.1 이고 새 엔진은 2.6.0-wp", () => {
  assert.equal(B.ENGINE_VERSION, "2.5.1");
  assert.equal(E.ENGINE_VERSION, "2.6.0-wp");
  assert.equal(rules.rules_version, "v2.5.0-wp");
  assert.equal(baseRules.rules_version, "v2.4.0");
});

test("기존 절 값 불변 — personalization·버전·해시·note·설명·trace_keys 만 다르다", () => {
  const a = clone(rules), b = clone(baseRules);
  for (const o of [a, b]) for (const k of ["personalization", "rules_version", "rules_hash", "note", "explanations", "trace_keys"]) delete o[k];
  assert.deepEqual(a, b);
  // 기존 설명은 그대로, 새 설명은 모두 when 이 있다
  assert.deepEqual(rules.explanations.slice(0, baseRules.explanations.length), baseRules.explanations);
  for (const e of rules.explanations.slice(baseRules.explanations.length)) assert.ok(e.when && e.when.trace_key.startsWith("p_"));
  for (const k of baseRules.trace_keys) assert.ok(rules.trace_keys.includes(k));
});

test(`I0: personal 없음 — 무작위 입력 ${N}개에서 2.5.1 과 JSON 동일`, () => {
  let nonEmpty = 0;
  for (const inp of cases("i0", N)) {
    const a = E.recommend(catalog, rules, inp), b = B.recommend(catalog, baseRules, inp);
    assert.deepEqual(stripVersions(a), stripVersions(b));
    assert.equal(a.personal, undefined);
    if (a.sequence.length) nonEmpty++;
  }
  assert.ok(nonEmpty > N * 0.8, `비어 있지 않은 경로 ${nonEmpty}/${N}`);
});

test("I0: personal = null · undefined · 비객체 → 2.5.1 과 같다", () => {
  for (const inp of cases("i0-null", 30)) {
    const b = stripVersions(B.recommend(catalog, baseRules, inp));
    for (const personal of [null, undefined, 0, "", "p", [], false])
      assert.deepEqual(stripVersions(E.recommend(catalog, rules, { ...inp, personal })), b);
  }
});

test("I0: personalization.enabled !== true 면 정책이 있어도 2.5.1 과 같다(I11 규칙 스위치)", () => {
  const r = makeRng("i0-off-pol");
  for (const [i, inp] of cases("i0-off", 60).entries()) {
    const off = clone(rules);
    if (i % 3 === 0) off.personalization.enabled = false;
    else if (i % 3 === 1) delete off.personalization.enabled;
    else off.personalization.enabled = "true";   // 문자열은 켜짐이 아니다
    const P = randomPolicy(r, rules, catalog, { spec: false });
    assert.deepEqual(stripVersions(E.recommend(catalog, off, { ...inp, personal: P })), stripVersions(B.recommend(catalog, baseRules, inp)));
    assert.deepEqual(E.recommendExtras(catalog, off, { ...inp, personal: P }, { sequence: [] }).extras, []);
  }
});

test("I0: inputs.pace fast/slow = 2.5.1 + 전환점 사본 규칙 (개인화 켬·끔 모두)", () => {
  const off = clone(rules); off.personalization.enabled = false;
  for (const [i, inp] of cases("i0-pace", 120).entries()) {
    const pace = i % 2 ? "fast" : "slow";
    const copy = clone(baseRules);
    copy.iso.transition_point = [{ up_to: 999, at: rules.personalization.pace.manual_tp[pace] }];
    const b = stripVersions(B.recommend(catalog, copy, inp));
    assert.deepEqual(stripVersions(E.recommend(catalog, rules, { ...inp, pace })), b);
    assert.deepEqual(stripVersions(E.recommend(catalog, off, { ...inp, pace })), b);
  }
});

test("I0: 모르는 pace 값은 무시(표 그대로)", () => {
  for (const inp of cases("i0-pace-bad", 20)) {
    const b = stripVersions(B.recommend(catalog, baseRules, inp));
    for (const pace of [null, "medium", "FAST", 1, "__proto__", "toString"])
      assert.deepEqual(stripVersions(E.recommend(catalog, rules, { ...inp, pace })), b);
  }
});

test("I0: aggregateAffinity(items, rules) 2인자 — 무작위 항목 집합 200개에서 2.5.1 과 같다", () => {
  const r = makeRng("affinity");
  for (let i = 0; i < 200; i++) {
    const items = randomItems(r, catalog, r.int(0, 60));
    assert.deepEqual(E.aggregateAffinity(items, rules), B.aggregateAffinity(items, baseRules));
    assert.deepEqual(E.aggregateAffinity(items, rules, undefined), B.aggregateAffinity(items, baseRules));
    assert.deepEqual(E.aggregateAffinity(items, rules, {}), B.aggregateAffinity(items, baseRules));
  }
});

test("I0: makeFeatureBinner 경계·묶음이 2.5.1 과 같다", () => {
  const a = E.makeFeatureBinner(catalog, rules), b = B.makeFeatureBinner(catalog, baseRules);
  assert.deepEqual(a.cuts, b.cuts);
  for (const s of catalog) assert.deepEqual(a(s), b(s));
  assert.equal(E.artistKeys("IU; iu ;Band  Seven").join("|"), B.artistKeys("IU; iu ;Band  Seven").join("|"));
});

/* I1: 중립 정책 — 곡 순서·2.5.1 trace 키·설명이 같고, 새로 생기는 것은 p_* 키와 최상위 personal 뿐 */
function assertI1(a, b) {
  assert.deepEqual(a.sequence.map((x) => x.song_id), b.sequence.map((x) => x.song_id));
  for (const k of Object.keys(b)) if (!["engine_version", "rules_version", "rules_hash", "sequence"].includes(k)) assert.deepEqual(a[k], b[k], k);
  assert.deepEqual(Object.keys(a).filter((k) => !(k in b)), ["personal"]);
  a.sequence.forEach((row, i) => {
    const ref = b.sequence[i].trace;
    for (const k of Object.keys(ref)) if (k !== "rules_hash") assert.deepEqual(row.trace[k], ref[k], `trace.${k} @${i}`);
    for (const k of Object.keys(row.trace)) if (!(k in ref)) assert.ok(k.startsWith("p_"), `새 trace 키 ${k}`);
    assert.deepEqual(row.explanations, b.sequence[i].explanations);
  });
}

test(`I1: 중립 정책 — 무작위 입력 ${N}개에서 곡 순서·2.5.1 trace 키 100% 동일`, () => {
  const NP = neutralPolicy(rules);
  for (const inp of cases("i1", N)) assertI1(E.recommend(catalog, rules, { ...inp, personal: NP }), B.recommend(catalog, baseRules, inp));
});

test("I1: 중립 정책 + pace fast/slow = 2.5.1 전환점 사본", () => {
  const NP = neutralPolicy(rules);
  for (const [i, inp] of cases("i1-pace", 60).entries()) {
    const pace = i % 2 ? "fast" : "slow";
    const copy = clone(baseRules);
    copy.iso.transition_point = [{ up_to: 999, at: rules.personalization.pace.manual_tp[pace] }];
    assertI1(E.recommend(catalog, rules, { ...inp, pace, personal: NP }), B.recommend(catalog, copy, inp));
  }
});

test("I1: 중립 정책의 μ·λ 만 바꾸면 2.5.1 에 pref_weight·jump_weight 를 바꾼 규칙 사본과 같다(덧셈 순서)", () => {
  const r = makeRng("i1-mu");
  for (const inp of cases("i1-mu-in", 120)) {
    const mu = Math.round(r() * 5000) / 10000, lambda = 0.1 + Math.round(r() * 1500) / 10000;
    const copy = clone(baseRules);
    copy.preference.pref_weight = mu; copy.path.jump_weight = lambda;
    const a = E.recommend(catalog, rules, { ...inp, personal: { ...neutralPolicy(rules), mu, lambda } });
    const b = B.recommend(catalog, copy, inp);
    assertI1(a, b);
    // path_cost 까지 같으면 비용 합의 부동소수 순서도 같다
    a.sequence.forEach((row, i) => assert.equal(row.trace.path_cost, b.sequence[i].trace.path_cost));
  }
});

test("I1: 중립 정책에서 p_* 값도 중립 — 가점·전환·발견·다시 넣기·소프트 완화 없음", () => {
  const NP = neutralPolicy(rules);
  for (const inp of cases("i1-p", 40)) {
    const a = E.recommend(catalog, rules, { ...inp, personal: NP });
    for (const row of a.sequence) {
      const t = row.trace;
      assert.equal(t.p_adj, 0); assert.equal(t.p_smooth, false); assert.equal(t.p_discovery, false);
      assert.equal(t.p_replay, false); assert.equal(t.p_soft_relaxed, false); assert.equal(t.p_extra, false);
      assert.ok(["geometry", "taste", "beam"].includes(t.p_chosen_by), t.p_chosen_by);
    }
    if (a.personal) { assert.equal(a.personal.start_offset_used, 0); assert.equal(a.personal.hold_radius_used, 0); assert.equal(a.personal.discovery_step, null); }
  }
});
