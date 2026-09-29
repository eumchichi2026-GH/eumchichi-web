/* P 모드 엔진 훅(명세 §6.6) 단위 시험 — 합성 카탈로그 300곡.
 *   속도 tp·이탈 가드·n≤3 보호(§4.3) · 시작 오프셋(§4.4) · 머묾 반경·순서(§4.6) · 가수 상한 키 단위(§4.10.1) ·
 *   exclude_ids(§4.10.2) · 다시 넣기(§4.10.3) · 발견 칸(§4.7.4) · 소프트 게이트(§4.9) · adjFeatures/adjCost(§4.8) ·
 *   aggregateAffinity opts · prefDetail 추가 특징 · p_* trace(§6.8) · 새 export. */
import test from "node:test";
import assert from "node:assert/strict";

import * as E from "../engine.js";
import { loadRules, makeCatalog, makeRng, randomInputs, randomItems, randomPolicy, neutralPolicy, p0Policy, clone } from "./engine_fixture.test.mjs";

const rules = loadRules();
const Z = rules.personalization;
const band = Number(rules.preference.band);
const R6 = (x) => Math.round(x * 1e6) / 1e6;
const catalog = makeCatalog(rules);
const byId = new Map(catalog.map((s) => [s.song_id, s]));
const coords = E.workingCoords(catalog, rules);
const LONG = { now: { V: 0.12, A: 0.85 }, target: { V: 0.85, A: 0.2 } };     // 긴 여정(곡 수 = 시간 기준)
const SHORT = { now: { V: 0.5, A: 0.5 }, target: { V: 0.53, A: 0.52 } };    // 짧은 여정(곡 수 3)
const run = (inputs, personal) => E.recommend(catalog, rules, personal === undefined ? inputs : { ...inputs, personal });
const arrivalSongNo = (res) => res.sequence.findIndex((row) => row.trace.p_phase === "hold") + 1;

test("새 export 가 명세 §9.2 모양으로 있다", () => {
  for (const f of ["recommend", "recommendExtras", "aggregateAffinity", "sanitizePersonal", "adjFeatures", "adjCost", "workingCoords",
    "makeExtraBinner", "seededUniform", "fnv1a32", "songCount", "transitionAt", "median", "percentile", "artistKeys", "makeFeatureBinner", "renderExplanations"])
    assert.equal(typeof E[f], "function", f);
  assert.equal(E.ENGINE_VERSION, "2.6.0-wp");
  assert.equal(E.fnv1a32("abc"), 440920331);
  assert.equal(E.songCount(rules, 30), 8); assert.equal(E.transitionAt(rules, 30), 0.6); assert.equal(E.transitionAt(rules, 15), 1);
});

test("속도: inputs.pace 수동값이 P.tp 보다 이기고, P.tp 는 표보다 이긴다(§4.3.3)", () => {
  const P = { ...p0Policy(rules), tp: 0.8 };
  const base = { ...LONG, duration_min: 30, seed: "s" };
  assert.equal(run(base, P).personal.tp_used, 0.8);
  assert.equal(run({ ...base, pace: "fast" }, P).personal.tp_used, Z.pace.manual_tp.fast);
  assert.equal(run({ ...base, pace: "slow" }, P).personal.tp_used, Z.pace.manual_tp.slow);
  assert.equal(run(base, p0Policy(rules)).personal.tp_used, E.transitionAt(rules, 30));
  // 30분 8곡: 표 0.6 → 6번째 도착, 수동 빠르게 0.5 → 5번째, 천천히 1.0 → 8번째
  assert.equal(arrivalSongNo(run(base, p0Policy(rules))), 6);
  assert.equal(arrivalSongNo(run({ ...base, pace: "fast" }, p0Policy(rules))), 5);
  assert.equal(arrivalSongNo(run({ ...base, pace: "slow" }, p0Policy(rules))), 8);
  // 계산 예(§4.3.3): π=0.6 → tp = 0.6 − 0.6·0.1 = 0.54 → 5번째
  assert.equal(arrivalSongNo(run(base, { ...p0Policy(rules), tp: 0.54 })), 5);
});

test("이탈 가드(§4.3.4): 도착 곡 번호 ≤ K = max(2, floor(f·n)), tp 하한 0.5", () => {
  const base = { ...LONG, duration_min: 30, seed: "q" };   // n = 8
  for (const [f, K] of [[0.7, 5], [0.75, 6], [0.9, 7]]) {
    const res = run(base, { ...p0Policy(rules), quit_frac: f });
    assert.equal(res.song_count.effective, 8);
    assert.ok(arrivalSongNo(res) <= K, `f=${f}: 도착 ${arrivalSongNo(res)} > K ${K}`);
  }
  // 0.5 하한: f 가 아무리 작아도 tp ≥ 0.5
  assert.equal(run(base, { ...p0Policy(rules), quit_frac: 0.1 }).personal.tp_used, Z.bounds.tp[0]);
  // 이탈 가드는 더 늦추지 않는다(상한만)
  assert.equal(run(base, { ...p0Policy(rules), quit_frac: 1 }).personal.tp_used, E.transitionAt(rules, 30));
  // '천천히'를 누른 세션에는 적용 안 함
  assert.equal(run({ ...base, pace: "slow" }, { ...p0Policy(rules), quit_frac: 0.3 }).personal.tp_used, 1);
});

test("n ≤ small_n_max 퇴화 방지: 개인화가 tp 를 바꾼 경우에만 tp ≥ 0.75, 표 값은 그대로(I1)", () => {
  const base = { ...SHORT, duration_min: 30, seed: "n3" };
  const p0 = run(base, p0Policy(rules));
  assert.equal(p0.song_count.effective, 3);
  assert.equal(p0.personal.tp_used, E.transitionAt(rules, 30), "표 값(0.6)은 건드리지 않는다");
  assert.equal(run(base, { ...p0Policy(rules), tp: 0.5 }).personal.tp_used, Z.pace.small_n_min_tp);
  assert.equal(run(base, { ...p0Policy(rules), tp: 0.9 }).personal.tp_used, 0.9);
  assert.equal(run({ ...base, pace: "fast" }, p0Policy(rules)).personal.tp_used, Z.pace.manual_tp.fast, "수동 버튼은 선언 그대로");
});

