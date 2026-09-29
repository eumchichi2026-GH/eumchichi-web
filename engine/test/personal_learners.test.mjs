/* 학습기 — 좌표 보정(§4.1·4.2) · 속도 π·이탈 가드(§4.3) · 시작 오프셋(§4.4) · 감상 시간(§4.5) · 머묾 반경(§4.6) · 게이트(§4.9) · 다양성(§4.10) · 발견 칸(§4.7.4) */
import test from "node:test";
import assert from "node:assert/strict";
import { P, E, RULES, T0, DAY, MIN, VOCAB, lcg, makeCatalog, makeIndex, song, wpRec, fwRec, plays, ev, postChange, rawOf, modelOf, near } from "./personal_harness.test.mjs";

const IDX = makeIndex(makeCatalog(240));
const CHIP = (c) => ({ mode: "chip", chip: c });
const LOW = { v: 0.6, e: 0.5 };   // 스트레스 2 — 고긴장 아님
const HIGH = { v: 0.3, e: 0.72 }; // 불안해요 — 스트레스 3
const withPi = (pi) => { const m = structuredClone(P.emptyModel(RULES)); m.pace.pi = pi; return m; };

// ── 좌표 보정 ────────────────────────────────────────────
function calibRec(id, at, { label = "불안해요", table = { v: 0.3, e: 0.72 }, fin, nudged = true, field = "current" } = {}) {
  const tgtTable = { v: 0.6, e: 0.3 };
  const input = field === "current"
    ? { labels: { current: CHIP(label), target: CHIP("차분해지고 싶어요") }, table_point: { current: table, target: tgtTable }, current_va: fin ?? table,
        target_va: tgtTable, nudged: { current: nudged, target: false } }
    : { labels: { current: CHIP("불안해요"), target: CHIP(label) }, table_point: { current: { v: 0.3, e: 0.72 }, target: table }, current_va: { v: 0.3, e: 0.72 },
        target_va: fin ?? table, nudged: { current: false, target: nudged } };
  return wpRec(id, at, { path: ["S0001"], input });
}

test("좌표 보정 계산 예 — 「불안해요」를 세 번 활력 −0.10 쪽으로 끌면 δ = −0.094 (§4.1.2; w_edit 1 → 3 변경 20260929, 이전 예 −0.077)", () => {
  const W = RULES.personalization.calib.w_edit;   // 직접 옮김 가중(규칙 값)
  const recs = [0, 1, 2].map((k) => calibRec("c" + k, T0, { fin: { v: 0.3, e: 0.62 } }));
  const { model } = modelOf(rawOf({ recs, as_of_ms: T0 }), IDX);
  const r = model.calib.current.labels["불안해요"];
  const g = -0.30 * W / (3 * W + 4);
  near(model.calib.current.g.de, g);
  near(r.de, (-0.30 * W + 2 * g) / (3 * W + 2), 1e-9, "δ");
  if (W === 3) assert.equal(Math.round(r.de * 1000) / 1000, -0.094);
  if (W === 1) assert.equal(Math.round(r.de * 1000) / 1000, -0.077);
  near(r.dv, 0);
  assert.equal(r.n_edit, 3);
  assert.equal(r.applied, true);
  const c = P.calibratePoint(model, "current", CHIP("불안해요"), { v: 0.3, e: 0.72 }, RULES);
  assert.equal(c.point.v, 0.3);
  near(c.point.e, 0.72 + (-0.30 * W + 2 * g) / (3 * W + 2), 1e-6);   // 다음엔 (0.30, 0.626)에서 시작(w_edit 3; 1 이면 0.643)
  near(c.applied.de, (-0.30 * W + 2 * g) / (3 * W + 2), 1e-8);
  assert.deepEqual(c.basis, { label: "불안해요", n_edit: 3 });
  // labels 전체({current, target})를 넘겨도 같다
  assert.deepEqual(P.calibratePoint(model, "current", { current: CHIP("불안해요") }, { v: 0.3, e: 0.72 }, RULES).point, c.point);
  // 목표는 받아들임만 있었으므로 그대로
  const t = P.calibratePoint(model, "target", CHIP("차분해지고 싶어요"), { v: 0.6, e: 0.3 }, RULES);
  assert.deepEqual(t.point, { v: 0.6, e: 0.3 });
  assert.equal(t.applied, null);
});

test("좌표 보정 — 옮김이 문턱(단어 2번·필드 4번) 미만이면 δ = 0", () => {
  const { model } = modelOf(rawOf({ recs: [calibRec("c0", T0, { fin: { v: 0.3, e: 0.62 } })], as_of_ms: T0 }), IDX);
  assert.equal(model.calib.current.labels["불안해요"].applied, false);
  assert.equal(P.calibratePoint(model, "current", CHIP("불안해요"), { v: 0.3, e: 0.72 }, RULES).applied, null);
  // 필드 전체 4번이면 옮기지 않은 단어도 필드 치우침 g 로 보정된다
  const recs = ["불안해요", "짜증나요", "답답해요", "걱정돼요"].map((l, k) => {
    const tb = VOCAB.mood_chips.find((c) => c[0] === l);
    return calibRec("g" + k, T0, { label: l, table: { v: tb[1], e: tb[2] }, fin: { v: tb[1], e: tb[2] - 0.1 } });
  });
  const m2 = modelOf(rawOf({ recs, as_of_ms: T0 }), IDX).model;
  assert.equal(m2.calib.current.n_edit, 4);
  assert.equal(m2.calib.current.labels["불안해요"].applied, true);
  assert.ok(m2.calib.current.labels["불안해요"].de < 0);
});

test("좌표 보정 — 0.5 넘기 보호: 같은 방향 옮김 4번 미만이면 중립에서 멈춘다", () => {
  const table = { v: 0.45, e: 0.5 };
  const mk = (n) => modelOf(rawOf({ recs: Array.from({ length: n }, (_, k) => calibRec("x" + k, T0, { label: "테스트", table, fin: { v: 0.55, e: 0.5 } })), as_of_ms: T0 }), IDX).model;
  const W = RULES.personalization.calib.w_edit;   // 직접 옮김 가중(20260929 에 1 → 3)
  const m3 = mk(3);
  near(m3.calib.current.labels["테스트"].dv, (0.3 * W + 2 * (0.3 * W / (3 * W + 4))) / (3 * W + 2));
  const c3 = P.calibratePoint(m3, "current", CHIP("테스트"), table, RULES);
  near(c3.point.v, 0.5);   // 0.527 이 되려 했지만 0.5 에서 멈춤
  const m4 = mk(4);
  const c4 = P.calibratePoint(m4, "current", CHIP("테스트"), table, RULES);
  near(c4.point.v, 0.45 + (0.4 * W + 2 * (0.4 * W / (4 * W + 4))) / (4 * W + 2));
  assert.ok(c4.point.v > 0.5);
});

