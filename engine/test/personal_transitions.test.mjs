/* 곡과 곡 사이 연결 — 전환 라벨(§3.3) · q(§3.4) · 결합 곱셈 모형 m_f(§4.8.3) · 전환 귀속분 a(§4.8.4) · λ(§4.8.5) */
import test from "node:test";
import assert from "node:assert/strict";
import { P, RULES, T0, DAY, MIN, makeCatalog, makeIndex, song, wpRec, fwRec, plays, ev, legacyEv, postChange, rawOf, modelOf, near } from "./personal_harness.test.mjs";

const AS_OF = T0 + 10 * DAY;
const LOW = { v: 0.6, e: 0.5 }, HIGH = { v: 0.3, e: 0.72 };
const SONGS = [
  song("A", { tempo: 0.1 }), song("B", { tempo: 0.9 }), song("C", { tempo: 0.15 }), song("D", { tempo: 0.1, instrumental: true }),
  song("F", { tempo: 0.1, spokenness: 0.8 }), song("G", { tempo: 0.1, genres: ["재즈"] }), song("H", { tempo: 0.1, V: 0.97, A: 0.97 }),
];
const IDX = makeIndex([...makeCatalog(60), ...SONGS]);

function bare(o = {}) {
  return {
    rec_id: "x", at_ms: AS_OF, app: "web-personal", seed: null,
    input: { now: null, target: null, now_table: null, target_table: null, labels: { current: null, target: null }, nudged: { current: false, target: false },
             minutes: 30, minutes_base: null, nl_minutes: false, lyric: null, genres: [], pace_user: null, stress: null, high_stress: false },
    used: null, policy: null, n_path: 0, arrival_index: null, path: [], extras: [], exposures: [], transitions: [], likes_on: [], dislikes: [], post: null,
    reached_frac: null, rerequested_within_10min: false, ended_by: "unknown", ...o,
  };
}
const tr = (L, y, q = 0.15, w = 1) => ({ prev: "A", cur: "B", position: 2, label: y, w, L: { tempo: 0, vocal: 0, spoken: 0, genre: 0, va: 0, ...L }, q, at_ms: AS_OF, source: "track_exit" });
function trs(nL, yL, nS, yS, f = "tempo", qL = 0.15, qS = 0.15) {
  const out = [];
  for (let i = 0; i < nL; i++) out.push(tr({ [f]: 1 }, i < yL ? 1 : 0, qL));
  for (let i = 0; i < nS; i++) out.push(tr({}, i < yS ? 1 : 0, qS));
  return out;
}
const modelFrom = (sessions) => P.buildPersonalModel({ as_of_ms: AS_OF, sessions, global: {} }, IDX, RULES, { as_of_ms: AS_OF });

test("전환 배수 계산 예 — 빠르기 민감(큰 변화 8번 중 4번, 작은 변화 10번 중 1번, q = 0.15) → m0 ≈ 1.26, m_tempo ≈ 1.70 적용 (§4.8.3)", () => {
  const m = modelFrom([bare({ transitions: trs(8, 4, 10, 1) })]);
  const A = m.adjacency;
  near(A.m0, 1.26, 0.01, "m0");
  near(A.m.tempo, 1.70, 0.02, "m_tempo");
  assert.equal(A.O.tempo, 4);
  assert.equal(A.n_large.tempo, 8);
  assert.equal(A.n_trans, 18);
  const thr = 1.28 / Math.sqrt(4 + 2);
  near(thr, 0.52, 0.005);
  assert.ok(Math.log(A.m.tempo) >= thr);   // 겨우 넘음
  assert.equal(A.applied.tempo, true);
  for (const f of ["vocal", "spoken", "genre", "va"]) { assert.equal(A.m[f], 1, f); assert.equal(A.applied[f], false, f); }
  assert.equal(A.m_applied.tempo, A.m.tempo);
  // 정책: 빠르기 전환 비용 = band · 0.4 · scale · m_tempo
  const pol = P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy;
  near(pol.adj_w.tempo, 0.025 * 0.4 * 1 * A.m.tempo, 1e-9);
  near(pol.adj_w.vocal, 0.025 * 0.3, 1e-12);
  assert.equal(pol.lambda, 0.1);
  // 설명: 횟수로 말한다
  const c = m.counts_for_explain.adjacency.tempo;
  assert.deepEqual(c, { large_n: 8, large_y: 4, small_n: 10, small_y: 1 });
  const card = P.explainModel(m, RULES).find((x) => x.id === "adjacency");
  assert.match(card.text, /크게 바뀐 뒤 8번 중 4번, 비슷할 때 10번 중 1번/);
  assert.match(card.text, /1\.7배/);
  assert.equal(card.is_default, false);
});