test("시작 오프셋(§4.4): 첫 경유지만 목표 쪽으로 s 만큼, 곡 수·도착 경유지는 그대로. 짧은 여정은 적용 안 함", () => {
  const base = { ...LONG, duration_min: 45, seed: "st" };
  const a = run(base, p0Policy(rules)), b = run(base, { ...p0Policy(rules), start_offset: 0.15 });
  assert.deepEqual(b.song_count, a.song_count);
  assert.equal(b.personal.start_offset_used, 0.15);
  const w0 = [a.sequence[0].trace.wp_V, a.sequence[0].trace.wp_A];
  const wt = [a.sequence.at(-1).trace.wp_V, a.sequence.at(-1).trace.wp_A];
  const exp = [w0[0] + (wt[0] - w0[0]) * 0.15, w0[1] + (wt[1] - w0[1]) * 0.15];
  assert.ok(Math.abs(b.sequence[0].trace.wp_V - exp[0]) < 2e-6 && Math.abs(b.sequence[0].trace.wp_A - exp[1]) < 2e-6);
  assert.deepEqual([b.sequence.at(-1).trace.wp_V, b.sequence.at(-1).trace.wp_A], wt);
  const s = run({ ...SHORT, duration_min: 45 }, { ...p0Policy(rules), start_offset: 0.15 });
  assert.equal(s.personal.start_offset_used, 0);
});

test("두 레인(I3): 경로 모수가 같으면 취향·전환·게이트·다양성이 달라도 경유지는 100% 같다", () => {
  const r = makeRng("lanes");
  for (let t = 0; t < 25; t++) {
    const inp = randomInputs(r, catalog, rules);
    const a = run(inp, p0Policy(rules));
    const P = randomPolicy(r, rules, catalog);
    for (const k of ["tp", "quit_frac", "start_offset", "stress", "high_stress"]) delete P[k];
    P.hold_radius = Z.hold.p0_radius;
    const b = run(inp, P);
    if (a.sequence.length !== b.sequence.length) continue;   // 후보 제외가 달라 곡이 모자란 경우
    assert.deepEqual(b.sequence.map((x) => [x.trace.wp_V, x.trace.wp_A]).sort(), a.sequence.map((x) => [x.trace.wp_V, x.trace.wp_A]).sort());
  }
});

test("머묾 반경(§4.6): n ≥ hold_min_songs 이면 r, 아니면 0", () => {
  const fixed = { ...p0Policy(rules), hold_min_pool: 0 };   // 밀도 적응 끔 — 반경 그대로
  assert.equal(run({ ...LONG, duration_min: 30 }, fixed).personal.hold_radius_used, Z.hold.p0_radius);
  assert.equal(run({ ...LONG, duration_min: 15 }, fixed).personal.hold_radius_used, 0);   // 4곡
  assert.equal(run({ ...LONG, duration_min: 15 }, { ...fixed, hold_min_songs: 4 }).personal.hold_radius_used, Z.hold.p0_radius);
  assert.equal(run({ ...LONG, duration_min: 15 }, p0Policy(rules)).personal.hold_radius_used, 0, "곡 수가 모자라면 밀도 적응도 없다");
});

test("밀도 적응 머묾 반경(§4.6.1 변경 20260929): 반경 안 후보가 hold_min_pool 곡 미만이면 그 순번째 후보까지, 상한 hold_radius_cap(고긴장 I5)", () => {
  const r = makeRng("hold-pool");
  let widened = 0;
  for (let t = 0; t < 30; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: r.pick([30, 45, 60]) };
    for (const hs of [false, true]) {
      const P = { ...p0Policy(rules), hold_min_pool: Z.hold.min_pool, ...(hs ? { high_stress: true } : {}) };
      const res = run(inp, P);
      if (res.song_count.effective < Z.hold.min_songs || !res.sequence.length) continue;
      const S = E.sanitizePersonal(P, rules, { duration_min: inp.duration_min });
      /* 기대값: 후보(싫어요·최근 창·게이트를 거친 곡 — 이 입력은 모두 통과)의 목표 거리 k 번째 */
      const tgt = [res.sequence.at(-1).trace.wp_V, res.sequence.at(-1).trace.wp_A];
      const uni = catalog.filter((s) => !(inp.user && (inp.user.disliked || []).includes(s.song_id)) && !(S.exclude_ids || []).includes(s.song_id));
      const ds = uni.map((s) => { const c = coords.get(s.song_id); return Math.round(Math.hypot(c[0] - tgt[0], c[1] - tgt[1]) * 1e9) / 1e9; }).sort((a, b) => a - b);
      const dk = ds[Math.min(ds.length, Z.hold.min_pool) - 1];
      const used = res.personal.hold_radius_used;
      assert.ok(used >= S.hold_radius - 1e-12, "좁히지 않는다");
      assert.ok(used <= S.hold_radius_cap + 1e-12, "상한 hold_radius_cap");
      if (hs) assert.ok(used <= Z.safety.high_stress.hold_radius_max + 1e-12, "고긴장 I5");
      if (!(inp.gates || []).length && !(inp.genres || []).length && dk <= S.hold_radius) assert.equal(used, S.hold_radius, "후보가 충분하면 그대로");
      if (used > S.hold_radius) widened++;
    }
  }
  assert.ok(widened > 0, "합성 카탈로그(300곡)는 성겨서 넓히는 경우가 있어야 한다");
  // 정책이 hold_min_pool 을 주지 않으면(0) 이전과 같다
  const inp = { ...LONG, duration_min: 30, seed: "hp" };
  assert.deepEqual(run(inp, { ...p0Policy(rules), hold_min_pool: 0 }).personal.hold_radius_used, Z.hold.p0_radius);
});

