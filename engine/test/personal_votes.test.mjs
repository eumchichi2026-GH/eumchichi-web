/* 청취 표(§3.2, 9/20 합의) · 취향 항목(§4.7.1) · 싫어요 범위 추가(§4.7.2) · μ(§4.7.3) */
import test from "node:test";
import assert from "node:assert/strict";
import { P, RULES, T0, DAY, MIN, makeCatalog, makeIndex, song, wpRec, plays, ev, rawOf, modelOf, near } from "./personal_harness.test.mjs";

const X = (o) => ({ song_id: "S0001", position: 1, role: "path", instance: 1, started: true, listened_s: 100, duration_s: 200, catalog_s: 200,
                    completion: 0.5, preview: false, cause: "next", prev_song_id: null, prev_completion: null, at_ms: T0, source: "track_exit", ...o });

test("청취 표 — 끝까지·조기 넘김·표 없음 (§3.2 표 전체)", () => {
  const V = (o, a) => P.listenVote(X(o), RULES, a);
  assert.deepEqual(V({ completion: 0.9, cause: "complete", listened_s: 180 }), { pos: 0.25, neg: 0 });
  assert.deepEqual(V({ completion: 0.70, cause: "complete", listened_s: 140 }), { pos: 0.25, neg: 0 });   // 경계 0.70 은 끝까지
  assert.deepEqual(V({ completion: 0.8, cause: "next", listened_s: 160 }), { pos: 0.25, neg: 0 });       // 70% 넘게 듣고 넘겨도 +
  assert.deepEqual(V({ completion: 0.1, cause: "next", listened_s: 20 }), { pos: 0, neg: 0.25 });
  assert.deepEqual(V({ completion: 0.29, cause: "jump", listened_s: 58 }), { pos: 0, neg: 0.25 });
  assert.equal(V({ completion: 0.30, cause: "next", listened_s: 60 }), null);   // 경계 0.30 은 조기 넘김이 아니다
  assert.equal(V({ completion: 0.5, cause: "next" }), null);                    // 30~70% 표 없음
  for (const cause of ["prev", "pagehide", "new_rec", "session_end"]) assert.equal(V({ completion: 0.1, cause, listened_s: 20 }), null, cause);
  assert.equal(V({ completion: 0, cause: "autoplay_fail", started: false, listened_s: 0 }), null);
  assert.equal(V({ completion: 0.01, cause: "next", listened_s: 2.9 }), null);   // 노출 3초 미만 — 노출이 아니다
  assert.equal(V({ completion: 0.1, cause: "next", listened_s: 20, started: false }), null);
});

test("청취 표 — 전환 귀속분 a 만큼 부정 표를 줄인다 (§4.8.4)", () => {
  near(P.listenVote(X({ completion: 0.1, cause: "next", listened_s: 20 }), RULES, 0.4).neg, 0.15);
  assert.equal(P.listenVote(X({ completion: 0.9, cause: "complete", listened_s: 180 }), RULES, 0.8).pos, 0.25);   // 긍정 표는 그대로
});

test("청취 표 — 미리듣기·옛 기록은 반값, 둘 다면 곱 (§3.2 φ)", () => {
  const pv = { preview: true, duration_s: 30, catalog_s: 200, listened_s: 30 };
  assert.deepEqual(P.listenVote(X({ ...pv, completion: 1, cause: "complete" }), RULES), { pos: 0.125, neg: 0 });
  assert.deepEqual(P.listenVote(X({ ...pv, completion: 0.1, cause: "next", listened_s: 3 }), RULES), { pos: 0, neg: 0.125 });
  assert.deepEqual(P.listenVote(X({ source: "legacy", completion: 0.95, cause: "complete", listened_s: 190 }), RULES), { pos: 0.125, neg: 0 });
  assert.deepEqual(P.listenVote(X({ ...pv, source: "legacy", completion: 1, cause: "complete" }), RULES), { pos: 0.0625, neg: 0 });
});

test("청취 표 — 미리듣기 판정은 임베드 길이 ≤ 31초 ∧ 카탈로그 ≥ 45초 (normalizeLogs)", () => {
  const idx = makeIndex(makeCatalog(40));
  const recs = [wpRec("r1", T0, { path: ["S0001", "S0002"] })];
  const events = plays("r1", T0, [{ song: "S0001", c: 1, dur: 30, catalog_s: 200 }, { song: "S0002", c: 1, dur: 30, catalog_s: 30 }]);
  for (const e of events) delete e.payload.preview;   // 앱이 preview 를 안 줘도 규칙으로 판정
  const { norm } = modelOf(rawOf({ recs, events }), idx);
  const ex = norm.sessions[0].exposures;
  assert.equal(ex[0].preview, true);
  assert.equal(ex[1].preview, false);   // 카탈로그도 짧은 곡(30초)은 원래 짧은 곡
});

