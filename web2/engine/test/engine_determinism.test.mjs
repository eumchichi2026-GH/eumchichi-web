/* 결정성(I7, 수용 기준 H1) — 같은 입력 100회 → 같은 시퀀스·같은 더 들을 곡. engine/*.js 에 시스템 난수·현재 시각 없음.
 * 입력 객체를 바꾸지 않는다(정책·사용자·카탈로그를 동결해도 돈다). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as E from "../engine.js";
import { ROOT, loadRules, makeCatalog, makeRng, randomInputs, randomPolicy, clone } from "./engine_fixture.test.mjs";

const rules = loadRules();
const catalog = makeCatalog(rules);

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

test("engine/*.js 에 Math.random · Date.now 없음(I7)", () => {
  const dir = path.join(ROOT, "engine");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.ok(files.includes("engine.js"));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/Math\.random/.test(src), `${f}: Math.random`);
    assert.ok(!/Date\.now/.test(src), `${f}: Date.now`);
  }
});

test("같은 입력 100회 → recommend·recommendExtras 출력 100% 동일", () => {
  const r = makeRng("det");
  const inp = { ...randomInputs(r, catalog, rules), duration_min: 60, seed: "u1:2026-09-27:3" };
  inp.personal = randomPolicy(r, rules, catalog);
  inp.personal.discovery_u = 0.37;
  const first = E.recommend(catalog, rules, inp);
  const a = JSON.stringify(first), ax = JSON.stringify(E.recommendExtras(catalog, rules, inp, first, { target_sec: 4000 }));
  for (let i = 0; i < 100; i++) {
    const res = E.recommend(catalog, rules, clone(inp));
    assert.equal(JSON.stringify(res), a);
    assert.equal(JSON.stringify(E.recommendExtras(catalog, rules, clone(inp), res, { target_sec: 4000 })), ax);
  }
});

test("무작위 정책 20개 × 3회 반복 — 모두 같은 출력, 입력은 바뀌지 않는다(동결 입력으로도 돈다)", () => {
  const r = makeRng("det-many");
  for (let t = 0; t < 20; t++) {
    const inp = { ...randomInputs(r, catalog, rules), personal: randomPolicy(r, rules, catalog, { spec: t % 2 === 0 }) };
    const snap = JSON.stringify(inp);
    const frozen = deepFreeze(clone(inp));
    const a = JSON.stringify(E.recommend(catalog, rules, inp));
    assert.equal(JSON.stringify(E.recommend(catalog, rules, frozen)), a);
    assert.equal(JSON.stringify(E.recommend(catalog, rules, inp)), a);
    assert.equal(JSON.stringify(inp), snap, "입력 불변");
  }
});

test("시드만 다르면 머묾 곡이 달라진다(반경 r 의 목적, B5) — 시드가 같으면 같다", () => {
  // 반경 0.05 안에 곡이 충분하도록 조밀한 카탈로그(2,000곡)
  const dense = makeCatalog(rules, 1200, "wp-dense");
  const r = makeRng("det-seed");
  let setDiffer = 0, lastDiffer = 0, total = 0;
  for (let t = 0; t < 12; t++) {
    const inp = { now: { V: r(), A: r() }, target: { V: 0.2 + r() * 0.6, A: 0.2 + r() * 0.6 }, duration_min: 60 };
    const P = { ...randomPolicy(r, rules, dense), hold_radius: 0.05, hold_order: "last_fixed_progress", exclude_ids: [], replay_ids: [],
                discovery_u: null, soft_gates: [], tp: null, quit_frac: null, stress: null, high_stress: false };
    const a = E.recommend(dense, rules, { ...inp, seed: "A", personal: P });
    const b = E.recommend(dense, rules, { ...inp, seed: "B", personal: P });
    assert.deepEqual(E.recommend(dense, rules, { ...inp, seed: "A", personal: P }), a);
    const hold = (res) => res.sequence.filter((x) => x.trace.p_phase === "hold").map((x) => x.song_id);
    if (hold(a).length < 2) continue;
    total++;
    if (hold(a).slice().sort().join() !== hold(b).slice().sort().join()) setDiffer++;
    if (a.sequence.at(-1).song_id !== b.sequence.at(-1).song_id) lastDiffer++;
  }
  assert.ok(total >= 8 && setDiffer > 0 && lastDiffer > 0, `머묾 집합 다름 ${setDiffer} · 마지막 곡 다름 ${lastDiffer} / ${total}`);
});