test("머묾 순서 last_fixed_turn: 곡 집합·마지막 곡은 last_fixed_progress 와 같고, (역행, 꺾임) 이 사전식으로 더 나쁘지 않다", () => {
  const r = makeRng("hold-turn");
  const env = Z.safety.envelope;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const shape = (res) => {
    const c = res.sequence.map((x) => [x.trace.song_V, x.trace.song_A]);
    const hs = res.sequence.findIndex((x) => x.trace.p_phase === "hold");
    const tgt = [res.sequence.at(-1).trace.wp_V, res.sequence.at(-1).trace.wp_A];
    let turns = 0;
    for (let i = 1; i + 1 < c.length; i++) {
      const u = [c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]], v = [c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]];
      if (Math.hypot(...u) > env.turn_min && Math.hypot(...v) > env.turn_min && u[0] * v[0] + u[1] * v[1] < 0) turns++;
    }
    const back = hs > 0 && d(c[hs], tgt) > d(c[hs - 1], tgt) + env.reversal_eps ? 1 : 0;
    return { back, turns };
  };
  let tails = 0, better = 0;
  for (let t = 0; t < 60; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: r.pick([30, 45, 60]) };
    const a = run(inp, { ...p0Policy(rules), hold_order: "last_fixed_progress" });
    const b = run(inp, { ...p0Policy(rules), hold_order: "last_fixed_turn" });
    assert.deepEqual(b.sequence.map((x) => x.song_id).sort(), a.sequence.map((x) => x.song_id).sort(), "곡 집합 그대로");
    const ha = a.sequence.filter((x) => x.trace.p_phase === "hold"), hb = b.sequence.filter((x) => x.trace.p_phase === "hold");
    if (ha.length < 2) continue;
    tails++;
    assert.equal(hb.at(-1).song_id, ha.at(-1).song_id, "마지막(최소 fit) 곡 고정 — 지그재그 0%");
    for (const h of hb) assert.ok(hb.at(-1).trace.va_distance <= h.trace.va_distance);
    const sa = shape(a), sb = shape(b);
    assert.ok(sb.back < sa.back || (sb.back === sa.back && sb.turns <= sa.turns), `역행·꺾임 ${JSON.stringify(sb)} vs ${JSON.stringify(sa)}`);
    if (sb.back < sa.back || sb.turns < sa.turns) better++;
  }
  assert.ok(tails > 25, `머묾 2곡 이상 ${tails}`);
});

test("도착 상한(20260929): 머묾 걸음의 '반경 안'(거리 0·가점 허용)은 min(r, 마지막 이동 곡의 목표 거리 + reversal_eps) 까지만", () => {
  /* 머묾 곡의 p_corridor(가점 허용) = fit ≤ 도착 상한. 이동 곡은 재배열되지 않으므로 마지막 이동 곡 = 최종 경로의 seq[hs − 1] */
  const r = makeRng("arrive-cap");
  const eps = Z.safety.envelope.reversal_eps;
  let checked = 0, capped = 0;
  for (let t = 0; t < 60; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: r.pick([30, 45, 60]) };
    const res = run(inp, { ...p0Policy(rules), hold_radius: Z.bounds.hold_radius[1], hold_min_pool: 0, hold_cluster: false });   // 묶음은 아래 따로
    const seq = res.sequence;
    const hs = seq.findIndex((x) => x.trace.p_phase === "hold");
    /* 여정 0(지금 = 목표)은 모든 경유지가 목표라 이동 곡도 머묾 재배열에 섞인다(2.5.1 부터의 퇴화 경우) — 건너뜀 */
    if (hs < 1 || res.song_count.journey < 0.05 || seq.slice(hs).some((x) => x.trace.p_phase !== "hold")) continue;
    const tgt = [seq.at(-1).trace.wp_V, seq.at(-1).trace.wp_A];
    const c = coords.get(seq[hs - 1].song_id);
    const cap = Math.min(res.personal.hold_radius_used, Math.hypot(c[0] - tgt[0], c[1] - tgt[1]) + eps);
    if (cap < res.personal.hold_radius_used) capped++;
    for (const x of seq.slice(hs)) {
      if (Math.abs(x.trace.va_distance - cap) < 1e-5) continue;   // 경계(표시 반올림) 근처는 건너뜀
      checked++;
      assert.equal(x.trace.p_corridor, x.trace.va_distance < cap, `fit ${x.trace.va_distance} · 상한 ${cap}`);
    }
  }
  assert.ok(checked > 50 && capped > 0, `검사 ${checked} · 상한이 반경보다 좁았던 경우 ${capped}`);
});

test("머묾 묶음(hold_cluster, 20260929): '도착한' 머묾 곡(p_corridor)끼리는 서로 turn_min 안 — 모두 도착한 곡이면 머묾 안 90° 꺾임 0", () => {
  const r = makeRng("hold-cluster");
  const tm = Z.safety.envelope.turn_min;
  const dense = makeCatalog(rules, 2000, "wp-dense-cluster");   // 목표 근처에 묶음을 이룰 만큼 촘촘한 카탈로그
  const dc = E.workingCoords(dense, rules);
  const C = (x) => dc.get(x.song_id);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let holds = 0, allIn = 0, outside = 0;
  for (let t = 0; t < 60; t++) {
    const inp = { ...randomInputs(r, dense, rules), duration_min: r.pick([30, 45, 60]) };
    const res = E.recommend(dense, rules, { ...inp, personal: { ...p0Policy(rules), hold_cluster: true } });
    const seq = res.sequence;
    const hs = seq.findIndex((x) => x.trace.p_phase === "hold");
    if (hs < 0 || seq.length - hs < 2 || seq.slice(hs).some((x) => x.trace.p_phase !== "hold")) continue;
    holds++;
    const inC = seq.slice(hs).filter((x) => x.trace.p_corridor);
    for (let i = 0; i < inC.length; i++) for (let j = i + 1; j < inC.length; j++) assert.ok(d(C(inC[i]), C(inC[j])) <= tm + 1e-9, "도착한 머묾 곡끼리 turn_min 안");
    if (inC.length === seq.length - hs) {
      allIn++;
      const c = seq.map(C);
      for (let i = hs; i + 1 < c.length; i++) {
        const u = [c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]], v = [c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]];
        assert.ok(!(Math.hypot(...u) > tm && Math.hypot(...v) > tm && u[0] * v[0] + u[1] * v[1] < 0), `머묾 꺾임 @${i - hs}`);
      }
    } else outside++;
  }
  assert.ok(holds > 25 && allIn > 10, `머묾 ${holds} · 모두 도착 ${allIn} · 묶음 밖 섞임 ${outside}`);
  // 끄면(false) 이전 동작 — 머묾 곡 사이 거리 제한 없음
  const inp = { ...LONG, duration_min: 60, seed: "hc" };
  const off = run(inp, { ...p0Policy(rules), hold_cluster: false }), on = run(inp, { ...p0Policy(rules), hold_cluster: true });
  assert.equal(off.sequence.length, on.sequence.length);
});

