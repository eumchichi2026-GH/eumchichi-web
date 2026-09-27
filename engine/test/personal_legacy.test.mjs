/* 로그 정규화 — 옛 기록(fix-web·운영 앱) 재구성(§3.1) · 고아 이벤트 창 · 중복 제거 · 옛 기록 반값 · 모양(§6.3) */
import test from "node:test";
import assert from "node:assert/strict";
import { P, RULES, T0, DAY, MIN, makeCatalog, makeIndex, song, wpRec, fwRec, plays, ev, legacyEv, postChange, rawOf, modelOf, near } from "./personal_harness.test.mjs";

const IDX = makeIndex([...makeCatalog(60), song("PV", { duration_ms: 210000 })]);
const H = 3600000;
const PATH8 = ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006", "PV", "S0008"];

function legacySession(recId = "f1", at = T0) {
  const L = (dt, type, p) => legacyEv(recId, at + dt * MIN, type, p);
  return [
    L(1, "track_complete", { song_id: "S0001", position: 1, completion_rate: 0.95, detected_by: "position" }),
    L(2, "track_milestone", { song_id: "S0002", position: 2, milestone: 25, duration_ms: 200000 }),
    L(3, "track_skip", { song_id: "S0002", position: 7, direction: "next" }),                  // position 은 재생 큐 위치 — 쓰지 않는다(B14)
    L(4, "track_skip", { song_id: "S0003", position: 3, direction: "next" }),                  // milestone 없음 → c = 0.1
    L(5, "track_autoplay_failed", { song_id: "S0004", position: 4 }),
    L(6, "track_milestone", { song_id: "S0005", position: 4, milestone: 50 }),
    L(7, "track_milestone", { song_id: "S0005", position: 4, milestone: 75 }),
    L(8, "track_skip", { song_id: "S0005", position: 4, direction: "prev" }),                  // c 0.75 — 끝까지(원인 무관 +)
    L(9, "track_milestone", { song_id: "S0006", position: 5, milestone: 50 }),
    L(10, "track_skip", { song_id: "S0006", position: 5, direction: "jump", to_song_id: "PV" }), // c 0.5 — 표 없음
    L(11, "track_milestone", { song_id: "PV", position: 6, milestone: 75, duration_ms: 30000 }),
    L(12, "track_complete", { song_id: "PV", position: 6, completion_rate: 1 }),               // 30초 미리듣기 — 반값 × 반값
    L(13, "track_skip", { song_id: "S9999", position: 9, direction: "next" }),                 // 시퀀스에 없는 곡 — 버린다
  ];
}

test("옛 기록 재구성 — track_complete·track_skip·track_milestone·track_autoplay_failed (§3.1)", () => {
  const raw = rawOf({ recs: [fwRec("f1", T0, { path: PATH8 })], events: legacySession(), as_of_ms: T0 + DAY });
  const { norm, model } = modelOf(raw, IDX);
  const s = norm.sessions[0];
  assert.equal(s.app, "fix-web");
  assert.equal(norm.source.n_sessions_legacy, 1);
  assert.equal(norm.source.n_sessions_wp, 0);
  const brief = s.exposures.map((e) => [e.song_id, e.position, e.cause, e.completion, e.source, e.started]);
  assert.deepEqual(brief, [
    ["S0001", 1, "complete", 0.95, "legacy", true], ["S0002", 2, "next", 0.25, "legacy", true], ["S0003", 3, "next", 0.1, "legacy", true],
    ["S0004", 4, "autoplay_fail", 0, "legacy", false], ["S0005", 5, "prev", 0.75, "legacy", true], ["S0006", 6, "jump", 0.5, "legacy", true],
    ["PV", 7, "complete", 1, "legacy", true],
  ]);
  assert.equal(s.exposures[1].prev_song_id, "S0001");
  assert.equal(s.exposures.find((e) => e.song_id === "PV").preview, true);
  const catS = IDX.byId.get("S0003").duration_ms / 1000;
  near(s.exposures.find((e) => e.song_id === "S0003").listened_s, 0.1 * catS, 1e-3);   // milestone 이 없으면 카탈로그 길이 기준
  assert.equal(s.exposures.find((e) => e.song_id === "S0002").duration_s, 200);         // milestone 의 임베드 길이
  // 옛 기록의 구간: 30분 8곡, 전환점 0.6 → 6번째부터 머묾
  assert.equal(s.arrival_index, 6);
  assert.deepEqual(s.path.map((r) => r.phase), ["move", "move", "move", "move", "move", "hold", "hold", "hold"]);
  // 표: 옛 기록 × 0.5, 미리듣기면 × 0.5 한 번 더
  const it = Object.fromEntries(model.taste.items.map((x) => [x.song_id, x.vote]));
  assert.deepEqual(it.S0001, { pos: 0.125, neg: 0, pin: 0 });
  assert.deepEqual(it.S0002, { pos: 0, neg: 0.125, pin: 0 });
  assert.deepEqual(it.S0003, { pos: 0, neg: 0.125, pin: 0 });
  assert.equal(it.S0004, undefined);
  assert.deepEqual(it.S0005, { pos: 0.125, neg: 0, pin: 0 });
  assert.equal(it.S0006, undefined);
  assert.deepEqual(it.PV, { pos: 0.0625, neg: 0, pin: 0 });
  assert.equal(it.S9999, undefined);
});