test("전환 배수 계산 예 — 둔감한 사용자(8번 중 2번 vs 10번 중 2번) → m_tempo ≈ 1.15, 문턱 0.64 > 0.14 → 적용 안 함", () => {
  const A = modelFrom([bare({ transitions: trs(8, 2, 10, 2) })]).adjacency;
  near(A.m.tempo, 1.15, 0.02);
  assert.ok(1.28 / Math.sqrt(2 + 2) > Math.log(A.m.tempo));
  assert.equal(A.applied.tempo, false);
  assert.equal(A.m_applied.tempo, 1);
});

test("전환 배수 — 적용 문턱: 큰 변화 쌍 8 · 전환 총수 12 · 배수 범위 [0.5, 2]", () => {
  assert.equal(modelFrom([bare({ transitions: trs(6, 5, 12, 1) })]).adjacency.applied.tempo, false);   // 큰 변화 6 < 8
  assert.equal(modelFrom([bare({ transitions: trs(8, 7, 3, 0) })]).adjacency.applied.tempo, false);    // 총 11 < 12
  const hi = modelFrom([bare({ transitions: trs(10, 10, 10, 0) })]).adjacency;
  assert.equal(hi.m.tempo, 2);
  const lo = modelFrom([bare({ transitions: trs(40, 2, 40, 20) })]).adjacency;
  assert.equal(lo.m.tempo, 0.5);
  assert.equal(lo.applied.tempo, true);
});

test("q 대조 실험 — 취향으로 설명되는 넘김은 q 가 먼저 가져간다 (F4, 심사 B-3)", () => {
  // 큰 빠르기 변화가 취향 밖 곡(q 0.6)에서만 일어나고, 넘김률도 딱 취향대로
  const withQ = modelFrom([bare({ transitions: trs(10, 6, 10, 1, "tempo", 0.6, 0.1) })]).adjacency;
  assert.ok(!withQ.applied.tempo || (withQ.m.tempo >= 0.8 && withQ.m.tempo <= 1.25), String(withQ.m.tempo));
  near(withQ.m.tempo, 1, 0.05);
  // q 없이(상수) 맞추면 배수가 부푼다
  const noQ = modelFrom([bare({ transitions: trs(10, 6, 10, 1, "tempo", 0.15, 0.15) })]).adjacency;
  assert.ok(noQ.m.tempo > 1.5 && noQ.applied.tempo, String(noQ.m.tempo));
});

test("전환 배수 — 45일 반감 · 초기화 이전 근거 무시", () => {
  const old = trs(8, 4, 10, 1).map((t) => ({ ...t, at_ms: AS_OF - 45 * DAY }));
  const A = modelFrom([bare({ transitions: old })]).adjacency;
  near(A.O.tempo, 2, 1e-6);   // 가중 절반
  assert.equal(A.applied.tempo, false);   // 문턱 1.28/√(2+2)
  const reset = P.buildPersonalModel({ as_of_ms: AS_OF, sessions: [bare({ transitions: trs(8, 4, 10, 1).map((t) => ({ ...t, at_ms: AS_OF - DAY })) })], global: { resets: { adjacency: AS_OF - DAY / 2 } } },
                                     IDX, RULES, { as_of_ms: AS_OF });
  assert.equal(reset.adjacency.n_trans, 0);
});