test("머묾 순서 last_fixed_progress: 마지막 곡이 머묾 곡 중 가장 가깝고(지그재그 0%), 나머지는 진행 방향 순", () => {
  const r = makeRng("hold-order");
  let tails = 0;
  for (let t = 0; t < 60; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: r.pick([30, 45, 60, 90]) };
    const res = run(inp, { ...p0Policy(rules), hold_order: "last_fixed_progress" });
    const hold = res.sequence.filter((x) => x.trace.p_phase === "hold");
    if (hold.length < 2) continue;
    tails++;
    const last = hold.at(-1).trace.va_distance;
    for (const h of hold) assert.ok(last <= h.trace.va_distance, "마지막 곡이 가장 가깝다");
    // 진행 방향 투영(작업 좌표): 첫 경유지(= 지금, 시작 오프셋 0)와 목표
    const now = [res.sequence[0].trace.wp_V, res.sequence[0].trace.wp_A], tgt = [hold[0].trace.wp_V, hold[0].trace.wp_A];
    const along = (id) => { const c = coords.get(id); return (c[0] - now[0]) * (tgt[0] - now[0]) + (c[1] - now[1]) * (tgt[1] - now[1]); };
    const rest = hold.slice(0, -1).map((x) => along(x.song_id));
    for (let i = 1; i < rest.length; i++) assert.ok(rest[i] >= rest[i - 1] - 1e-5, "진행 방향 오름차순");
  }
  assert.ok(tails > 25, `머묾 2곡 이상 ${tails}`);
});

test("머묾 순서 fit 은 2.5.1 정렬(먼 것 → 가까운 것), last_fixed_smooth 도 마지막 곡 고정·곡 집합 불변", () => {
  const r = makeRng("hold-smooth");
  for (let t = 0; t < 20; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: r.pick([45, 60, 90]) };
    const P = { ...p0Policy(rules), hold_order: "fit" };
    const a = run(inp, P), b = run(inp, { ...P, hold_order: "last_fixed_smooth" }), c = run(inp, { ...P, hold_order: "last_fixed_progress" });
    const holdOf = (res) => res.sequence.filter((x) => x.trace.p_phase === "hold");
    const ha = holdOf(a);
    for (let i = 1; i < ha.length; i++) assert.ok(ha[i].trace.va_distance <= ha[i - 1].trace.va_distance);
    for (const res of [b, c]) {
      assert.deepEqual(res.sequence.map((x) => x.song_id).sort(), a.sequence.map((x) => x.song_id).sort(), "곡 집합 그대로");
      const h = holdOf(res);
      if (h.length) assert.equal(h.at(-1).trace.va_distance, Math.min(...ha.map((x) => x.trace.va_distance)), "가장 가까운 곡이 마지막");
    }
  }
});

test("가수 상한 키 단위(§4.10.1, B27): 참여 가수 중 한 명이라도 상한에 닿으면 제외", () => {
  const r = makeRng("cap");
  let multi = 0;
  for (let t = 0; t < 30; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: 90 };
    const cap = r.pick([1, 2]);
    const res = run(inp, { ...p0Policy(rules), artist_cap: cap, artist_cap_by_key: true });
    const cnt = {};
    for (const row of res.sequence) for (const k of new Set(E.artistKeys(byId.get(row.song_id).artist))) cnt[k] = (cnt[k] || 0) + 1;
    for (const [k, v] of Object.entries(cnt)) assert.ok(v <= cap, `${k} ${v} > ${cap}`);
    if (res.sequence.some((row) => byId.get(row.song_id).artist.includes(";"))) multi++;
    // 키 단위가 아니면 문자열 통째(2.5.1 방식)
    const s = run(inp, { ...p0Policy(rules), artist_cap: cap, artist_cap_by_key: false });
    const cs = {};
    for (const row of s.sequence) { const a = byId.get(row.song_id).artist; cs[a] = (cs[a] || 0) + 1; }
    for (const v of Object.values(cs)) assert.ok(v <= cap);
  }
  assert.ok(multi > 3, `협업곡이 뽑힌 경우 ${multi}`);
});

test("exclude_ids(§4.10.2): 창의 곡은 안 나오고, null 이면 user.recent_played 를 쓴다", () => {
  const r = makeRng("excl");
  for (let t = 0; t < 30; t++) {
    const inp = randomInputs(r, catalog, rules);
    const ex = r.sample(catalog, 120).map((s) => s.song_id);
    const res = run(inp, { ...p0Policy(rules), exclude_ids: ex });
    for (const row of res.sequence) assert.ok(!ex.includes(row.song_id));
    const res2 = run(inp, { ...p0Policy(rules), exclude_ids: null });
    const recent = (inp.user && inp.user.recent_played) || [];
    for (const row of res2.sequence) assert.ok(!recent.includes(row.song_id));
    const dis = (inp.user && inp.user.disliked) || [];
    for (const row of [...res.sequence, ...res2.sequence]) assert.ok(!dis.includes(row.song_id), "싫어요는 늘 제외(I12)");
  }
});

test("다시 넣기(§4.10.3): replay_ids 는 창에서 빠지고, 시퀀스당 replay_max 곡까지", () => {
  const r = makeRng("replay");
  let used = 0;
  for (let t = 0; t < 25; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: 60 };
    // 좋아요한 곡을 창에 넣고 그중 일부를 다시 넣기 후보로 — μ 를 크게 해 실제로 뽑히게
    const liked = r.sample(catalog, 40).map((s) => s.song_id);
    const items = liked.map((id) => ({ song_id: id, liked: true, artist: byId.get(id).artist, genres: byId.get(id).genres, feature_bins: byId.get(id).feature_bins }));
    const user = { ...E.aggregateAffinity([...items, ...randomItems(r, catalog, 20)], rules), disliked: [], recent_played: [] };
    const P = { ...p0Policy(rules), mu: 0.5, exclude_ids: liked, replay_ids: liked.slice(0, 20), replay_max: 1 };
    const res = run({ ...inp, user }, P);
    const rep = res.sequence.filter((row) => P.replay_ids.includes(row.song_id));
    assert.ok(rep.length <= 1, `다시 넣기 ${rep.length}`);
    for (const row of res.sequence) {
      assert.equal(row.trace.p_replay, P.replay_ids.includes(row.song_id));
      assert.ok(!liked.slice(20).includes(row.song_id), "다시 넣기 후보가 아닌 창 곡은 제외");
      if (row.trace.p_replay) assert.ok(row.explanations.includes("좋아요한 곡을 오랜만에 다시 넣었어요."));
    }
    used += rep.length;
    const none = run({ ...inp, user }, { ...P, replay_max: 0 });
    assert.ok(none.sequence.every((row) => !P.replay_ids.includes(row.song_id)), "replay_max 0 이면 안 나온다");
  }
  assert.ok(used > 3, `다시 넣은 세션 ${used}`);
});

