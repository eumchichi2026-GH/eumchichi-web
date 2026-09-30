/* recommendExtras(§4.11·§6.7) — 더 들을 곡을 엔진이 고른다.
 *   경로(result.sequence)는 절대 바뀌지 않는다 · 경로와 같은 게이트(가사 포함)·싫어요·exclude_ids · 가수 상한은 경로에 이어서 ·
 *   경로 + 더 들을 곡 합이 target_sec 에 닿거나 max_songs 면 멈춤 · 개인화 없으면 빈 목록. */
import test from "node:test";
import assert from "node:assert/strict";

import * as E from "../engine.js";
import { loadRules, makeCatalog, makeRng, randomInputs, randomPolicy, p0Policy, clone } from "./engine_fixture.test.mjs";

const rules = loadRules();
const X = rules.personalization.extras;
const catalog = makeCatalog(rules);
const byId = new Map(catalog.map((s) => [s.song_id, s]));
const lenOf = (s) => Math.max(X.min_duration_s, s && s.duration_ms > 0 ? s.duration_ms / 1000 : X.default_duration_s);

function scenario(r) {
  const inp = { ...randomInputs(r, catalog, rules), duration_min: r.pick([30, 45, 60, 90]) };
  const P = randomPolicy(r, rules, catalog);
  return { inp: { ...inp, personal: P }, P };
}

test("경로는 절대 바뀌지 않는다 — extras 호출 전후 결과 JSON 동일, 다시 돌린 경로와도 동일", () => {
  const r = makeRng("ex-path");
  let got = 0;
  for (let t = 0; t < 25; t++) {
    const { inp } = scenario(r);
    const res = E.recommend(catalog, rules, inp);
    const before = JSON.stringify(res);
    const ex = E.recommendExtras(catalog, rules, inp, res, { target_sec: inp.duration_min * 60 * X.fill_ratio });
    assert.equal(JSON.stringify(res), before);
    assert.equal(JSON.stringify(E.recommend(catalog, rules, inp)), before);
    got += ex.extras.length;
  }
  assert.ok(got > 30, `더 들을 곡 ${got}`);
});

test("후보 규칙: 경로 곡·싫어요·exclude_ids 제외, 가사 게이트 지킴, 중복 없음, 가수 상한은 경로에 이어서", () => {
  const r = makeRng("ex-rules");
  for (let t = 0; t < 45; t++) {
    const { inp, P } = scenario(r);
    if (t % 3 === 0) inp.gates = ["instrumental_only"];
    const res = E.recommend(catalog, rules, inp);
    const ex = E.recommendExtras(catalog, rules, inp, res, {});
    const S = E.sanitizePersonal(P, rules, { duration_min: inp.duration_min });
    const pathIds = res.sequence.map((x) => x.song_id), exIds = ex.extras.map((x) => x.song_id);
    assert.equal(new Set([...pathIds, ...exIds]).size, pathIds.length + exIds.length, "경로와 겹치지 않고 중복 없음");
    const dis = (inp.user && inp.user.disliked) || [];
    const replay = new Set(S.replay_ids);
    for (const id of exIds) {
      assert.ok(!dis.includes(id));
      assert.ok(!S.exclude_ids.includes(id) || replay.has(id));
      if (inp.gates && inp.gates.includes("instrumental_only")) assert.equal(byId.get(id).instrumental, true, "연주곡만(B21)");
    }
    const cnt = {};
    for (const id of [...pathIds, ...exIds]) {
      const s = byId.get(id);
      const keys = S.artist_cap_by_key ? [...new Set(E.artistKeys(s.artist))] : [s.artist];
      for (const k of keys) cnt[k] = (cnt[k] || 0) + 1;
    }
    // 경로가 이미 상한을 넘긴 키는 없고(경로 규칙), extras 가 더해도 상한 이하
    for (const [k, v] of Object.entries(cnt)) assert.ok(v <= S.artist_cap, `${k} ${v}`);
    const rep = [...pathIds, ...exIds].filter((id) => replay.has(id)).length;
    assert.ok(rep <= S.replay_max, "다시 넣기 한도는 경로와 합쳐서");
  }
});

test("멈춤 조건: 경로 + 더 들을 곡 ≥ target_sec 이거나 max_songs, 그 전에는 멈추지 않는다(후보가 남아 있으면)", () => {
  const r = makeRng("ex-stop");
  for (let t = 0; t < 50; t++) {
    const { inp } = scenario(r);
    const res = E.recommend(catalog, rules, inp);
    const target = r.pick([0, 600, inp.duration_min * 60 * X.fill_ratio, 99999]);
    const ex = E.recommendExtras(catalog, rules, inp, res, { target_sec: target });
    const pathSec = res.sequence.reduce((a, x) => a + lenOf(byId.get(x.song_id)), 0);
    const tot = pathSec + ex.extras.reduce((a, x) => a + lenOf(byId.get(x.song_id)), 0);
    assert.ok(Math.abs(ex.total_sec - tot) < 1e-6);
    assert.ok(ex.extras.length <= X.max_songs);
    if (pathSec >= target) assert.equal(ex.extras.length, 0);
    else if (ex.extras.length < X.max_songs && tot < target) assert.ok(true, "후보 고갈");
    if (ex.extras.length > 1) {
      const beforeLast = tot - lenOf(byId.get(ex.extras.at(-1).song_id));
      assert.ok(beforeLast < target, "닿기 전에는 계속 채운다");
    }
  }
  // target_sec 을 안 주면 감상 시간 × 60 × fill_ratio
  const { inp } = scenario(makeRng("ex-default"));
  const res = E.recommend(catalog, rules, inp);
  assert.deepEqual(E.recommendExtras(catalog, rules, inp, res), E.recommendExtras(catalog, rules, inp, res, { target_sec: inp.duration_min * 60 * X.fill_ratio }));
  assert.deepEqual(E.recommendExtras(catalog, rules, inp, res, null), E.recommendExtras(catalog, rules, inp, res, {}));
});