test("V/A 전환 가중 λ = clamp(0.1 · m_va, 0.1, 0.25) — 느슨해지지 않는다 (§4.8.5)", () => {
  const m = modelFrom([bare({ transitions: trs(8, 4, 10, 1, "va") })]);
  assert.equal(m.adjacency.applied.va, true);
  near(m.adjacency.lambda, 0.1 * m.adjacency.m.va, 1e-9);
  near(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy.lambda, 0.1 * m.adjacency.m.va, 1e-9);
  const lo = modelFrom([bare({ transitions: trs(40, 2, 40, 20, "va") })]);
  assert.equal(lo.adjacency.lambda, 0.1);   // 배수 < 1 이어도 λ 는 0.1 아래로 내려가지 않는다
});

test("고긴장 — 전환 배수는 1 이상(더 엄격하게만) (I5)", () => {
  const m = modelFrom([bare({ transitions: trs(40, 2, 40, 20) })]);
  assert.equal(m.adjacency.m_applied.tempo, 0.5);
  near(P.resolvePolicy(m, { now: LOW, minutes: 30 }, RULES).policy.adj_w.tempo, 0.025 * 0.4 * 0.5, 1e-12);
  near(P.resolvePolicy(m, { now: HIGH, minutes: 30 }, RULES).policy.adj_w.tempo, 0.025 * 0.4, 1e-12);
  assert.equal(P.resolvePolicy(m, { now: HIGH, minutes: 30 }, RULES).meta.params.m.tempo, 1);
  // 기준 실행 R 은 학습 배수를 쓰지 않는다
  near(P.resolvePolicy(modelFrom([bare({ transitions: trs(8, 4, 10, 1) })]), { now: LOW, minutes: 30 }, RULES, { mode: "p0" }).policy.adj_w.tempo, 0.025 * 0.4, 1e-12);
});

test("전환 귀속분 — 큰 빠르기 변화 뒤 넘긴 곡의 취향 표는 (1 − a) 배, a = 1 − 1/m_tempo (§4.8.4)", () => {
  const exps = [
    { song_id: "A", position: 1, role: "path", instance: 1, started: true, listened_s: 200, duration_s: 200, catalog_s: 200, completion: 1, preview: false,
      cause: "complete", prev_song_id: null, prev_completion: null, at_ms: AS_OF - MIN, source: "track_exit", prev_index: null },
    { song_id: "B", position: 2, role: "path", instance: 1, started: true, listened_s: 20, duration_s: 200, catalog_s: 200, completion: 0.1, preview: false,
      cause: "next", prev_song_id: "A", prev_completion: 1, at_ms: AS_OF, source: "track_exit", prev_index: 0 },
  ];
  const m = modelFrom([bare({ transitions: trs(8, 4, 10, 1), exposures: exps, path: [{ song_id: "A", position: 1, phase: "move", pmarg: 0 }, { song_id: "B", position: 2, phase: "move", pmarg: 0 }] })]);
  assert.equal(m.adjacency.applied.tempo, true);
  const it = Object.fromEntries(m.taste.items.map((x) => [x.song_id, x]));
  near(it.B.vote.neg, 0.25 / m.adjacency.m.tempo, 1e-8);
  assert.deepEqual(it.A.vote, { pos: 0.25, neg: 0, pin: 0 });
  // 배수가 모두 1 이면 a = 0
  const m0 = modelFrom([bare({ transitions: [], exposures: exps })]);
  assert.equal(m0.taste.items.find((x) => x.song_id === "B").vote.neg, 0.25);
});