test("좌표 보정 — 축마다 |δ| ≤ 0.10, 마지막에 nlClamp [0.04, 0.96]", () => {
  const recs = Array.from({ length: 20 }, (_, k) => calibRec("m" + k, T0, { label: "화나요", table: { v: 0.1, e: 0.9 }, fin: { v: 0.02, e: 1 } }));
  const { model } = modelOf(rawOf({ recs, as_of_ms: T0 }), IDX);
  const r = model.calib.current.labels["화나요"];
  assert.ok(Math.abs(r.dv) <= 0.1 + 1e-12 && Math.abs(r.de) <= 0.1 + 1e-12);
  const c = P.calibratePoint(model, "current", CHIP("화나요"), { v: 0.1, e: 0.9 }, RULES);
  assert.ok(c.point.v >= 0.04 && c.point.e <= 0.96, JSON.stringify(c.point));
});

test("좌표 보정 — 탭은 관측이 아니고, 받아들임은 가중 0.25", () => {
  const W = RULES.personalization.calib.w_edit;
  const tap = wpRec("t0", T0, { path: ["S0001"], input: { labels: { current: { mode: "tap" }, target: { mode: "tap" } }, table_point: { current: null, target: null },
                                                         nudged: { current: true, target: true } } });
  const m1 = modelOf(rawOf({ recs: [tap], as_of_ms: T0 }), IDX).model;
  assert.deepEqual(m1.calib.current.labels, {});
  assert.equal(m1.calib.current.g.W, 0);
  const acc = calibRec("a0", T0, { nudged: false });
  const m2 = modelOf(rawOf({ recs: [acc], as_of_ms: T0 }), IDX).model;
  near(m2.calib.current.labels["불안해요"].W, 0.25);
  assert.equal(m2.calib.current.labels["불안해요"].n_edit, 0);
  // 보정된 점을 받아들이면 그 보정을 약하게 강화한다: 옮김 3(가중 w_edit) + 보정점 받아들임 1 → W = 3·w_edit + 0.25
  const recs = [0, 1, 2].map((k) => calibRec("c" + k, T0, { fin: { v: 0.3, e: 0.62 } }));
  recs.push(calibRec("c3", T0, { fin: { v: 0.3, e: 0.643 }, nudged: false }));
  const m3 = modelOf(rawOf({ recs, as_of_ms: T0 }), IDX).model;
  near(m3.calib.current.labels["불안해요"].W, 3 * W + 0.25);
});

test("좌표 보정 — 60일 반감 (§3.6)", () => {
  const recs = [0, 1, 2].map((k) => calibRec("c" + k, T0, { fin: { v: 0.3, e: 0.62 } }));
  const m = modelOf(rawOf({ recs, as_of_ms: T0 + 60 * DAY }), IDX).model;
  near(m.calib.current.labels["불안해요"].W, 1.5 * RULES.personalization.calib.w_edit, 1e-9);   // 옮김 3 × w_edit × ½
});

test("좌표 보정 — 자연어 두 단어는 강도 비율로 나눠 준다", () => {
  const rec = wpRec("n0", T0, { path: ["S0001"], input: {
    labels: { current: { mode: "nl", nl: [{ label: "불안해요", intensity: 2 }, { label: "지쳤어요", intensity: 1 }] }, target: CHIP("차분해지고 싶어요") },
    table_point: { current: { v: 0.3, e: 0.56 }, target: { v: 0.6, e: 0.3 } }, current_va: { v: 0.3, e: 0.46 }, nudged: { current: true, target: false } } });
  const { model } = modelOf(rawOf({ recs: [rec], as_of_ms: T0 }), IDX);
  const W = RULES.personalization.calib.w_edit;
  near(model.calib.current.labels["불안해요"].W, 2 * W / 3);
  near(model.calib.current.labels["지쳤어요"].W, W / 3);
});

test("좌표 보정 — 옛 기록은 칩·자연어 좌표와 정확히 같을 때만 받아들임 관측 (심사 C-7)", () => {
  const recs = [
    fwRec("f1", T0, { path: ["S0001"], input: { current_va: { v: 0.3, e: 0.72 }, target_va: { v: 0.6, e: 0.3 } } }),     // 칩 그대로
    fwRec("f2", T0, { path: ["S0001"], input: { current_va: { v: 0.35, e: 0.72 }, target_va: { v: 0.65, e: 0.3 } } }),   // 화살표로 옮김 — 버림
    fwRec("f3", T0, { path: ["S0001"], input: { current_va: { v: 0.24, e: 0.786 }, target_va: { v: 0.62, e: 0.08 },
      input_mode: { current: "nl", target: "nl" }, nl_v2: { final: { current: [{ label: "불안해요", intensity: 3 }], target: "잠들고 싶어요", constraints: {} } } } }),
    fwRec("f4", T0, { path: ["S0001"], input: { current_va: { v: 0.25, e: 0.786 }, target_va: { v: 0.62, e: 0.08 },
      input_mode: { current: "nl", target: "tap" }, nl_v2: { final: { current: [{ label: "불안해요", intensity: 3 }], target: null, constraints: {} } } } }),
  ];
  const { model, norm } = modelOf(rawOf({ recs, as_of_ms: T0 }), IDX);
  assert.deepEqual(norm.sessions.map((s) => s.input.labels.current && s.input.labels.current.mode), ["chip", null, "nl", null]);
  const L = model.calib.current.labels["불안해요"];
  near(L.W, 0.5);   // f1(칩) + f3(자연어) 받아들임 2건 × 0.25
  assert.equal(L.n_edit, 0);
  near(model.calib.target.labels["차분해지고 싶어요"].W, 0.25);
  near(model.calib.target.labels["잠들고 싶어요"].W, 0.25);
  assert.equal(model.calib.target.labels["차분해지고 싶어요"].dv, 0);
});

test("목표 좌표는 사용자 옮김 관측 없이는 절대 바뀌지 않는다 (§4.2 속성 시험, 무작위 세션 1,000)", () => {
  const r = lcg(42);
  const goals = [...VOCAB.goal_chips, ...VOCAB.nl_extra_goal];
  const recs = [];
  for (let k = 0; k < 1000; k++) {
    const g = goals[Math.floor(r() * goals.length)];
    const nl = r() < 0.3;
    const rec = calibRec("p" + k, T0 + k * MIN, { field: "target", label: g[0], table: { v: g[1], e: g[2] }, nudged: false });
    if (nl) rec.input.labels.target = { mode: "nl", nl: g[0] };
    // 지금 좌표는 마음대로 끈다 — 목표에는 영향 없음
    rec.input.nudged.current = r() < 0.5; rec.input.current_va = { v: 0.3 + (r() - 0.5) * 0.2, e: 0.72 };
    recs.push(rec);
  }
  const { model } = modelOf(rawOf({ recs, as_of_ms: T0 + 1000 * MIN }), IDX);
  for (const g of goals) {
    const c = P.calibratePoint(model, "target", CHIP(g[0]), { v: g[1], e: g[2] }, RULES);
    assert.deepEqual(c.point, { v: g[1], e: g[2] }, g[0]);
    assert.equal(c.applied, null);
  }
});