test("곡당 암묵 표 상한 1 — 시간순으로 더하다가 닿으면 멈춘다", () => {
  const idx = makeIndex(makeCatalog(40));
  const recs = [], events = [];
  for (let k = 0; k < 6; k++) {
    const at = T0 + k * DAY;
    recs.push(wpRec("r" + k, at, { path: ["S0001", "S0002", "S0003"] }));
    events.push(...plays("r" + k, at, [
      { song: "S0001", c: 1 },                                             // 매번 끝까지 → 0.25 × 4 에서 멈춤
      { song: "S0002", c: k < 3 ? 1 : 0.1, listened: k < 3 ? 200 : 20 },   // 끝까지 3번(0.75) 다음 넘김 → 0.25 에서 멈춤
      k === 3 ? { song: "S0003", c: 1, dur: 30, catalog_s: 200, preview: true } : { song: "S0003", c: 1 },   // 0.75 → +0.125(미리듣기) → +0.125(남은 몫)
    ]));
  }
  const { model } = modelOf(rawOf({ recs, events, as_of_ms: T0 + 6 * DAY }), idx);
  const it = Object.fromEntries(model.taste.items.map((x) => [x.song_id, x]));
  assert.deepEqual(it.S0001.vote, { pos: 1, neg: 0, pin: 0 });
  assert.deepEqual(it.S0002.vote, { pos: 0.75, neg: 0.25, pin: 0 });
  assert.deepEqual(it.S0003.vote, { pos: 1, neg: 0, pin: 0 });
  assert.equal(model.counts_for_explain.taste.completes, 4 + 3 + 5);   // 상한에 기여한 노출만 센다
  assert.equal(model.counts_for_explain.taste.skips, 1);
  near(model.taste.E, 3);
  assert.deepEqual(model.taste.affinity.song_likes.S0001 && { pos: model.taste.affinity.song_likes.S0001.pos, neg: model.taste.affinity.song_likes.S0001.neg }, { pos: 1, neg: 0 });
});

test("명시가 이긴다 — 좋아요·싫어요·벽 곡의 청취는 표가 되지 않는다", () => {
  const idx = makeIndex(makeCatalog(40));
  const recs = [wpRec("r1", T0, { path: ["S0001", "S0002", "S0003", "S0004"] })];
  const events = plays("r1", T0, [{ song: "S0001", c: 1 }, { song: "S0002", c: 0.1, listened: 20 }, { song: "S0003", c: 1 }, { song: "S0004", c: 1 }]);
  const profile = { likedSongs: ["S0001"], dislikedSongs: ["S0002"], playlists: ["S0003"] };
  const { model } = modelOf(rawOf({ recs, events, profile }), idx);
  const it = Object.fromEntries(model.taste.items.map((x) => [x.song_id, x]));
  assert.equal(it.S0001.liked, true); assert.equal(it.S0001.vote, undefined);
  assert.equal(it.S0002.disliked, true); assert.equal(it.S0002.vote, undefined);
  assert.equal(it.S0003.pinned, true); assert.equal(it.S0003.vote, undefined);
  assert.deepEqual(it.S0004.vote, { pos: 0.25, neg: 0, pin: 0 });
  // E = 좋아요 1 + 취향 싫어요 1(이유 없음 = 취향 전체) + 0.5·벽 1 + 청취 0.25
  near(model.taste.E, 1 + 1 + 0.5 + 0.25);
});

test("싫어요 범위 추가 — arrival_mismatch·length 싫어요는 그 곡만 제외하고 어떤 묶음에도 세지 않는다 (§4.7.2, B1)", () => {
  const cat = [song("D1", { artist: "도착가수" }), song("D2", { artist: "취향가수" }), song("D3", { artist: "길이가수" }), song("D4", { artist: "목소리가수" })];
  const idx = makeIndex([...makeCatalog(30), ...cat]);
  const profile = {
    dislikedSongs: ["D1", "D2", "D3", "D4"],
    wp_personal_v1: { dislike_reasons: { D1: { reason: "arrival_mismatch", at_ms: T0 }, D3: { reason: "length", at_ms: T0 } } },
  };
  const events = [ev(null, T0 + DAY, "dislike_reason", { song_id: "D2", reason: "not_my_taste" }),
                  ev(null, T0 + DAY, "dislike_reason", { song_id: "D4", reason: "vocal_bother" })];
  const { model } = modelOf(rawOf({ events, profile }), idx);
  const aff = model.taste.affinity;
  assert.equal(aff.artist_affinity["도착가수"], undefined);
  assert.equal(aff.artist_affinity["길이가수"], undefined);
  assert.equal(aff.song_likes.D1, undefined);
  assert.equal(aff.artist_affinity["취향가수"].neg, 1);
  assert.equal(aff.artist_affinity["목소리가수"], undefined);   // vocal_bother 는 말 비중·연주곡 묶음에만
  assert.deepEqual(aff.like_base, { pos: 0, neg: 1 });           // 취향 싫어요(D2)만 내 평균에
  near(model.taste.E, 1);                                        // 취향 싫어요만 증거
  const out = P.resolvePolicy(model, { now: { v: 0.5, e: 0.5 }, minutes: 30 }, RULES);
  for (const id of ["D1", "D2", "D3", "D4"]) assert.ok(out.user.disliked.includes(id), id);   // 싫어요 = 후보 제외(I12), 이유와 무관
});