test("전환 라벨 — 재생 순서의 두 노출 (a → b), 조건·y 값 (§3.3, normalizeLogs 끝까지)", () => {
  const recs = [], events = [];
  const add = (id, list, extra = []) => { const at = T0 + recs.length * DAY; recs.push(wpRec(id, at, { path: list.map((p) => p.song) })); events.push(...plays(id, at, list), ...extra.map((f) => f(id, at))); };
  add("s1", [{ song: "A", c: 1 }, { song: "B", c: 0.1, listened: 20 }, { song: "C", c: 1 }, { song: "D", c: 0.9, cause: "complete" }, { song: "F", c: 0.5 },
             { song: "G", c: 0.1, listened: 20 }, { song: "H", c: 1 }]);
  add("s2", [{ song: "A", c: 0.8, cause: "jump" }, { song: "C", c: 0.9, cause: "prev" }, { song: "B", c: 1 }]);
  add("s3", [{ song: "A", c: 1 }, { song: "B", c: 0.5 }], [(id, at) => ev(id, at + 30 * MIN, "like", { song_id: "B", on: true })]);
  add("s4", [{ song: "A", c: 1 }, { song: "B", c: 0.5 }], [(id, at) => ev(id, at + 30 * MIN, "dislike_reason", { song_id: "B", reason: "path_jump", position: 2 })]);
  add("s5", [{ song: "A", c: 1 }, { song: "B", c: 0.5 }], [(id, at) => postChange(id, at + 30 * MIN, { reasons: { path_jump: "user" }, positions: [2] })]);
  add("s6", [{ song: "A", c: 1 }, { song: "B", c: 0.5 }], [(id, at) => postChange(id, at + 30 * MIN, { reasons: { path_jump: "ai" }, positions: [2] })]);
  add("s7", [{ song: "A", c: 1 }, { song: "B", c: 0.5 }], [(id, at) => postChange(id, at + 30 * MIN, { reasons: {}, removed: ["path_jump"], positions: [2] })]);
  add("s8", [{ song: "A", c: 1 }, { song: "B", c: 0.1, listened: 20 }], [(id, at) => ev(id, at + 30 * MIN, "dislike", { song_id: "B", on: true })]);
  add("s9", [{ song: "A", c: 1 }, { song: "B", c: 0, cause: "autoplay_fail" }]);
  add("s10", [{ song: "A", c: 1 }, { song: "B", c: 0.5 }], [(id, at) => postChange(id, at + 30 * MIN, { reasons: { path_jump: "user" } })]);   // 위치 없음
  const { norm, model } = modelOf(rawOf({ recs, events, as_of_ms: T0 + 12 * DAY }), IDX);
  const T = Object.fromEntries(norm.sessions.map((s) => [s.rec_id, s.transitions]));
  const brief = (t) => ({ pair: t.prev + ">" + t.cur, y: t.label, w: t.w });
  assert.deepEqual(T.s1.map(brief), [{ pair: "A>B", y: 1, w: 1 }, { pair: "C>D", y: 0, w: 1 }, { pair: "F>G", y: 1, w: 1 }]);
  assert.deepEqual(T.s1[0].L, { tempo: 1, vocal: 0, spoken: 0, genre: 0, va: 0 });
  assert.deepEqual(T.s1[1].L, { tempo: 0, vocal: 1, spoken: 0, genre: 0, va: 0 });
  assert.deepEqual(T.s1[2].L, { tempo: 0, vocal: 0, spoken: 1, genre: 1, va: 0 });
  assert.deepEqual(T.s2, []);                                        // 점프·이전 곡으로 온 전환은 제외
  assert.deepEqual(T.s3.map(brief), [{ pair: "A>B", y: 0, w: 1 }]);   // 좋아요 = 0
  assert.deepEqual(T.s4.map(brief), [{ pair: "A>B", y: 1, w: 1 }]);   // 곡 단위 path_jump
  assert.deepEqual(T.s5.map(brief), [{ pair: "A>B", y: 1, w: 1 }]);   // 세션 path_jump 위치 — 사용자
  assert.deepEqual(T.s6.map(brief), [{ pair: "A>B", y: 1, w: 0.5 }]); // AI 가 고르고 유지
  assert.deepEqual(T.s7, []);                                        // 사용자가 지운 AI 코드는 버림, 30~70% 는 제외
  assert.deepEqual(T.s8, []);                                        // 취향 싫어요 곡은 전환 대상에서 빠짐
  assert.deepEqual(T.s9, []);                                        // 자동재생 실패
  assert.deepEqual(T.s10, []);                                       // 위치 없는 세션 path_jump 는 라벨을 만들지 않는다
  near(T.s1[0].q, 1 / (1 + Math.exp(1.73)), 1e-9);                   // p_pmarg 0 → q = σ(θ0)
  assert.equal(model.evidence.n_transitions, 7);
  assert.deepEqual(model.counts_for_explain.path_jump, { located: 2, unlocated: 1 });   // 위치 없는 코드는 패널 횟수로만(§5)   // s1 3 + s3·s4·s5·s6 1씩
});