test("옛 기록 — 고아 이벤트(rec_id null)는 그 이전 3시간 안의 가장 최근 추천에 붙이고, 없으면 버린다", () => {
  const recs = [fwRec("f1", T0, { path: PATH8 }), fwRec("f2", T0 + 5 * H, { path: PATH8 })];
  const events = [
    legacyEv(null, T0 - H, "track_complete", { song_id: "S0001", completion_rate: 1 }),          // 앞선 추천 없음 → 버림
    legacyEv(null, T0 + 2 * H, "track_complete", { song_id: "S0001", completion_rate: 1 }),      // f1 에 붙음
    legacyEv(null, T0 + 4 * H, "track_complete", { song_id: "S0002", completion_rate: 1 }),      // f1 에서 4시간 → 버림
    legacyEv(null, T0 + 5 * H + MIN, "track_complete", { song_id: "S0003", completion_rate: 1 }), // f2 에 붙음
  ];
  const { norm } = modelOf(rawOf({ recs, events, as_of_ms: T0 + DAY }), IDX);
  assert.equal(norm.source.n_orphans_attached, 2);
  assert.equal(norm.source.n_orphans_dropped, 2);
  assert.deepEqual(norm.sessions.map((s) => s.exposures.map((e) => e.song_id)), [["S0001"], ["S0003"]]);
});

test("중복 제거 — 문서 id·client_id, 이 탭의 SESSION_LOG 와 합치기 (§2.3)", () => {
  const rec = wpRec("w1", T0, { path: ["S0001", "S0002"] });
  const pl = plays("w1", T0, [{ song: "S0001", c: 1 }, { song: "S0002", c: 0.1, listened: 20 }]);
  const dupServer = { ...pl[0], id: "srv-1" };
  const local = pl.map((e) => ({ ...e, id: undefined }));   // 서버 id 전의 로컬 사본 — client_id 가 같다
  const raw = rawOf({ recs: [rec], events: [...pl, dupServer], as_of_ms: T0 + DAY, session_log: { recommendations: [rec], events: local } });
  const { norm } = modelOf(raw, IDX);
  assert.equal(norm.source.n_recs, 1);
  assert.equal(norm.sessions[0].exposures.length, 2);
  assert.equal(norm.source.n_events, 2);
});