test("싫어요 이유 — wp_personal_v1 과 dislike_reason 이벤트 중 늦은 것 (B16)", () => {
  const idx = makeIndex([...makeCatalog(20), song("D1", { artist: "가" })]);
  const profile = { dislikedSongs: ["D1"], wp_personal_v1: { dislike_reasons: { D1: { reason: "arrival_mismatch", at_ms: T0 } } } };
  const later = modelOf(rawOf({ profile, events: [ev(null, T0 + DAY, "dislike_reason", { song_id: "D1", reason: "not_my_taste" })] }), idx).model;
  assert.equal(later.taste.items.find((x) => x.song_id === "D1").reason, "not_my_taste");
  const earlier = modelOf(rawOf({ profile, events: [ev(null, T0 - DAY, "dislike_reason", { song_id: "D1", reason: "not_my_taste" })] }), idx).model;
  assert.equal(earlier.taste.items.find((x) => x.song_id === "D1").reason, "arrival_mismatch");
});

test("preferred_genres 는 항목을 만들지 않고 taste_vector 는 읽지 않는다 (B2·B5·D3)", () => {
  const idx = makeIndex(makeCatalog(40));
  const profile = { preferred_genres: ["재즈", "발라드"], taste_vector: { tempo: 0.9, instrumental: 1 }, preferred_artists: ["가수1"] };
  const { model } = modelOf(rawOf({ profile }), idx);
  assert.equal(model.taste.items.length, 0);
  assert.deepEqual(model.taste.affinity.genre_affinity, {});
  assert.equal(model.taste.E, 0);
  assert.equal(model.taste.mu, 0);
  const base = modelOf(rawOf({}), idx).model;
  assert.equal(model.digest, base.digest);   // 두 필드가 모델을 전혀 바꾸지 않는다
});

test("μ = 0.5·E/(E+8) — 명세 계산 예 (§4.7.3)", () => {
  const idx = makeIndex(makeCatalog(80));
  // 선호곡 3·가수 2만 → E 2.5 → μ 0.12
  const prof = { favorite_tracks: ["S0010", "S0011", "S0012"], pinned_artists_resolved: ["가수1", "가수2"] };
  const m1 = modelOf(rawOf({ profile: prof }), idx).model;
  near(m1.taste.E, 2.5);
  near(m1.taste.mu, 0.5 * 2.5 / 10.5);
  assert.equal(Math.round(m1.taste.mu * 100) / 100, 0.12);
  // 2세션 뒤(좋아요 3, 끝까지 8곡 = 2.0, 넘김 4곡 = 1.0) → E 8.5 → μ 0.26
  const recs = [], events = [];
  const kept = ["S0020", "S0021", "S0022", "S0023", "S0024", "S0025", "S0026", "S0027"], skipped = ["S0030", "S0031", "S0032", "S0033"];
  const sess = [[...kept.slice(0, 4), ...skipped.slice(0, 2)], [...kept.slice(4), ...skipped.slice(2)]];
  sess.forEach((ids, k) => {
    const at = T0 + k * DAY;
    recs.push(wpRec("r" + k, at, { path: ids }));
    events.push(...plays("r" + k, at, ids.map((id) => (skipped.includes(id) ? { song: id, c: 0.1, listened: 20 } : { song: id, c: 1 }))));
  });
  const m2 = modelOf(rawOf({ recs, events, profile: { ...prof, likedSongs: ["S0040", "S0041", "S0042"] }, as_of_ms: T0 + 2 * DAY }), idx).model;
  near(m2.taste.E, 8.5);
  near(m2.taste.mu, 0.5 * 8.5 / 16.5);
  assert.equal(Math.round(m2.taste.mu * 100) / 100, 0.26);
  // 기록 없음 → μ 0 (2.5.1 과 같은 순위)
  const m0 = P.emptyModel(RULES);
  assert.equal(m0.taste.mu, 0);
  assert.equal(P.resolvePolicy(m0, { now: { v: 0.5, e: 0.5 } }, RULES).policy.mu, 0);
  assert.equal(P.resolvePolicy(m2, { now: { v: 0.5, e: 0.5 } }, RULES).policy.mu, m2.taste.mu);
  assert.equal(P.resolvePolicy(m2, { now: { v: 0.5, e: 0.5 } }, RULES, { mode: "p0" }).policy.mu, 0);
});