test("전환 라벨 — q 는 추천 당시 로그의 p_pmarg 로 (§3.4)", () => {
  const rec = wpRec("q1", T0, { path: [{ id: "A", pmarg: 0 }, { id: "B", pmarg: 0.5 }] });
  const { norm } = modelOf(rawOf({ recs: [rec], events: plays("q1", T0, [{ song: "A", c: 1 }, { song: "B", c: 0.1, listened: 20 }]) }), IDX);
  near(norm.sessions[0].transitions[0].q, 1 / (1 + Math.exp(-(-1.73 + 3.0 * 0.5))), 1e-9);
});

test("transitionLabel — 앞 곡 몰입(≥ 0.5 또는 완주) · '다음'/자동 도달만", () => {
  const e = (o) => ({ song_id: "B", position: 2, role: "path", instance: 1, started: true, listened_s: 20, duration_s: 200, catalog_s: 200, completion: 0.1,
                      preview: false, cause: "next", prev_song_id: "A", prev_completion: 1, at_ms: T0, source: "track_exit", ...o });
  const a = (o) => e({ song_id: "A", position: 1, completion: 1, listened_s: 200, cause: "complete", prev_song_id: null, ...o });
  const S = { dislikes: [], likes_on: [], post: null };
  assert.equal(P.transitionLabel(a(), e(), S, RULES), 1);
  assert.equal(P.transitionLabel(a({ completion: 0.5, cause: "next", listened_s: 100 }), e(), S, RULES), 1);
  assert.equal(P.transitionLabel(a({ completion: 0.4, cause: "next", listened_s: 80 }), e(), S, RULES), null);
  assert.equal(P.transitionLabel(a({ completion: 0.9, cause: "jump" }), e(), S, RULES), null);
  assert.equal(P.transitionLabel(a(), e({ completion: 0.9, cause: "complete", listened_s: 180 }), S, RULES), 0);
  assert.equal(P.transitionLabel(a(), e({ completion: 0.5, listened_s: 100 }), S, RULES), null);
  assert.equal(P.transitionLabel(a(), e({ completion: 0.5, listened_s: 100 }), { ...S, likes_on: ["B"] }, RULES), 0);
  assert.equal(P.transitionLabel(a(), e(), { ...S, dislikes: [{ song_id: "B", reason: "not_my_taste" }] }, RULES), null);
  assert.equal(P.transitionLabel(a(), e({ started: false, cause: "autoplay_fail" }), S, RULES), null);
  assert.equal(P.transitionLabel(null, e(), S, RULES), null);
});

test("옛 기록의 전환 — 재생 순서로 잇고 가중 × 0.5", () => {
  const rec = fwRec("f1", T0, { path: ["A", "B", "C"] });
  const events = [legacyEv("f1", T0 + MIN, "track_complete", { song_id: "A", position: 1, completion_rate: 0.98 }),
                  legacyEv("f1", T0 + 2 * MIN, "track_skip", { song_id: "B", position: 2, direction: "next" }),
                  legacyEv("f1", T0 + 3 * MIN, "track_complete", { song_id: "C", position: 3, completion_rate: 1 })];
  const { norm } = modelOf(rawOf({ recs: [rec], events }), IDX);
  const t = norm.sessions[0].transitions;
  assert.equal(t.length, 1);
  assert.deepEqual({ pair: t[0].prev + ">" + t[0].cur, y: t[0].label, w: t[0].w, source: t[0].source }, { pair: "A>B", y: 1, w: 0.5, source: "legacy" });
});