test("안내 — 같은 단어로 mood_mismatch(위치 ≤ 2) 2번이면 한 번 안내, 7일 안에는 반복하지 않는다 (§4.1.5)", () => {
  const recs = [], events = [];
  for (let k = 0; k < 2; k++) {
    const at = T0 + k * DAY;
    recs.push(wpRec("m" + k, at, { path: ["S0001", "S0002", "S0003"] }));
    events.push(ev("m" + k, at + MIN, "dislike_reason", { song_id: "S0001", reason: "mood_mismatch", position: 1, role: "path", phase: "move" }));
    events.push(postChange("m" + k, at + 2 * MIN, { reasons: { arrival_mismatch: "user" } }));
  }
  const raw = rawOf({ recs, events, as_of_ms: T0 + 3 * DAY });
  const { model } = modelOf(raw, IDX);
  assert.deepEqual(model.calib.prompts.current, ["불안해요"]);
  assert.deepEqual(model.calib.prompts.target, ["차분해지고 싶어요"]);
  const c = P.calibratePoint(model, "current", CHIP("불안해요"), { v: 0.3, e: 0.72 }, RULES);
  assert.match(c.prompt, /점을 끌어서/);
  assert.equal(c.prompt_key, "current:불안해요");
  assert.equal(c.applied, null);   // 방향 없는 불만은 좌표를 움직이지 않는다
  raw.profile.wp_personal_v1 = { calib_prompt_seen: { "current:불안해요": T0 + 2 * DAY } };
  assert.deepEqual(modelOf(raw, IDX).model.calib.prompts.current, []);
});

// ── 속도 π ───────────────────────────────────────────────
test("속도 계산 예 — '빠르게' 1번이면 π = 0.60, 30분 tp = 0.54 → 5번째 곡 도착 (§4.3.3)", () => {
  const recs = [wpRec("p0", T0, { path: ["S0001"], input: { pace_user: "fast" } })];
  const { model } = modelOf(rawOf({ recs, as_of_ms: T0 + DAY }), IDX);
  near(model.pace.pi, 0.6);
  const out = P.resolvePolicy(model, { now: LOW, minutes: 30 }, RULES);
  near(out.policy.tp, 0.54);
  near(out.meta.params.pi_used, 0.6);
  // 엔진에 넣으면 감정 변화 지도에서 도착이 한 칸 앞당겨진다(기본 6번째 → 5번째)
  const cat = makeCatalog(240);
  const base = { now: { V: 0.45, A: 0.2 }, target: { V: 0.8, A: 0.85 }, duration_min: 30, seed: "t:1" };
  const resA = E.recommend(cat, RULES, { ...base, user: out.user, personal: out.policy });
  const ref = P.resolvePolicy(model, { now: LOW, minutes: 30 }, RULES, { mode: "p0" });
  const resR = E.recommend(cat, RULES, { ...base, user: ref.user, personal: ref.policy });
  assert.equal(resA.sequence.length, 8);
  const firstHold = (res) => res.sequence.findIndex((x) => x.trace.p_phase === "hold") + 1;
  assert.equal(firstHold(resA), 5);
  assert.equal(firstHold(resR), 6);
  near(resA.personal.tp_used, 0.54, 1e-6);
});

test("속도 계산 예 — 그 다음 세션 '딱 좋았어요'(v = 0.60)면 π = 0.57", () => {
  const recs = [wpRec("p0", T0, { path: ["S0001"], input: { pace_user: "fast" } }),
                wpRec("p1", T0 + DAY, { path: ["S0001"], input: { personal_meta: { params: { pi_used: 0.6 } } } })];
  const events = [postChange("p1", T0 + DAY + MIN, { pace_answer: "ok" })];
  const { model } = modelOf(rawOf({ recs, events, as_of_ms: T0 + 2 * DAY }), IDX);
  near(model.pace.pi, (0.85 * 1.5 + 0.6) / (0.85 * 1.5 + 1 + 1));
  assert.equal(Math.round(model.pace.pi * 100) / 100, 0.57);
  assert.equal(model.pace.votes, 2);
  assert.equal(model.evidence.n_pace_votes, 2);
  // '더 빨리' 는 π_used + 0.5, '더 천천히' 는 π_used − 0.5 (±1 로 자름)
  const faster = modelOf(rawOf({ recs: [recs[1]], events: [postChange("p1", T0 + DAY + MIN, { pace_answer: "faster" })], as_of_ms: T0 + 2 * DAY }), IDX).model;
  near(faster.pace.pi, 1 * 1 / (1 + 1));   // v = clamp(0.6 + 0.5) = 1
  const slower = modelOf(rawOf({ recs: [recs[1]], events: [postChange("p1", T0 + DAY + MIN, { pace_answer: "slower" })], as_of_ms: T0 + 2 * DAY }), IDX).model;
  near(slower.pace.pi, 0.1 / 2);
});

test("속도 π → tp 표 (π × 15·30·60분) · 적용 문턱 0.15", () => {
  const exp = { "1": [0.5, 0.5, 0.5], "0.6": [0.7, 0.54, 0.54], "0": [null, null, null], "-0.6": [1.0, 0.84, 0.84], "-1": [1.0, 1.0, 1.0], "0.1": [null, null, null] };
  for (const [pi, row] of Object.entries(exp)) [15, 30, 60].forEach((min, i) => {
    const tp = P.resolvePolicy(withPi(Number(pi)), { now: LOW, minutes: min }, RULES).policy.tp;
    if (row[i] === null) assert.equal(tp, null, `π ${pi} ${min}분`);
    else near(tp, row[i], 1e-9, `π ${pi} ${min}분`);
  });
});

test("속도 — n ≤ 3 이면 tp ≥ 0.75 · 고긴장은 기본보다 빠를 수 없음 · 버튼이 이긴다 (I4·I5)", () => {
  near(P.resolvePolicy(withPi(1), { now: LOW, minutes: 10 }, RULES).policy.tp, 0.75);
  const hi = P.resolvePolicy(withPi(0.6), { now: HIGH, minutes: 30 }, RULES);
  assert.equal(hi.policy.tp, null);
  assert.equal(hi.meta.params.pi_used, 0);
  assert.equal(hi.policy.high_stress, true);
  near(P.resolvePolicy(withPi(-0.6), { now: HIGH, minutes: 30 }, RULES).policy.tp, 0.84);   // 느리게는 허용
  const btn = P.resolvePolicy(withPi(0.6), { now: LOW, minutes: 30, pace_user: "slow" }, RULES);
  assert.equal(btn.policy.tp, null);
  assert.equal(btn.meta.params.pi_used, -1);
  assert.equal(P.resolvePolicy(withPi(0.6), { now: HIGH, minutes: 30, pace_user: "fast" }, RULES).meta.params.pi_used, 1);
  assert.equal(P.resolvePolicy(withPi(0.6), { now: LOW, minutes: 30 }, RULES, { mode: "p0" }).policy.tp, null);
});