test("새 가수 발견 칸(§4.7.4): 걸음 1 + floor(u·(n_move−1)) 에서 새 가수 곡, 그 걸음만 p_discovery", () => {
  const r = makeRng("disc");
  let hit = 0;
  for (let t = 0; t < 30; t++) {
    const inp = { ...randomInputs(r, catalog, rules), ...LONG, duration_min: 60, seed: `d${t}` };
    // 가수 절반쯤을 들어본 사용자 — 나머지 절반이 '새 가수'
    const known = new Set(r.sample([...new Set(catalog.flatMap((s) => E.artistKeys(s.artist)))], 40));
    const items = catalog.filter((s) => E.artistKeys(s.artist).some((k) => known.has(k))).slice(0, 60)
      .map((s) => ({ song_id: s.song_id, artist: s.artist, liked: r.chance(0.5), feature_bins: s.feature_bins }));
    const user = { ...E.aggregateAffinity(items, rules), disliked: [], recent_played: [] };
    const u = r();
    const res = run({ ...inp, user }, { ...p0Policy(rules), mu: 0.3, discovery_u: u });
    const nMove = res.sequence.filter((x) => x.trace.p_phase === "move").length;
    const step = 1 + Math.floor(u * (nMove - 1));
    res.sequence.forEach((row, i) => { if (i !== step) assert.equal(row.trace.p_discovery, false); });
    if (res.personal.discovery_step !== null) {
      hit++;
      assert.equal(res.personal.discovery_step, step + 1);
      const row = res.sequence[step];
      assert.equal(row.trace.p_discovery, true);
      assert.ok(E.artistKeys(byId.get(row.song_id).artist).every((k) => !(k in user.artist_affinity)), "새 가수");
      assert.ok(row.explanations.includes("이번엔 아직 안 들어본 가수의 곡도 하나 넣어 봤어요."));
      assert.equal(row.trace.p_phase, "move");
      assert.ok(step >= 1, "첫 곡은 발견 칸이 아니다");
    }
  }
  assert.ok(hit > 8, `발견 칸 적용 ${hit}`);
  // 이동 걸음이 min_moving_steps 미만이면 없음
  const short = run({ ...SHORT, duration_min: 30 }, { ...p0Policy(rules), discovery_u: 0.5 });
  assert.equal(short.personal.discovery_step, null);
});

test("소프트 게이트(§4.9): 완화하지 않은 걸음의 곡은 게이트 통과, 풀이 작으면 그 걸음만 완화", () => {
  const vals = catalog.map((s) => Number(s.spokenness)).filter((x) => !Number.isNaN(x));
  const g = rules.gates.find((x) => x.id === "exclude_spoken");
  const th = E.percentile(vals, g.value);
  const r = makeRng("soft");
  let relaxed = 0, kept = 0;
  for (let t = 0; t < 60; t++) {
    const inp = randomInputs(r, catalog, rules);
    const P = { ...p0Policy(rules), soft_gates: ["exclude_spoken"], soft_min_pool: r.pick([12, 24, 48]) };
    const res = run(inp, P);
    for (const row of res.sequence) {
      const sp = byId.get(row.song_id).spokenness;
      if (row.trace.p_soft_relaxed) relaxed++;
      else { kept++; assert.ok(sp === null || sp === undefined || sp < th, `${row.song_id} 말 비중 ${sp} ≥ ${th}`); }
    }
    assert.equal(res.personal.soft_relaxed_steps, res.sequence.filter((row) => row.trace.p_soft_relaxed).length);
  }
  assert.ok(kept > 150 && relaxed > 0, `통과 ${kept} · 완화 ${relaxed}`);
});