test("web-personal 추천은 track_exit 만 — 운영 앱용 track_skip/track_complete 와 이중 계산하지 않는다", () => {
  const rec = wpRec("w1", T0, { path: ["S0001", "S0002"] });
  const events = [...plays("w1", T0, [{ song: "S0001", c: 1 }, { song: "S0002", c: 0.1, listened: 20 }]),
                  ev("w1", T0 + MIN, "track_complete", { song_id: "S0001", position: 1, completion_rate: 1 }),
                  ev("w1", T0 + 2 * MIN, "track_skip", { song_id: "S0002", position: 2, direction: "next", listened_s: 20, completion: 0.1, started: true })];
  const { norm, model } = modelOf(rawOf({ recs: [rec], events, as_of_ms: T0 + DAY }), IDX);
  assert.equal(norm.sessions[0].exposures.length, 2);
  assert.ok(norm.sessions[0].exposures.every((e) => e.source === "track_exit"));
  assert.equal(model.taste.items.find((x) => x.song_id === "S0001").vote.pos, 0.25);   // 옛 기록 반값이 아님
});

test("P13 — 옛 기록만 있는 사용자도 오류 없이 모델을 만들고 따뜻하게 시작한다 (§11 A5)", () => {
  const recs = [], events = [];
  for (let k = 0; k < 10; k++) {
    const at = T0 + k * DAY, id = "f" + k;
    recs.push(fwRec(id, at, { path: PATH8, input: { pace_mode: k === 3 ? "fast" : "auto" } }));
    events.push(...legacySession(id, at));
    events.push(legacyEv(id, at + 20 * MIN, "post_change", { change: 1, misfit_reasons: ["too_repetitive"], note: null }));
  }
  const { norm, model } = modelOf(rawOf({ recs, events, profile: { likedSongs: ["S0010"] }, as_of_ms: T0 + 11 * DAY }), IDX);
  assert.ok(model.source.n_sessions_legacy > 0);
  assert.equal(model.source.n_sessions_legacy, 10);
  assert.ok(model.taste.items.some((x) => x.vote && x.vote.pos > 0));
  assert.ok(model.taste.E > 0);
  assert.equal(model.pace.votes, 1);   // 옛 기록의 pace_mode 도 버튼 표
  assert.equal(model.diversity.recent_window, 120);   // 세션 코드 too_repetitive(출처 없음 = 사용자) 10세션
  assert.equal(norm.sessions[0].post.reasons.too_repetitive, "user");
  assert.equal(norm.sessions[0].post.touched, null);   // 옛 기록은 touched 를 모른다(B17)
  const pol = P.resolvePolicy(model, { now: { v: 0.6, e: 0.5 }, minutes: 30, seed: "u:x:1" }, RULES);
  assert.ok(pol.policy.mu > 0);
  assert.equal(P.validateEvent("x", {}).ok, false);
});

test("옛 like/dislike 이벤트는 켬/끔 방향이 없으면 지금 프로필 상태로 읽는다 (B13)", () => {
  const rec = fwRec("f1", T0, { path: ["S0001", "S0002"] });
  const events = [legacyEv("f1", T0 + MIN, "like", { song_id: "S0001" }), legacyEv("f1", T0 + 2 * MIN, "like", { song_id: "S0002" })];
  const { norm } = modelOf(rawOf({ recs: [rec], events, profile: { likedSongs: ["S0001"] } }), IDX);
  assert.deepEqual(norm.sessions[0].likes_on, ["S0001"]);
  const wp = wpRec("w1", T0, { path: ["S0001"] });
  const n2 = modelOf(rawOf({ recs: [wp], events: [ev("w1", T0 + MIN, "like", { song_id: "S0001", on: true }), ev("w1", T0 + 2 * MIN, "like", { song_id: "S0001", on: false })] }), IDX).norm;
  assert.deepEqual(n2.sessions[0].likes_on, []);
});