test("속도 — 방향 없는 신호(arrival_mismatch·post_change.change)는 속도 표가 아니다 (§5, 심사 B-4)", () => {
  const recs = [wpRec("a0", T0, { path: ["S0001"] })];
  const events = [postChange("a0", T0 + MIN, { change: -2, reasons: { arrival_mismatch: "user", length: "user" } })];
  const { model } = modelOf(rawOf({ recs, events }), IDX);
  assert.equal(model.pace.pi, 0);
  assert.equal(model.pace.votes, 0);
});

test("이탈 가드 — 늘 5번째 곡에서 멈추면 f_med = 0.625 → 도착 5번째 (§4.3.4)", () => {
  const ids = ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006", "S0007", "S0008"];
  const recs = [], events = [];
  for (let k = 0; k < 6; k++) {
    const at = T0 + k * DAY;
    recs.push(wpRec("q" + k, at, { path: ids, holdFrom: 6 }));
    events.push(...plays("q" + k, at, [...ids.slice(0, 4).map((s) => ({ song: s, c: 1 })), { song: ids[4], c: 0.5, cause: "pagehide" }]));
  }
  // 10분 안에 다시 요청한 세션은 멈춤이 아니라 교체 — 제외
  recs.push(wpRec("rq", T0 + 7 * DAY, { path: ids, holdFrom: 6 }), wpRec("rq2", T0 + 7 * DAY + 5 * MIN, { path: ids, holdFrom: 6 }));
  events.push(...plays("rq", T0 + 7 * DAY, [{ song: ids[0], c: 0.5, cause: "new_rec" }]));
  const { model, norm } = modelOf(rawOf({ recs, events, as_of_ms: T0 + 8 * DAY }), IDX);
  assert.equal(norm.sessions.find((s) => s.rec_id === "rq").rerequested_within_10min, true);
  assert.equal(model.pace.quit.n, 6);
  near(model.pace.quit.f_med, 0.625);
  const out = P.resolvePolicy(model, { now: LOW, minutes: 30 }, RULES);
  near(out.policy.quit_frac, 0.625);
  const cat = makeCatalog(240);
  const res = E.recommend(cat, RULES, { now: { V: 0.45, A: 0.2 }, target: { V: 0.8, A: 0.85 }, duration_min: 30, seed: "t:2", user: out.user, personal: out.policy });
  assert.equal(res.sequence.findIndex((x) => x.trace.p_phase === "hold") + 1, 5);
  // '천천히'를 직접 눌렀거나 고긴장이면 끈다 · 5세션 미만이면 없음
  assert.equal(P.resolvePolicy(model, { now: LOW, minutes: 30, pace_user: "slow" }, RULES).policy.quit_frac, null);
  assert.equal(P.resolvePolicy(model, { now: HIGH, minutes: 30 }, RULES).policy.quit_frac, null);
  const few = modelOf(rawOf({ recs: recs.slice(0, 4), events: events.filter((e) => ["q0", "q1", "q2", "q3"].includes(e.rec_id)), as_of_ms: T0 + 8 * DAY }), IDX).model;
  assert.equal(few.pace.quit.f_med, null);
  // 곡을 넘기면 도달이 늘 뿐 줄지 않는다 — 전부 넘겨도 끝까지 가면 f = 1
  const skipAll = [wpRec("s0", T0, { path: ids, holdFrom: 6 })];
  const ev2 = plays("s0", T0, ids.map((s) => ({ song: s, c: 0.1, listened: 20 })));
  assert.equal(modelOf(rawOf({ recs: skipAll, events: ev2 }), IDX).norm.sessions[0].reached_frac, 1);
});

// ── 감상 시간 ────────────────────────────────────────────
test("감상 시간 계산 예 — 30분 '길었어요' 1번 → 25분, 25분에서 두 번 더 → 20분 (§4.5)", () => {
  const lenRec = (id, at, minutes) => wpRec(id, at, { path: ["S0001"], input: { effective: { lyric: "no_preference", genres: [], minutes }, recommend_minutes: minutes } });
  const recs1 = [lenRec("l0", T0, 30)];
  const ev1 = [postChange("l0", T0 + MIN, { length_dir: "long", reasons: { length: "user" } })];
  const m1 = modelOf(rawOf({ recs: recs1, events: ev1, as_of_ms: T0 + DAY }), IDX).model;
  assert.equal(m1.length.base_minutes, 30);
  const s1 = P.suggestMinutes(m1, 30, RULES);
  assert.equal(s1.minutes, 25);
  near(s1.bias_log2, -0.15, 1e-6);
  assert.equal(s1.applied, true);
  const recs2 = [...recs1, lenRec("l1", T0 + DAY, 25), lenRec("l2", T0 + 2 * DAY, 25)];
  const ev2 = [...ev1, postChange("l1", T0 + DAY + MIN, { length_dir: "long", reasons: { length: "user" } }),
               postChange("l2", T0 + 2 * DAY + MIN, { length_dir: "long", reasons: { length: "user" } })];
  const m2 = modelOf(rawOf({ recs: recs2, events: ev2, as_of_ms: T0 + 3 * DAY }), IDX).model;
  assert.equal(m2.length.base_minutes, 25);
  const s2 = P.suggestMinutes(m2, 25, RULES);
  assert.equal(s2.minutes, 20);
  const L = (1 * (Math.log2(25) - 0.3) + 0.85 * (Math.log2(25) - 0.3) + 0.7225 * (Math.log2(30) - 0.3) + Math.log2(25)) / (1 + 0.85 + 0.7225 + 1);
  near(s2.bias_log2, L - Math.log2(25), 1e-6);
  assert.equal(Math.round(Math.pow(2, Math.log2(25) + s2.bias_log2)), 22);   // 약 22분 → 5분 단위 20분
});

test("감상 시간 — 답이 없으면 제안 = base, AI 가 고른 length·방향 없는 length 는 표가 아니다, 자연어가 정한 시간은 base 에서 뺀다", () => {
  const r0 = wpRec("l0", T0, { path: ["S0001"] });
  const none = modelOf(rawOf({ recs: [r0], events: [postChange("l0", T0 + MIN, { reasons: { length: "user" } })] }), IDX).model;
  assert.deepEqual(P.suggestMinutes(none, 30, RULES), { minutes: 30, bias_log2: 0, applied: false });
  const ai = modelOf(rawOf({ recs: [r0], events: [postChange("l0", T0 + MIN, { length_dir: "long", reasons: { length: "ai" } })] }), IDX).model;
  assert.equal(ai.evidence.n_length_votes, 0);
  const nl = wpRec("n0", T0 + DAY, { path: ["S0001"], input: { effective: { minutes: 60 }, nl_v2: { final: { constraints: { minutes: 60 } } } } });
  const m = modelOf(rawOf({ recs: [r0, nl] }), IDX).model;
  assert.equal(m.length.base_minutes, 30);
  assert.equal(P.emptyModel(RULES).length.base_minutes, 30);
  assert.equal(modelOf(rawOf({ profile: { recommend_minutes: 45 } }), IDX).model.length.base_minutes, 45);
});