test("취향 초기화 — personal_reset{taste} 이전의 청취 표는 무시한다 (§3.6)", () => {
  const idx = makeIndex(makeCatalog(40));
  const recs = [wpRec("r1", T0, { path: ["S0001"] }), wpRec("r2", T0 + 2 * DAY, { path: ["S0002"] })];
  const events = [...plays("r1", T0, [{ song: "S0001", c: 1 }]), ...plays("r2", T0 + 2 * DAY, [{ song: "S0002", c: 1 }]),
                  ev("r1", T0 + DAY, "personal_reset", { procedure: "taste" })];
  const { model } = modelOf(rawOf({ recs, events, as_of_ms: T0 + 3 * DAY }), idx);
  assert.deepEqual(model.taste.items.map((x) => x.song_id), ["S0002"]);
});

test("카탈로그에 없는 곡은 취향 항목이 되지 않는다", () => {
  const idx = makeIndex(makeCatalog(10));
  const { model } = modelOf(rawOf({ profile: { likedSongs: ["NOPE", "S0001"] } }), idx);
  assert.deepEqual(model.taste.items.map((x) => x.song_id), ["S0001"]);
});

test("취향 설명 횟수 — 묶음별 좋아요·끝까지·넘김 (§4.7 설명)", () => {
  const cat = [song("J1", { artist: "재즈가수", genres: ["재즈"] }), song("J2", { artist: "재즈가수", genres: ["재즈"] }),
               song("J3", { artist: "재즈가수", genres: ["재즈"] }), song("K1", { artist: "케이가수", genres: ["K-pop"] }),
               song("K2", { artist: "케이가수", genres: ["K-pop"] }), song("K3", { artist: "케이가수", genres: ["K-pop"] })];
  const idx = makeIndex([...makeCatalog(30), ...cat]);
  const recs = [wpRec("r1", T0, { path: ["J1", "J2", "K1", "K2", "K3"] })];
  const events = plays("r1", T0, [{ song: "J1", c: 1 }, { song: "J2", c: 1 }, { song: "K1", c: 0.1, listened: 20 }, { song: "K2", c: 0.1, listened: 20 },
                                  { song: "K3", c: 0.1, listened: 20 }]);
  const { model } = modelOf(rawOf({ recs, events, profile: { likedSongs: ["J3"] }, as_of_ms: T0 + DAY }), idx);
  const g = model.counts_for_explain.taste.groups;
  const top = g.top.find((r) => r.label === "재즈");
  assert.ok(top, JSON.stringify(g.top));
  assert.equal(top.likes, 1); assert.equal(top.completes, 2);
  assert.ok(g.bottom.some((r) => r.label === "K-pop" && r.skips === 3), JSON.stringify(g.bottom));
});

test("인기도 특징(P2, 기본 꺼짐) — 켜면 feature_bins_p 로 표를 주고 정책에 taste_features 를 싣는다 (§4.7.5)", () => {
  const cat = makeCatalog(60);
  const off = modelOf(rawOf({ profile: { likedSongs: ["S0001"] } }), makeIndex(cat)).model;
  assert.ok(!Object.keys(off.taste.affinity.feature_affinity).some((k) => k.startsWith("popularity:")));
  assert.equal(P.resolvePolicy(off, { now: { v: 0.6, e: 0.5 }, minutes: 30 }, RULES).policy.taste_features, null);
  const R2 = structuredClone(RULES);
  R2.personalization.taste.extra_features = R2.personalization.taste.extra_features_available.slice();
  const { model } = modelOf(rawOf({ profile: { likedSongs: ["S0001"] } }), cat, R2);   // 배열을 넘기면 feature_bins·feature_bins_p 를 엔진 binner 로 채운다
  assert.ok(Object.keys(model.taste.affinity.feature_affinity).some((k) => k.startsWith("popularity:")));
  const pol = P.resolvePolicy(model, { now: { v: 0.6, e: 0.5 }, minutes: 30 }, R2).policy;
  assert.deepEqual(pol.taste_features.map((f) => f.id), ["popularity"]);
});

test("표 좌표가 빠진 web-personal 기록은 단어 표로 다시 계산한다", () => {
  const rec = wpRec("t0", T0, { path: ["S0001"], input: { table_point: { current: null, target: null }, current_va: { v: 0.3, e: 0.62 }, nudged: { current: true, target: false } } });
  const { norm } = modelOf(rawOf({ recs: [rec], as_of_ms: T0 }), makeIndex(makeCatalog(20)));
  assert.deepEqual(norm.sessions[0].input.now_table, { v: 0.3, e: 0.72 });
  assert.deepEqual(norm.sessions[0].input.target_table, { v: 0.6, e: 0.3 });
});