test("adjFeatures / adjCost (§4.8.1–4.8.2)", () => {
  const P = E.sanitizePersonal({ ...p0Policy(rules) }, rules, {});
  const a = { tempo: 0.2, instrumental: false, spokenness: 0.1, genres: ["pop"] };
  const b = { tempo: 0.6, instrumental: true, spokenness: 0.35, genres: ["jazz"] };
  const x = E.adjFeatures(a, b, P);
  assert.deepEqual(x, { tempo: 1, vocal: 1, spoken: 0.5, genre: 1, bpm_diff: 60 });   // BPM 80 vs 140 → 60/60
  const w = P.adj_w;
  assert.equal(E.adjCost(a, b, P), Math.round((w.tempo + w.vocal + 0.5 * w.spoken + w.genre) * 1e9) / 1e9);
  assert.ok(Math.abs(E.adjCost(a, b, P) - band * Z.adjacency.scale * (0.4 + 0.3 + 0.15 * 0.5 + 0.15)) < 1e-9);   // 기본 가중 × scale(D7 스윕 값)
  // 모르는 값은 0, 장르 겹치면 0, 한쪽 장르 없음 0
  assert.deepEqual(E.adjFeatures({ tempo: null, genres: [] }, { tempo: 0.5, instrumental: true, genres: ["pop"] }, P), { tempo: 0, vocal: 0, spoken: 0, genre: 0, bpm_diff: null });
  assert.equal(E.adjFeatures({ genres: ["pop", "rock"] }, { genres: ["rock"] }, P).genre, 0);
  assert.equal(E.adjFeatures({ tempo: 0.3 }, { tempo: 0.4 }, P).tempo, 0.25);   // BPM 차 15 / 60
  assert.equal(E.adjFeatures({ tempo: 0.3 }, { tempo: 0.4 }, P).bpm_diff, 15);
  // 반·배 박자 접기: 80 vs 170 → |2·80 − 170| = 10
  const F = E.sanitizePersonal({ half_double_fold: true }, rules, {});
  assert.equal(E.adjFeatures({ tempo: 0.2 }, { tempo: 0.8 }, F).bpm_diff, 10);
  assert.equal(E.adjCost(a, b, E.sanitizePersonal({}, rules, {})), 0, "중립은 0");
  // 정규화 전 정책(bpm_offset·bpm_per_tag 없음 — personal.js 학습용)도 규칙과 같은 BPM 환산
  const rawP = { bpm_scale: Z.adjacency.bpm_scale, spoken_scale: Z.adjacency.spoken_scale, half_double_fold: true };
  assert.deepEqual(E.adjFeatures({ tempo: 0.2 }, { tempo: 0.8 }, rawP), E.adjFeatures({ tempo: 0.2 }, { tempo: 0.8 }, F));
  assert.equal(Z.adjacency.bpm_offset + Z.adjacency.bpm_per_tag * 0.2, 80);
  assert.equal(E.adjCost(null, b, P), 0);
  // 엔진 경로의 p_adj 는 앞 곡과의 adjCost
  const res = run({ ...LONG, duration_min: 60, seed: "adj" }, p0Policy(rules));
  const S = E.sanitizePersonal(p0Policy(rules), rules, {});
  const ids = res.sequence.map((x) => x.song_id);
  // 머묾 재배열 전 순서는 알 수 없으므로 이동 구간(재배열 안 됨)만 확인
  res.sequence.forEach((row, i) => {
    if (row.trace.p_phase !== "move") return;
    const want = i === 0 ? 0 : E.adjCost(byId.get(ids[i - 1]), byId.get(row.song_id), S);
    assert.ok(Math.abs(row.trace.p_adj - want) < 1e-6);
    assert.equal(row.trace.p_bpm_diff, i === 0 ? null : E.adjFeatures(byId.get(ids[i - 1]), byId.get(row.song_id), S).bpm_diff);
  });
});

test("aggregateAffinity opts: vote 항목 · scope_add · extra_feature_ids", () => {
  const s = catalog.find((x) => x.artist && !x.artist.includes(";") && x.feature_bins_p.popularity);
  const base = { song_id: s.song_id, artist: s.artist, genres: s.genres, feature_bins: s.feature_bins, feature_bins_p: s.feature_bins_p, days: 3 };
  // vote 가 있으면 그 표를 그대로(좋아요·완주 판단보다 먼저)
  const v = E.aggregateAffinity([{ ...base, vote: { pos: 0.25, neg: 0, pin: 0 }, completion: 0 }], rules);
  assert.deepEqual(v.like_base, { pos: 0.25, neg: 0 });
  assert.equal(v.song_likes[s.song_id].pos, 0.25);
  assert.equal(v.song_likes[s.song_id].last_days, 3);
  assert.equal(E.aggregateAffinity([{ ...base, vote: { pos: "x", neg: 0.125 } }], rules).like_base.neg, 0.125);
  // scope_add: 도착·길이 불만 싫어요는 어떤 묶음에도 세지 않는다(없으면 _no_reason = 취향 전체)
  for (const reason of ["arrival_mismatch", "length"]) {
    const d = { ...base, disliked: true, reason };
    const without = E.aggregateAffinity([d], rules);
    const withAdd = E.aggregateAffinity([d], rules, { scope_add: Z.taste.dislike_scope_add });
    assert.equal(without.like_base.neg, 1);
    assert.deepEqual(withAdd, { like_base: { pos: 0, neg: 0 }, song_likes: {}, artist_affinity: {}, genre_affinity: {}, feature_affinity: {} });
  }
  // 규칙 기본 절은 그대로
  assert.ok(!("arrival_mismatch" in rules.preference.dislike_scope));
  // extra_feature_ids: feature_bins_p 묶음에도 표
  const x = E.aggregateAffinity([{ ...base, liked: true }], rules, { extra_feature_ids: ["popularity"] });
  assert.equal(x.feature_affinity[`popularity:${s.feature_bins_p.popularity}`].pos, 1);
  assert.equal(E.aggregateAffinity([{ ...base, liked: true }], rules).feature_affinity[`popularity:${s.feature_bins_p.popularity}`], undefined);
  // vocal_bother 는 말 비중·연주곡 여부 묶음에만 — 추가 특징(인기도)에는 안 센다
  const vb = E.aggregateAffinity([{ ...base, disliked: true, reason: "vocal_bother" }], rules, { extra_feature_ids: ["popularity"] });
  assert.equal(Object.keys(vb.feature_affinity).some((k) => k.startsWith("popularity:")), false);
});

test("makeExtraBinner: 0 은 모름(경계에서도 뺀다), 3분위", () => {
  const specs = Z.taste.extra_features_available;
  const bin = E.makeExtraBinner(catalog, specs);
  const nz = catalog.map((s) => s.popularity).filter((x) => x > 0).sort((a, b) => a - b);
  assert.deepEqual(bin.cuts.popularity, [nz[Math.floor(nz.length / 3)], nz[Math.floor(nz.length * 2 / 3)]]);
  assert.deepEqual(bin({ popularity: 0 }), {});
  assert.deepEqual(bin({ popularity: 100 }), { popularity: "high" });
  assert.deepEqual(bin({ popularity: 1 }), { popularity: "low" });
  assert.deepEqual(E.makeExtraBinner(catalog, null)({ popularity: 5 }), {});
  const counts = { low: 0, mid: 0, high: 0 };
  for (const s of catalog) if (s.popularity) counts[bin(s).popularity]++;
  assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) < nz.length * 0.1);
});