// ── 머묾 반경 ────────────────────────────────────────────
test("머묾 반경 — 사용자 arrival_mismatch 매 세션: 2세션 뒤 0.02, 4세션 뒤 0 (§4.6.2)", () => {
  const recs = [], events = [];
  const at = (k) => T0 + k * DAY;
  for (let k = 0; k < 4; k++) {
    recs.push(wpRec("h" + k, at(k), { path: ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006"], holdFrom: 5 }));
    events.push(postChange("h" + k, at(k) + MIN, { reasons: { arrival_mismatch: "user" } }));
  }
  const arm = (n) => modelOf(rawOf({ recs: recs.slice(0, n), events: events.slice(0, n), as_of_ms: at(5) }), IDX).model.hold.arm;
  assert.equal(arm(1), 0.035);
  assert.equal(arm(2), 0.02);
  assert.equal(arm(3), 0.02);
  assert.equal(arm(4), 0);
  const m = modelOf(rawOf({ recs, events, as_of_ms: at(5) }), IDX).model;
  assert.equal(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy.hold_radius, 0);
  assert.equal(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES, { mode: "p0" }).policy.hold_radius, 0.035);
  // AI 가 고르고 사용자가 지우지 않은 코드는 0.5 — 4세션에 한 칸
  const aiEv = recs.map((r, k) => postChange(r.id, at(k) + MIN, { reasons: { arrival_mismatch: "ai" } }));
  assert.equal(modelOf(rawOf({ recs: recs.slice(0, 3), events: aiEv.slice(0, 3), as_of_ms: at(5) }), IDX).model.hold.arm, 0.035);
  assert.equal(modelOf(rawOf({ recs, events: aiEv, as_of_ms: at(5) }), IDX).model.hold.arm, 0.02);
});

test("머묾 반경 — 머묾 곡 too_repetitive 2번이면 넓힘 0.05, 고긴장이면 0.035 상한, 옛 기록은 세지 않는다", () => {
  const recs = [], events = [];
  for (let k = 0; k < 2; k++) {
    const at = T0 + k * DAY;
    recs.push(wpRec("w" + k, at, { path: ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006"], holdFrom: 5 }));
    events.push(ev("w" + k, at + MIN, "dislike_reason", { song_id: "S0006", reason: "too_repetitive", position: 6, role: "path", phase: "hold" }));
  }
  const m = modelOf(rawOf({ recs, events, as_of_ms: T0 + 3 * DAY }), IDX).model;
  assert.equal(m.hold.arm, 0.05);
  assert.equal(P.resolvePolicy(m, { now: HIGH, minutes: 30 }, RULES).policy.hold_radius, 0.035);
  // 이동 구간 곡의 too_repetitive · 머묾 곡의 조기 넘김은 반경을 움직이지 않는다
  const ev2 = recs.map((r, k) => ev(r.id, T0 + k * DAY + MIN, "dislike_reason", { song_id: "S0002", reason: "too_repetitive", position: 2, role: "path", phase: "move" }));
  const sk = recs.flatMap((r, k) => plays(r.id, T0 + k * DAY, [{ song: "S0005", pos: 5, c: 0.1, listened: 20 }, { song: "S0006", pos: 6, c: 0.1, listened: 20 }]));
  assert.equal(modelOf(rawOf({ recs, events: [...ev2, ...sk], as_of_ms: T0 + 3 * DAY }), IDX).model.hold.arm, 0.035);
  // 세션 코드 too_repetitive: 위치가 모두 머묾 구간일 때만
  const code = (pos) => recs.map((r, k) => postChange(r.id, T0 + k * DAY + MIN, { reasons: { too_repetitive: "user" }, positions: pos }));
  assert.equal(modelOf(rawOf({ recs, events: code([5, 6]), as_of_ms: T0 + 3 * DAY }), IDX).model.hold.arm, 0.05);
  assert.equal(modelOf(rawOf({ recs, events: code([2, 6]), as_of_ms: T0 + 3 * DAY }), IDX).model.hold.arm, 0.035);
  const fw = [0, 1].map((k) => fwRec("f" + k, T0 + k * DAY, { path: ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006", "S0007", "S0008"] }));
  const fwEv = fw.map((r, k) => legacyEvCode(r.id, T0 + k * DAY + MIN));
  assert.equal(modelOf(rawOf({ recs: fw, events: fwEv, as_of_ms: T0 + 3 * DAY }), IDX).model.hold.arm, 0.035);
});
function legacyEvCode(recId, at) {
  return { id: "pc-" + recId, created_at_ms: at, rec_id: recId, type: "post_change",
           payload: { change: 0, misfit_reasons: ["arrival_mismatch"], reasons_source: { arrival_mismatch: "user" }, ai_codes_removed_by_user: [], note_ai: null } };
}

// ── 시작 오프셋 ──────────────────────────────────────────
function startSessions(n, { confirm = true, firstSkip = true, skipAll = false, mismatchPos1 = [], t0 = T0, prefix = "s" } = {}) {
  const recs = [], events = [];
  for (let k = 0; k < n; k++) {
    const at = t0 + k * DAY, id = prefix + k;
    const ids = [`S${String(10 + 4 * k).padStart(4, "0")}`, `S${String(11 + 4 * k).padStart(4, "0")}`, `S${String(12 + 4 * k).padStart(4, "0")}`, `S${String(13 + 4 * k).padStart(4, "0")}`];
    recs.push(wpRec(id, at, { path: ids, holdFrom: 4 }));
    events.push(...plays(id, at, ids.map((s, i) => ((i === 0 && firstSkip) || skipAll ? { song: s, c: 0.1, listened: 20 } : { song: s, c: 1 }))));
    if ((confirm && k === 0) || mismatchPos1.includes(k)) events.push(ev(id, at + 10 * MIN, "dislike_reason", { song_id: ids[0], reason: "mood_mismatch", position: 1, role: "path", phase: "move" }));
  }
  return { recs, events };
}

test("시작 오프셋 — 첫 곡 거절이 취향 통제 비율로 1.8배 넘고 mood_mismatch 확인이 있으면 한 칸 올림 (§4.4)", () => {
  const { recs, events } = startSessions(5);
  const m4 = modelOf(rawOf({ recs: recs.slice(0, 4), events: events.filter((e) => Number(e.rec_id.slice(1)) < 4), as_of_ms: T0 + 6 * DAY }), IDX).model;
  assert.equal(m4.start.arm, 0);   // 첫 곡 5개 미만
  const m = modelOf(rawOf({ recs, events, as_of_ms: T0 + 6 * DAY }), IDX).model;
  assert.equal(m.start.arm, 0.075);
  assert.equal(m.start.since_rec_id, "s4");
  assert.equal(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy.start_offset, 0.075);
  assert.equal(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES, { mode: "p0" }).policy.start_offset, 0);
  assert.equal(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES, { mode: "geometry" }).policy.start_offset, 0);
});

test("시작 오프셋 — 확인 없이 · 취향만(모든 곡 넘김)이면 올리지 않는다 (F5), 위치 1 mood_mismatch 2번이면 내림", () => {
  const noConfirm = startSessions(6, { confirm: false });
  assert.equal(modelOf(rawOf({ ...noConfirm, as_of_ms: T0 + 7 * DAY }), IDX).model.start.arm, 0);
  const taste = startSessions(8, { skipAll: true });
  const mt = modelOf(rawOf({ ...taste, as_of_ms: T0 + 9 * DAY }), IDX).model;
  assert.equal(mt.start.arm, 0);
  assert.ok(mt.start.ratio !== null && mt.start.ratio < 1.8, String(mt.start.ratio));
  const up = startSessions(5);
  const down = startSessions(2, { confirm: false, firstSkip: false, mismatchPos1: [0, 1], t0: T0 + 10 * DAY, prefix: "d" });
  const md = modelOf(rawOf({ recs: [...up.recs, ...down.recs], events: [...up.events, ...down.events], as_of_ms: T0 + 13 * DAY }), IDX).model;
  assert.equal(md.start.arm, 0);
  assert.equal(md.start.since_rec_id, "d1");
});

test("시작 오프셋 — 고긴장 상한 0.075 (I5)", () => {
  const m = structuredClone(P.emptyModel(RULES)); m.start.arm = 0.15;
  assert.equal(P.resolvePolicy(m, { now: HIGH, minutes: 30 }, RULES).policy.start_offset, 0.075);
  assert.equal(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy.start_offset, 0.15);
});

// ── 게이트 ───────────────────────────────────────────────
const talky = makeCatalog(240).filter((s) => s.spokenness > 0.9).map((s) => s.song_id);
test("소프트 말 많은 곡 게이트 — vocal_bother 2번(30일 안)이면 켜짐, 30일 지나면 만료, [끄기]면 30일 끔 (§4.9)", () => {
  assert.ok(IDX.byId.get(talky[0]).feature_bins.spokenness === "high");
  const mk = (t0, extra = []) => {
    const recs = [0, 1].map((k) => wpRec("v" + k, t0 + k * DAY, { path: [talky[k], "S0001"] }));
    const events = [0, 1].map((k) => ev("v" + k, t0 + k * DAY + MIN, "dislike_reason", { song_id: talky[k], reason: "vocal_bother", position: 1, role: "path", phase: "move" }));
    return rawOf({ recs, events: [...events, ...extra], as_of_ms: T0 + 40 * DAY });
  };
  const on = modelOf(mk(T0 + 35 * DAY), IDX).model;
  assert.deepEqual(on.gates.soft, ["exclude_spoken"]);
  assert.equal(on.gates.evidence.vocal_bother_w, 2);
  const pol = P.resolvePolicy(on, { now: LOW, minutes: 30 }, RULES);
  assert.deepEqual(pol.policy.soft_gates, ["exclude_spoken"]);
  assert.deepEqual(pol.meta.relax_order, RULES.personalization.relax.order_vocal_bother);   // 가사가 더 중요한 사람은 장르를 먼저 푼다
  assert.deepEqual(P.resolvePolicy(on, { now: LOW, minutes: 30 }, RULES, { mode: "p0" }).policy.soft_gates, []);
  assert.deepEqual(modelOf(mk(T0), IDX).model.gates.soft, []);   // 40일 전 근거 — 만료
  const off = modelOf(mk(T0 + 35 * DAY, [ev(null, T0 + 39 * DAY, "auto_gate_off", { gate: "exclude_spoken" })]), IDX).model;
  assert.deepEqual(off.gates.soft, []);
  assert.ok(off.gates.off_until.exclude_spoken > T0 + 40 * DAY);
});

test("게이트 — 세션 코드는 사용자 1 · AI 0.5, 말 비중 '높음'이 아닌 곡의 vocal_bother 는 세지 않는다", () => {
  const low = makeCatalog(240).find((s) => s.spokenness < 0.2).song_id;
  /* 세션 코드 확인(corroborate_codes, 20260929): 그 세션에 말 비중 '높음' 경로 곡을 조기 넘김한 일이 있어야 코드를 센다 — 두 세션 모두 talky 곡을 넘김 */
  const recs = [0, 1].map((k) => wpRec("v" + k, T0 + k * DAY, { path: [talky[k], low, "S0001"] }));
  const events = [postChange("v0", T0 + MIN, { reasons: { vocal_bother: "user" } }), postChange("v1", T0 + DAY + MIN, { reasons: { vocal_bother: "ai" } }),
                  ev("v1", T0 + DAY + 2 * MIN, "dislike_reason", { song_id: low, reason: "vocal_bother", position: 2 }),
                  ...plays("v0", T0, [{ song: talky[0], c: 0.1, listened: 20 }]), ...plays("v1", T0 + DAY, [{ song: talky[1], c: 0.1, listened: 20 }])];
  const m = modelOf(rawOf({ recs, events, as_of_ms: T0 + 2 * DAY }), IDX).model;
  assert.equal(m.gates.evidence.vocal_bother_w, 1.5);
  assert.equal(m.gates.evidence.vocal_bother_n, 2, "설명용 횟수는 가중 없이(코드 2번 — 말 비중이 낮은 곡의 싫어요는 세지 않는다)");
  assert.equal(RULES.personalization.gates.soft_spoken.vocal_bother_min <= 1.5, m.gates.soft.length > 0);
  assert.deepEqual(P.resolvePolicy(m, { now: LOW, minutes: 30, lyric: "instrumental_only" }, RULES).meta.relax_order, RULES.personalization.relax.order_vocal_bother);
  assert.deepEqual(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).meta.relax_order, RULES.personalization.relax.order_default);
});

test("게이트 — 세션 코드 확인: 말 비중 '높음' 곡을 넘긴 일이 없는 세션의 '가사·목소리가 거슬려요' 는 세지 않는다 (20260929)", () => {
  assert.equal(RULES.personalization.gates.soft_spoken.corroborate_codes, true);
  const low = makeCatalog(240).find((s) => s.spokenness < 0.2).song_id;
  const recs = [0, 1].map((k) => wpRec("w" + k, T0 + k * DAY, { path: [talky[k], low] }));
  const code = (id, at, positions) => postChange(id, at, { reasons: { vocal_bother: "user" }, ...(positions ? { positions } : {}) });
  // (1) talky 곡을 끝까지 들음 → 코드 무시
  const kept = modelOf(rawOf({ recs, events: [code("w0", T0 + 5 * MIN), ...plays("w0", T0, [{ song: talky[0], c: 1 }])], as_of_ms: T0 + 2 * DAY }), IDX).model;
  assert.equal(kept.gates.evidence.vocal_bother_w, 0);
  // (2) talky 곡을 넘겼지만 코드의 위치는 다른 곡(2번) → 무시 · 위치 1 이면 센다
  const ev2 = (pos) => [code("w0", T0 + 5 * MIN, [pos]), ...plays("w0", T0, [{ song: talky[0], c: 0.1, listened: 20 }])];
  assert.equal(modelOf(rawOf({ recs, events: ev2(2), as_of_ms: T0 + 2 * DAY }), IDX).model.gates.evidence.vocal_bother_w, 0);
  assert.equal(modelOf(rawOf({ recs, events: ev2(1), as_of_ms: T0 + 2 * DAY }), IDX).model.gates.evidence.vocal_bother_w, 1);
  // (3) 곡 단위 싫어요(말 비중 '높음' 곡)는 확인 없이 센다
  const dis = modelOf(rawOf({ recs, events: [ev("w0", T0 + MIN, "dislike_reason", { song_id: talky[0], reason: "vocal_bother", position: 1 })], as_of_ms: T0 + 2 * DAY }), IDX).model;
  assert.equal(dis.gates.evidence.vocal_bother_w, 1);
  // 규칙에서 끄면 이전 동작(코드를 그대로 센다)
  const R2 = JSON.parse(JSON.stringify(RULES)); R2.personalization.gates.soft_spoken.corroborate_codes = false;
  assert.equal(modelOf(rawOf({ recs, events: [code("w0", T0 + 5 * MIN)], as_of_ms: T0 + 2 * DAY }), IDX, R2).model.gates.evidence.vocal_bother_w, 1);
});

test("게이트 (b) — 말 비중 '높음' 묶음의 축소 점수가 내 평균의 절반 이하이고 표 6개 이상이면 켜짐", () => {
  const lowIds = makeCatalog(240).filter((s) => s.spokenness < 0.3).slice(0, 6).map((s) => s.song_id);
  const state = Object.fromEntries([...talky.slice(0, 6), ...lowIds].map((id) => [id, T0 + 29 * DAY]));
  const raw = rawOf({ profile: { dislikedSongs: talky.slice(0, 6), likedSongs: lowIds, wp_personal_v1: { state_at: state } }, as_of_ms: T0 + 30 * DAY });
  const m = modelOf(raw, IDX).model;
  assert.deepEqual(m.gates.soft, ["exclude_spoken"]);
  assert.ok(m.gates.evidence.spoken_score <= 0.5 * (7 / 14), String(m.gates.evidence.spoken_score));
  assert.ok(m.gates.evidence.spoken_n >= 6);
  const five = rawOf({ profile: { dislikedSongs: talky.slice(0, 5), likedSongs: lowIds, wp_personal_v1: { state_at: state } }, as_of_ms: T0 + 30 * DAY });
  assert.deepEqual(modelOf(five, IDX).model.gates.soft, []);
});

// ── 다양성 ───────────────────────────────────────────────
test("최근 곡 쉬는 폭 — 두 앱의 추천 문서(경로+더 들을 곡), 최신순 서로 다른 곡, 기기 무관 (§4.10.2)", () => {
  const recs = [fwRec("f0", T0, { path: ["S0001", "S0002"], extras: ["S0003"] }),
                wpRec("w0", T0 + DAY, { path: ["S0004", "S0001"], extras: ["S0005"] }),
                wpRec("w1", T0 + 2 * DAY, { path: ["S0006"] })];
  const { model } = modelOf(rawOf({ recs, as_of_ms: T0 + 3 * DAY }), IDX);
  assert.deepEqual(model.diversity.recent_ids, ["S0006", "S0004", "S0001", "S0005", "S0002", "S0003"]);
  const out = P.resolvePolicy(model, { now: LOW, minutes: 30 }, RULES);
  assert.deepEqual(out.policy.exclude_ids, model.diversity.recent_ids);
  assert.deepEqual(out.user.recent_played, out.policy.exclude_ids);
  // 이 탭이 방금 쓴 추천(session_log)도 같은 모양으로 합쳐지고, 중복은 id 로 제거
  const raw = rawOf({ recs, as_of_ms: T0 + 3 * DAY, session_log: { recommendations: [recs[2], wpRec("w2", T0 + 2 * DAY + MIN, { path: ["S0009"] })], events: [] } });
  const m2 = modelOf(raw, IDX).model;
  assert.deepEqual(m2.diversity.recent_ids.slice(0, 2), ["S0009", "S0006"]);
  assert.equal(m2.source.n_recs, 4);
});

test("다양성 — too_repetitive 2세션이면 창 120·가수 상한 1, AI 유지 코드는 0.5 (§4.10.1–2)", () => {
  const recs = [0, 1].map((k) => wpRec("r" + k, T0 + k * DAY, { path: ["S0001"] }));
  const user = [0, 1].map((k) => postChange("r" + k, T0 + k * DAY + MIN, { reasons: { too_repetitive: "user" } }));
  const m = modelOf(rawOf({ recs, events: user, as_of_ms: T0 + 2 * DAY }), IDX).model;
  assert.equal(m.diversity.recent_window, 120);
  assert.equal(m.diversity.artist_cap, 1);
  const pol = P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy;
  assert.equal(pol.artist_cap, 1);
  assert.equal(pol.artist_cap_by_key, true);
  assert.equal(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES, { mode: "p0" }).policy.artist_cap, 2);
  const ai = [0, 1].map((k) => postChange("r" + k, T0 + k * DAY + MIN, { reasons: { too_repetitive: "ai" } }));
  const ma = modelOf(rawOf({ recs, events: ai, as_of_ms: T0 + 2 * DAY }), IDX).model;
  assert.equal(ma.diversity.recent_window, 60);
  assert.equal(ma.diversity.artist_cap, 2);
  const removed = [0, 1].map((k) => postChange("r" + k, T0 + k * DAY + MIN, { reasons: {}, removed: ["too_repetitive"] }));
  assert.equal(modelOf(rawOf({ recs, events: removed, as_of_ms: T0 + 2 * DAY }), IDX).model.diversity.repetitive_sessions_w, 0);
});

test("좋아요 곡 다시 넣기 — 최근 창에 있지만 7일 넘게 안 나온 좋아요·벽 곡 (§4.10.3)", () => {
  const recs = [wpRec("r0", T0, { path: ["S0001", "S0002", "S0003"] }), wpRec("r1", T0 + 8 * DAY, { path: ["S0004", "S0002"] }),
                wpRec("r2", T0 + 9 * DAY, { path: ["S0005"] })];
  const events = [ev("r2", T0 + 9 * DAY + MIN, "dislike_reason", { song_id: "S0005", reason: "too_repetitive", position: 1 })];
  const profile = { likedSongs: ["S0001", "S0002"], playlists: ["S0003", "S0005"], dislikedSongs: [] };
  const m = modelOf(rawOf({ recs, events, profile, as_of_ms: T0 + 10 * DAY }), IDX).model;
  assert.deepEqual(m.diversity.replay_ids, ["S0001", "S0003"]);   // S0002 는 2일 전에 나옴, S0005 는 too_repetitive 로 30일 막힘
  const pol = P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy;
  assert.deepEqual(pol.replay_ids, ["S0001", "S0003"]);
  assert.equal(pol.replay_max, 1);
  assert.ok(!pol.exclude_ids.includes("S0001") && pol.exclude_ids.includes("S0002"));
  const p0 = P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES, { mode: "p0" }).policy;
  assert.deepEqual(p0.replay_ids, []); assert.equal(p0.replay_max, 0); assert.ok(p0.exclude_ids.includes("S0001"));
});

test("다시 넣기 일시정지 — 다시 넣은 곡이 연속 2번 조기 넘김되면 5세션 끈다", () => {
  const recs = [0, 1].map((k) => wpRec("r" + k, T0 + k * DAY, { path: [{ id: "S00" + (10 + k), replay: true }, "S0001"] }));
  const events = recs.flatMap((r, k) => plays(r.id, T0 + k * DAY, [{ song: "S00" + (10 + k), c: 0.1, listened: 20 }]));
  recs.push(wpRec("r9", T0 - 20 * DAY, { path: ["S0050"] }));
  const m = modelOf(rawOf({ recs, events, profile: { likedSongs: ["S0050"] }, as_of_ms: T0 + 3 * DAY }), IDX).model;
  assert.equal(m.diversity.replay.paused_until_session, 2 + 5);
  assert.deepEqual(m.diversity.replay_ids, ["S0050"]);
  assert.deepEqual(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy.replay_ids, []);
});

// ── 새 가수 발견 칸 ─────────────────────────────────────
test("발견 칸 — μ ≥ 0.15 ∧ E ≥ 4 이면 seededUniform(seed, 'discovery'), 고긴장·기준 실행은 없음 (§4.7.4)", () => {
  const liked = ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006"];
  const m = modelOf(rawOf({ profile: { likedSongs: liked } }), IDX).model;
  near(m.taste.mu, RULES.personalization.taste.mu_max * 6 / 14);   // μ = mu_max·E/(E+8)
  const ctx = { now: LOW, minutes: 30, seed: "u:2026-09-28:3" };
  assert.equal(P.resolvePolicy(m, ctx, RULES).policy.discovery_u, E.seededUniform("u:2026-09-28:3", "discovery"));
  assert.equal(P.resolvePolicy(m, { ...ctx, seed: undefined }, RULES).policy.discovery_u, 0.5);
  assert.equal(P.resolvePolicy(m, { ...ctx, now: HIGH }, RULES).policy.discovery_u, null);
  assert.equal(P.resolvePolicy(m, ctx, RULES, { mode: "p0" }).policy.discovery_u, null);
  const weak = modelOf(rawOf({ profile: { likedSongs: liked.slice(0, 3) } }), IDX).model;   // E 3 < 4
  assert.equal(P.resolvePolicy(weak, ctx, RULES).policy.discovery_u, null);
});

test("발견 칸 일시정지 — 발견 곡 연속 3번 조기 넘김이면 다음 3세션 끔", () => {
  const recs = [0, 1, 2].map((k) => wpRec("d" + k, T0 + k * DAY, { path: ["S0001", { id: "S01" + (10 + k), discovery: true }, "S0002"] }));
  const events = recs.flatMap((r, k) => plays(r.id, T0 + k * DAY, [{ song: "S0001", c: 1 }, { song: "S01" + (10 + k), c: 0.1, listened: 20 }]));
  const m = modelOf(rawOf({ recs, events, profile: { likedSongs: ["S0020", "S0021", "S0022", "S0023", "S0024", "S0025"] }, as_of_ms: T0 + 3 * DAY }), IDX).model;
  assert.equal(m.taste.discovery.paused_until_session, 2 + 3);
  assert.equal(P.resolvePolicy(m, { now: LOW, minutes: 30, seed: "x" }, RULES).policy.discovery_u, null);
});

test("신용 할당 — 취향 신호(넘김·좋아요·not_my_taste)는 경로 모수를 움직이지 않는다 (§5 원칙 1, F5)", () => {
  const recs = [], events = [];
  for (let k = 0; k < 8; k++) {
    const at = T0 + k * DAY, ids = ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006"].map((s, i) => s.slice(0, 3) + String(10 * k + i).padStart(2, "0"));
    recs.push(wpRec("t" + k, at, { path: ids, holdFrom: 5 }));
    events.push(...plays("t" + k, at, ids.map((s, i) => (i % 2 ? { song: s, c: 0.1, listened: 20 } : { song: s, c: 1 }))));
    events.push(ev("t" + k, at + 20 * MIN, "like", { song_id: ids[0], on: true }));
    events.push(ev("t" + k, at + 21 * MIN, "dislike_reason", { song_id: ids[1], reason: "not_my_taste", position: 2 }));
    events.push(postChange("t" + k, at + 22 * MIN, { change: k % 2 ? -2 : 2, reasons: { not_my_taste: "user" } }));
  }
  const { model } = modelOf(rawOf({ recs, events, as_of_ms: T0 + 9 * DAY }), IDX);
  assert.equal(model.pace.pi, 0);
  assert.equal(model.start.arm, 0);
  assert.equal(model.length.applied, false);
  assert.equal(model.hold.arm, RULES.personalization.hold.p0_radius);
  assert.deepEqual(model.calib.current.labels["불안해요"].applied, false);
  assert.deepEqual(model.gates.soft, []);
  assert.equal(model.diversity.recent_window, 60);
  assert.ok(model.taste.E > 0);
});

test("신용 할당 — post_change.change 는 어떤 학습기에도 넣지 않는다 (§5 원칙 3, D12)", () => {
  const recs = [wpRec("r0", T0, { path: ["S0001", "S0002"] })];
  const pl = plays("r0", T0, [{ song: "S0001", c: 1 }, { song: "S0002", c: 0.1, listened: 20 }]);
  const a = modelOf(rawOf({ recs, events: [...pl, postChange("r0", T0 + 10 * MIN, { change: 2 })] }), IDX).model;
  const b = modelOf(rawOf({ recs, events: [...pl, postChange("r0", T0 + 10 * MIN, { change: -2 })] }), IDX).model;
  assert.equal(a.digest, b.digest);
});