test("선택 규칙: 목표 근처(반경 R_x 안은 거리 0), 앞 곡과의 전환·취향은 머묾 결합 제한, 첫 곡의 앞 곡은 경로 마지막 곡", () => {
  const r = makeRng("ex-pick");
  let n = 0;
  for (let t = 0; t < 30; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: 60 };
    const P = p0Policy(rules);
    const S = E.sanitizePersonal(P, rules, {});
    const res = E.recommend(catalog, rules, { ...inp, personal: P });
    if (!res.sequence.length) continue;
    const ex = E.recommendExtras(catalog, rules, { ...inp, personal: P }, res, { target_sec: 99999 });
    let prev = byId.get(res.sequence.at(-1).song_id);
    for (const row of ex.extras) {
      const s = byId.get(row.song_id);
      assert.ok(Math.abs(row.trace.p_adj - E.adjCost(prev, s, S)) < 1e-6);
      assert.ok(Math.abs(row.trace.p_pers) <= S.j_hold + 1e-9);
      assert.equal(row.trace.p_bpm_diff, E.adjFeatures(prev, s, S).bpm_diff);
      prev = s; n++;
    }
  }
  assert.ok(n > 100);
});

test("trace 와 설명: phase/p_phase = extra, p_extra = true, 걸음 문구 없이 '목표 분위기를 이어 가는 곡이에요.'", () => {
  const r = makeRng("ex-trace");
  for (let t = 0; t < 30; t++) {
    const { inp } = scenario(r);
    const res = E.recommend(catalog, rules, inp);
    const ex = E.recommendExtras(catalog, rules, inp, res, { target_sec: 99999 });
    ex.extras.forEach((row, j) => {
      const tr = row.trace;
      assert.equal(tr.phase, "extra"); assert.equal(tr.p_phase, "extra"); assert.equal(tr.p_extra, true);
      assert.equal(tr.step_index, res.sequence.length + j + 1);
      assert.equal(tr.rules_hash, rules.rules_hash);
      for (const k of Object.keys(tr)) if (k.startsWith("p_") || k === "phase") assert.ok(rules.trace_keys.includes(k), k);
      assert.ok(row.explanations.includes("목표 분위기를 이어 가는 곡이에요."));
      assert.ok(!row.explanations.some((m) => m.includes("걸음")));
    });
  }
});

test("개인화가 없으면 빈 목록(익명·개인화 끔 — 앱 옛 경로)", () => {
  const inp = { ...randomInputs(makeRng("ex-none"), catalog, rules), duration_min: 60 };
  const res = E.recommend(catalog, rules, inp);
  assert.deepEqual(E.recommendExtras(catalog, rules, inp, res, { target_sec: 9999 }).extras, []);
  assert.equal(E.recommendExtras(catalog, rules, inp, res, { target_sec: 9999 }).total_sec, 0);
  const off = clone(rules); off.personalization.enabled = false;
  assert.deepEqual(E.recommendExtras(catalog, off, { ...inp, personal: p0Policy(rules) }, res, {}).extras, []);
  assert.deepEqual(E.recommendExtras(catalog, rules, { ...inp, personal: p0Policy(rules) }, null, {}).extras, []);
});

test("소프트 게이트는 더 들을 곡에도 — 걸러서 soft_min_pool 미만이면 완화하고 soft_relaxed 로 알린다", () => {
  const vals = catalog.map((s) => Number(s.spokenness)).filter((x) => !Number.isNaN(x));
  const th = E.percentile(vals, rules.gates.find((g) => g.id === "exclude_spoken").value);
  const r = makeRng("ex-soft");
  for (let t = 0; t < 40; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: 60, personal: { ...p0Policy(rules), soft_gates: ["exclude_spoken"], soft_min_pool: t % 4 ? 12 : 48 } };
    const res = E.recommend(catalog, rules, inp);
    const ex = E.recommendExtras(catalog, rules, inp, res, { target_sec: 99999 });
    if (!ex.soft_relaxed) for (const row of ex.extras) { const sp = byId.get(row.song_id).spokenness; assert.ok(sp == null || sp < th); }
  }
});

test("결정적 — 같은 입력이면 같은 더 들을 곡", () => {
  const r = makeRng("ex-det");
  for (let t = 0; t < 10; t++) {
    const { inp } = scenario(r);
    const res = E.recommend(catalog, rules, inp);
    const a = JSON.stringify(E.recommendExtras(catalog, rules, inp, res, { target_sec: 5000 }));
    for (let k = 0; k < 5; k++) assert.equal(JSON.stringify(E.recommendExtras(catalog, rules, clone(inp), clone(res), { target_sec: 5000 })), a);
  }
});