test("taste_features(P2): 추가 특징 묶음이 선호 점수에 들어간다 — 정책에 있을 때만", () => {
  const hiPop = catalog.filter((s) => s.feature_bins_p.popularity === "high");
  const items = hiPop.slice(0, 30).map((s) => ({ song_id: "X" + s.song_id, feature_bins_p: s.feature_bins_p, vote: { pos: 1, neg: 0, pin: 0 } }))
    .concat(catalog.filter((s) => s.feature_bins_p.popularity === "low").slice(0, 30).map((s) => ({ song_id: "Y" + s.song_id, feature_bins_p: s.feature_bins_p, vote: { pos: 0, neg: 1, pin: 0 } })));
  const user = { ...E.aggregateAffinity(items, rules, { extra_feature_ids: ["popularity"] }), disliked: [], recent_played: [] };
  const inp = { ...LONG, duration_min: 45, seed: "tf", user };
  const P = { ...p0Policy(rules), mu: 0.5 };
  const a = run(inp, P), b = run(inp, { ...P, taste_features: Z.taste.extra_features_available });
  const popHi = (res) => res.sequence.filter((row) => byId.get(row.song_id).feature_bins_p.popularity === "high").length;
  assert.ok(popHi(b) >= popHi(a));
  assert.ok(b.sequence.some((row) => (row.trace.pref_basis || "").includes("알려진 정도")), "설명 근거에 추가 특징 이름");
  assert.ok(a.sequence.every((row) => !(row.trace.pref_basis || "").includes("알려진 정도")));
});

test("p_* trace(§6.8): 모든 키가 rules.trace_keys 에 있고 값 모양이 맞다", () => {
  const r = makeRng("trace");
  const chosen = new Set();
  for (let t = 0; t < 80; t++) {
    const inp = randomInputs(r, catalog, rules);
    const res = run(inp, randomPolicy(r, rules, catalog, { spec: t % 2 === 0 }));
    for (const row of res.sequence) {
      const tr = row.trace;
      for (const k of Object.keys(tr)) if (k.startsWith("p_")) assert.ok(rules.trace_keys.includes(k), k);
      assert.ok(["move", "hold"].includes(tr.p_phase));
      assert.ok(["geometry", "taste", "transition", "discovery", "replay", "beam"].includes(tr.p_chosen_by), tr.p_chosen_by);
      assert.equal(typeof tr.p_geo_best, "string"); assert.ok(byId.has(tr.p_geo_best));
      if (tr.p_chosen_by === "geometry") assert.equal(tr.p_geo_best, row.song_id);
      else assert.notEqual(tr.p_geo_best, row.song_id);
      for (const f of ["tempo", "vocal", "spoken", "genre"]) assert.ok(tr.p_adj_x[f] >= 0 && tr.p_adj_x[f] <= 1);
      assert.ok(tr.p_adj >= 0);
      assert.equal(typeof tr.p_corridor, "boolean");
      assert.equal(tr.p_smooth, tr.p_smooth_basis !== null);
      if (tr.p_smooth) {
        assert.equal(tr.p_chosen_by, "transition");
        assert.ok(row.explanations.includes(`앞 곡과 ${tr.p_smooth_basis} 흐름을 이어 골랐어요.`));
      }
      assert.equal(tr.p_extra, false);
      chosen.add(tr.p_chosen_by);
    }
    if (res.sequence.length) assert.deepEqual(Object.keys(res.personal).sort(),
      ["digest", "discovery_step", "hold_radius_used", "soft_relaxed_steps", "start_offset_used", "tp_used"]);
  }
  for (const c of ["geometry", "taste", "transition", "beam"]) assert.ok(chosen.has(c), `p_chosen_by ${c} 가 한 번은 나온다`);
});

test("workingCoords 는 trace 의 작업 좌표(song_V/song_A)와 같다", () => {
  const res = run({ ...LONG, duration_min: 60 }, undefined);
  for (const row of res.sequence) {
    const c = coords.get(row.song_id);
    assert.equal(row.trace.song_V, Math.round(c[0] * 1e6) / 1e6);
    assert.equal(row.trace.song_A, Math.round(c[1] * 1e6) / 1e6);
  }
  assert.equal(coords.size, catalog.length);
});

test("seededUniform(§3.7): 결정적 [0,1), 시드 없으면 0.5, 키마다 다르고 곡 지터와 겹치지 않는다", () => {
  assert.equal(E.seededUniform(null, "discovery"), 0.5);
  assert.equal(E.seededUniform("", "discovery"), 0.5);
  assert.equal(E.seededUniform(undefined), 0.5);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const u = E.seededUniform(`u:2026-09-27:${i}`, "discovery");
    assert.ok(u >= 0 && u < 1);
    assert.equal(u, E.seededUniform(`u:2026-09-27:${i}`, "discovery"));
    seen.add(Math.floor(u * 10));
  }
  assert.equal(seen.size, 10, "고르게 퍼진다");
  assert.notEqual(E.seededUniform("s", "a"), E.seededUniform("s", "b"));
  assert.notEqual(E.seededUniform("s", "a", "b"), E.seededUniform("s", "a|b".replace("|", "")));
  // 곡 지터(seed|song|step)와 같은 문자열이 되지 않는다: § 접두어
  assert.equal(E.seededUniform("s", "S0001", 0), E.seededUniform("s", "S0001", "0"));
});

test("result.personal: P 모드에서만, 빈 후보에서도 모양 유지", () => {
  const res = run({ ...LONG, gates: ["exclude_instrumental", "instrumental_only"] }, p0Policy(rules));
  assert.deepEqual(res.sequence, []);
  assert.equal(res.personal.discovery_step, null); assert.equal(res.personal.soft_relaxed_steps, 0);
  assert.equal(run({ ...LONG, gates: ["exclude_instrumental", "instrumental_only"] }, undefined).personal, undefined);
  assert.equal(run(LONG, { ...p0Policy(rules), digest: "abc" }).personal.digest, "abc");
});