test("잘못된 이벤트는 세고 버린다 · 창이 가득 차면 partial", () => {
  const rec = wpRec("w1", T0, { path: ["S0001"] });
  const bad = [{ id: "b1", created_at_ms: T0, rec_id: "w1", payload: {} },                                // type 없음
               { id: "b2", rec_id: "w1", type: "like", payload: { song_id: "S0001" } },                  // 시각 없음
               ev("w1", T0 + MIN, "track_exit", { song_id: "S0001", listened_s: 10 })];                  // cause 없음
  const { norm } = modelOf(rawOf({ recs: [rec], events: bad }), IDX);
  assert.equal(norm.source.n_invalid_events, 3);
  assert.equal(norm.sessions[0].exposures.length, 0);
  assert.equal(norm.source.partial, false);
  const many = Array.from({ length: RULES.personalization.load.recs }, (_, k) => fwRec("f" + k, T0 + k * MIN, { path: ["S0001"] }));
  assert.equal(modelOf(rawOf({ recs: many }), IDX).norm.source.partial, true);
});

test("세션 모양 (§6.3) — 도달 비율·10분 재요청·종료 원인·듣고 난 뒤", () => {
  const ids = ["S0001", "S0002", "S0003", "S0004"];
  const recs = [wpRec("a", T0, { path: ids, holdFrom: 4 }), wpRec("b", T0 + 5 * MIN, { path: ids, holdFrom: 4 }), wpRec("c", T0 + DAY, { path: ids, holdFrom: 4 })];
  const events = [
    ...plays("a", T0, [{ song: "S0001", c: 0.2, cause: "new_rec", listened: 40 }]),
    ...plays("b", T0 + 5 * MIN, [{ song: "S0001", c: 1 }, { song: "S0002", c: 0.1, listened: 20 }, { song: "S0003", c: 0.4, cause: "pagehide" }]),
    ...plays("c", T0 + DAY, ids.map((s) => ({ song: s, c: 1 }))),
    postChange("b", T0 + 30 * MIN, { change: -1, pace_answer: "faster", length_dir: "long", reasons: { length: "user", path_jump: "ai" }, positions: [2] }),
  ];
  const { norm } = modelOf(rawOf({ recs, events, as_of_ms: T0 + 2 * DAY }), IDX);
  const [a, b, c] = norm.sessions;
  assert.equal(a.rerequested_within_10min, true);
  assert.equal(a.ended_by, "new_rec");
  assert.equal(b.rerequested_within_10min, false);
  near(b.reached_frac, 0.75);
  assert.equal(b.ended_by, "quit");
  assert.equal(c.ended_by, "complete");
  near(c.reached_frac, 1);
  assert.deepEqual(b.post, { change: -1, touched: true, reasons: { length: "user", path_jump: "ai" }, ai_removed: [], positions: [2],
                             pace_answer: "faster", length_dir: "long", end_va: null });
  assert.equal(b.arrival_index, 4);
  assert.equal(b.exposures[1].prev_index, 0);
  for (const k of ["rec_id", "at_ms", "app", "seed", "input", "used", "policy", "n_path", "arrival_index", "path", "extras", "exposures", "transitions",
                   "likes_on", "dislikes", "post", "reached_frac", "rerequested_within_10min", "ended_by"]) assert.ok(k in b, k);
  for (const k of ["now", "target", "now_table", "target_table", "labels", "nudged", "minutes", "minutes_base", "nl_minutes", "lyric", "genres", "pace_user",
                   "stress", "high_stress"]) assert.ok(k in b.input, k);
  assert.equal(b.input.stress, 3);
  assert.equal(b.input.high_stress, true);
});

test("정규화는 입력 순서와 무관하다 (문서·이벤트를 섞어도 같은 모델 digest)", () => {
  const recs = [fwRec("f1", T0, { path: PATH8 }), wpRec("w1", T0 + DAY, { path: ["S0010", "S0011"] })];
  const events = [...legacySession("f1", T0), ...plays("w1", T0 + DAY, [{ song: "S0010", c: 1 }, { song: "S0011", c: 0.1, listened: 20 }])];
  const raw1 = rawOf({ recs, events });
  const raw2 = { ...raw1, recommendations: [...raw1.recommendations].reverse(), events: [...raw1.events].reverse() };
  assert.equal(modelOf(raw1, IDX).model.digest, modelOf(raw2, IDX).model.digest);
});