test("머묾 경로 비용 양자화(hold_path_q, 20260929): 결정적이고, 시드만 다른 세션의 마지막 곡이 더 갈린다(§11 B5) · 머묾 묶음과 함께면 머묾 안 꺾임 0", () => {
  const tm = Z.safety.envelope.turn_min;
  const C = (x) => coords.get(x.song_id);
  let endsOn = 0, endsOff = 0, groups = 0;
  for (const [now, target] of [[{ V: 0.3, A: 0.7 }, { V: 0.7, A: 0.3 }], [{ V: 0.2, A: 0.3 }, { V: 0.8, A: 0.8 }], [{ V: 0.6, A: 0.2 }, { V: 0.3, A: 0.75 }]]) {
    const on = new Set(), off = new Set();
    for (let k = 0; k < 24; k++) {
      const inp = { now, target, duration_min: 45, seed: `pq:${k}` };
      /* 1차 수정의 조합에서 이 훅 하나만 켜고 끈다 — 2차의 흔들기·묶음 깨기(pers_jitter·hold_break)는 따로 시험한다(아래 두 시험) */
      const base = { ...p0Policy(rules), hold_cluster: true, pers_jitter: null, hold_break: null };
      const a = run(inp, { ...base, hold_path_q: true });
      assert.deepEqual(run(inp, { ...base, hold_path_q: true }).sequence.map((x) => x.song_id), a.sequence.map((x) => x.song_id), "결정적");
      const b = run(inp, { ...base, hold_path_q: false });
      on.add(a.sequence.at(-1).song_id); off.add(b.sequence.at(-1).song_id);
      /* 도착한 머묾 곡들 사이엔 꺾임 없음(묶음 지름 ≤ turn_min) */
      const hs = a.sequence.findIndex((x) => x.trace.p_phase === "hold");
      const h = a.sequence.slice(hs);
      if (h.every((x) => x.trace.p_corridor)) for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++)
        assert.ok(Math.hypot(C(h[i])[0] - C(h[j])[0], C(h[i])[1] - C(h[j])[1]) <= tm + 1e-9);
    }
    endsOn += on.size; endsOff += off.size; groups++;
  }
  assert.ok(endsOn >= endsOff, `서로 다른 마지막 곡 ${endsOn} vs 양자화 없음 ${endsOff} (${groups}개 입력 × 시드 24)`);
  // 중립 정책은 끈다(I1)
  assert.equal(E.sanitizePersonal(neutralPolicy(rules), rules, { duration_min: 30 }).hold_path_q, false);
});

test("묶음 깨기 비용(hold_break = j_hold, 20260929): 결정적 · 지그재그 0 · 도착 영역의 묶음 밖 곡끼리는 목표 거리와 무관하게 동률 → 마지막 곡이 더 갈린다(§11 B5)", () => {
  const sparse = makeCatalog(rules, 300, "wp-hold-break");   // 목표 근처가 성긴 카탈로그 — 묶음이 자주 모자란다
  const Cs = E.workingCoords(sparse, rules);
  let endsOn = 0, endsOff = 0, breakers = 0;
  for (const [now, target] of [[{ V: 0.3, A: 0.7 }, { V: 0.7, A: 0.3 }], [{ V: 0.2, A: 0.3 }, { V: 0.8, A: 0.8 }], [{ V: 0.6, A: 0.2 }, { V: 0.3, A: 0.75 }], [{ V: 0.8, A: 0.7 }, { V: 0.25, A: 0.2 }]]) {
    const on = new Set(), off = new Set();
    for (let k = 0; k < 24; k++) {
      const inp = { now, target, duration_min: 45, seed: `hb:${k}` };
      const P1 = { ...p0Policy(rules), hold_cluster: true, hold_break: Z.safety.j_hold }, P0x = { ...P1, hold_break: null };
      const a = E.recommend(sparse, rules, { ...inp, personal: P1 });
      assert.deepEqual(E.recommend(sparse, rules, { ...inp, personal: P1 }).sequence.map((x) => x.song_id), a.sequence.map((x) => x.song_id), "결정적");
      const b = E.recommend(sparse, rules, { ...inp, personal: P0x });
      on.add(a.sequence.at(-1).song_id); off.add(b.sequence.at(-1).song_id);
      const hold = a.sequence.filter((x) => x.trace.p_phase === "hold");
      if (hold.length >= 2) for (const h of hold) assert.ok(hold.at(-1).trace.va_distance <= h.trace.va_distance + 1e-12, "마지막 곡이 가장 가깝다(지그재그 0)");
      breakers += hold.filter((x) => !x.trace.p_corridor).length;
    }
    endsOn += on.size; endsOff += off.size;
  }
  assert.ok(breakers > 0, "묶음 밖 머묾 곡이 실제로 쓰였다");
  assert.ok(endsOn >= endsOff, `서로 다른 마지막 곡 ${endsOn} vs 실거리 비용 ${endsOff}`);
  // 정책이 주지 않으면(null) 이전 동작, 중립은 null(I1). 경계는 머묾 J.
  assert.equal(E.sanitizePersonal(neutralPolicy(rules), rules, { duration_min: 30 }).hold_break, null);
  assert.equal(E.sanitizePersonal({ ...p0Policy(rules), hold_break: 1 }, rules, { duration_min: 30 }).hold_break, Z.bounds.j_hold[1]);
});

test("개인 비용 흔들기(pers_jitter, 20260929): 결정적 · 이동 걸음 p_pers 는 자르지 않은 값, 머묾 걸음은 칸 폭 정수배 · 폭이 없으면 양자화(이전 동작)", () => {
  const r = makeRng("pers-jitter");
  const bucket = Z.safety.pers_bucket_bands * band;
  let moveRows = 0, qRows = 0;
  for (let t = 0; t < 30; t++) {
    const inp = { ...randomInputs(r, catalog, rules), duration_min: r.pick([30, 45, 60]) };
    const PJ = { ...p0Policy(rules), pers_jitter: bucket }, PQ = { ...PJ, pers_jitter: null };
    const a = run(inp, PJ);
    assert.deepEqual(run(inp, PJ).sequence.map((x) => x.song_id), a.sequence.map((x) => x.song_id), "결정적");
    for (const row of a.sequence) {
      const T = row.trace;
      if (T.p_phase === "move") { moveRows++; assert.equal(T.p_pers, R6(Math.min(Z.safety.j_move_bands * band, T.p_adj)), "이동: 자르지 않은 전환 비용(μ = 0)"); }
      else { const q = Math.round(T.p_pers / bucket); assert.ok(Math.abs(T.p_pers - q * bucket) < 1e-6, "머묾: 칸 폭 정수배"); }
    }
    for (const row of run(inp, PQ).sequence) { qRows++; const q = Math.round(row.trace.p_pers / bucket); assert.ok(Math.abs(row.trace.p_pers - q * bucket) < 1e-6, "양자화 모드: 칸 폭 정수배"); }
  }
  assert.ok(moveRows > 50 && qRows > 50, `이동 행 ${moveRows} · 양자화 행 ${qRows}`);
  assert.equal(E.sanitizePersonal(neutralPolicy(rules), rules, { duration_min: 30 }).pers_jitter, null, "중립은 흔들지 않는다(I1)");
});
