/*
 * 시뮬레이터의 "한 사용자 저장소" — Firestore(recommendations · context_events · users/{uid} · listeningHistory)와
 * 그 기기의 localStorage(최근 곡 60, 세션 번호)를 메모리에 흉내 낸다. 팔(wp·twin·frozen)마다 따로 만든다.
 * P13 은 같은 저장소에 fix-web 세션과 web-personal 세션이 차례로 쌓인다(같은 uid, 같은 Firestore — §2.3 "따뜻한 시작").
 *
 *   createStore({ uid })                          빈 저장소
 *   setupWall(store, persona, catalogIndex)       P5: 벽 곡·벽 가수 (온보딩)
 *   addRec(store, recDoc, at_ms)                  추천 문서 쓰기 → id
 *   ingest(store, rec, at_ms, out, { app })       respond() 결과(이벤트·청취 기록)를 쓰고 users 문서를 앱과 같은 규칙으로 갱신
 *   toRawFacts(store, { as_of_ms, vocab, rules, env })   §6.1 RawFacts — 앱이 로그인 때 읽는 것과 같은 창(추천 100 · 이벤트 400×3쪽)
 *   behaviorHistory(store, extra)                 respond() 의 history 인자
 */
import { artistKeys } from "./behavior.mjs";

export function createStore({ uid }) {
  return {
    uid,
    recs: [],          // 추천 문서 (오래된 것부터) — { id, user_id, is_anonymous, created_at_ms, algorithm_version, input, sequence }
    events: [],        // context_events (오래된 것부터) — { id, created_at_ms, rec_id, type, payload }
    listening: [],     // users/{uid}/listeningHistory 행 (fix-web 이 쓴다) — { ..., created_at_ms }
    profile: {
      likedSongs: [], dislikedSongs: [], playlists: [], favorite_tracks: [], wallMeta: {},
      wallArtists: [], preferred_artists: [], pinned_artists_resolved: [], recommend_minutes: null, preferred_genres: [],
    },
    wp: null,          // users/{uid}.wp_personal_v1 — web-personal 이 처음 쓸 때 생긴다
    local: { recent: [], day: null, no: 0 },      // fix-web 기기 localStorage (azt_recent_played_v1, azt_session_no_v1)
    played_sessions: [],   // 세션마다 실제로 재생(노출)된 곡 — 행동 모형의 반복 판정용 (최신이 뒤)
    heard: new Set(),      // 한 번이라도 10초 이상 들은 곡
    n: { rec: 0, ev: 0, row: 0 },
    fills: 0,              // buildRecLog 결과에 빠진 필드를 시뮬레이터가 보충한 횟수(보고서에 적음)
  };
}

/* P5: 벽 곡 N개(가수 키가 일치하는 곡을 song_id 순으로) + 벽 가수. 온보딩이라 시각 없음(null). */
export function setupWall(store, persona, catalogIndex) {
  if (!persona.wall) return;
  const key = artistKeys(persona.wall.artist)[0];
  const ids = [...catalogIndex.byId.values()].filter((s) => artistKeys(s.artist).includes(key))
    .map((s) => s.song_id).sort().slice(0, persona.wall.songs);
  store.profile.playlists = ids;
  store.profile.wallMeta = Object.fromEntries(ids.map((id) => [id, { src: "onboarding", at: null }]));
  store.profile.wallArtists = [persona.wall.artist];
  store.profile.pinned_artists_resolved = [persona.wall.artist];
}

export function addRec(store, recDoc, at_ms) {
  const id = recDoc.id || `${store.uid}-rec${String(++store.n.rec).padStart(4, "0")}`;
  const doc = { ...recDoc, id, user_id: store.uid, is_anonymous: false, created_at_ms: at_ms, created_at: at_ms };
  store.recs.push(doc);
  return doc;
}

const addUnique = (arr, x) => (arr.includes(x) ? arr : [...arr, x]);
const remove = (arr, x) => arr.filter((y) => y !== x);

/**
 * respond() 결과를 저장소에 쓴다. 이벤트 시각 = 추천 시각 + t_s. users 문서 갱신은 앱과 같은 규칙:
 *   like on → likedSongs 추가·dislikedSongs 제거 / dislike on → 반대 (setSongFeedback)
 *   web-personal: wp_personal_v1.state_at·dislike_reasons (§7.4) — fix-web 은 쓰지 않는다
 *   fix-web: 추천마다 recommend_minutes·preferred_genres 를 계정에 덮어씀(B2 — 76e8bdf L3546) · listeningHistory 행
 */
export function ingest(store, rec, at_ms, out, { app }) {
  const wp = app === "web-personal";
  for (const e of out.events) {
    const created = at_ms + Math.round(e.t_s * 1000);
    store.events.push({ id: `${store.uid}-ev${String(++store.n.ev).padStart(6, "0")}`, created_at_ms: created, rec_id: e.rec_id ?? rec.id, type: e.type, payload: e.payload });
    const sid = e.payload && e.payload.song_id;
    if (e.type === "like" && sid && e.payload.on !== false) {
      store.profile.likedSongs = addUnique(store.profile.likedSongs, sid); store.profile.dislikedSongs = remove(store.profile.dislikedSongs, sid);
      if (wp) wpDoc(store).state_at[sid] = created;
    } else if (e.type === "dislike" && sid && e.payload.on !== false) {
      store.profile.dislikedSongs = addUnique(store.profile.dislikedSongs, sid); store.profile.likedSongs = remove(store.profile.likedSongs, sid);
      if (wp) wpDoc(store).state_at[sid] = created;
    } else if (e.type === "dislike_reason" && sid && wp) {
      wpDoc(store).dislike_reasons[sid] = { reason: e.payload.reason, at_ms: created };
    }
  }
  for (const r of out.listening || []) {
    const created = at_ms + Math.round(r.t_s * 1000);
    const { t_s, ...row } = r;
    store.listening.push({ ...row, id: `${store.uid}-lh${++store.n.row}`, at: new Date(created).toISOString(), created_at_ms: created });
  }
  if (!wp) { store.profile.recommend_minutes = Number(rec.input && rec.input.recommend_minutes) || 30; store.profile.preferred_genres = [...((rec.input && rec.input.genres) || [])]; }
  const exposed = out.played.filter((p) => p.exposed).map((p) => p.song_id);
  store.played_sessions.push(exposed);
  for (const p of out.played) if (p.listened_s >= 10) store.heard.add(p.song_id);
}

function wpDoc(store) {
  if (!store.wp) store.wp = { schema: 1, app: "web-personal", opt_out: false, resets: {}, dislike_reasons: {}, state_at: {}, gate_off_until: {}, calib_prompt_seen: {} };
  return store.wp;
}

/** §6.1 RawFacts. 앱이 로그인 때 읽는 것과 같은 범위: 추천 최근 load.recs(100), 이벤트 최근 event_pages×event_page_size(1,200). */
export function toRawFacts(store, { as_of_ms, vocab, rules, env = "local" }) {
  const L = (rules && rules.personalization && rules.personalization.load) || {};
  const nRec = Number(L.recs ?? 100), nEv = Number(L.event_pages ?? 3) * Number(L.event_page_size ?? 400);
  const recs = store.recs.filter((r) => r.created_at_ms <= as_of_ms).slice(-nRec).reverse();
  const events = store.events.filter((e) => e.created_at_ms <= as_of_ms).slice(-nEv).reverse();
  const P = store.profile;
  return {
    schema: "wp-raw/1", uid: store.uid, as_of_ms, env: { app: "web-personal", env },
    profile: {
      likedSongs: [...P.likedSongs], dislikedSongs: [...P.dislikedSongs], playlists: [...P.playlists], favorite_tracks: [...P.favorite_tracks],
      wallMeta: JSON.parse(JSON.stringify(P.wallMeta)), pinned_artists_resolved: [...P.pinned_artists_resolved],
      recommend_minutes: P.recommend_minutes, wp_personal_v1: store.wp ? JSON.parse(JSON.stringify(store.wp)) : null,
    },
    recommendations: recs.map((r) => JSON.parse(JSON.stringify(r))),
    events: events.map((e) => JSON.parse(JSON.stringify(e))),
    listening_history: null,
    session_log: { recommendations: [], events: [] },
    vocab: JSON.parse(JSON.stringify(vocab)),
    context: { global_stats_digest: null },
  };
}

/** respond() 의 history — 최근 세션 재생 곡(최신 먼저)·좋아요·벽·들은 곡 */
export function behaviorHistory(store, extra = {}) {
  return {
    recent_sessions: [...store.played_sessions].reverse(),
    liked_ids: [...store.profile.likedSongs], disliked_ids: [...store.profile.dislikedSongs], wall_ids: [...store.profile.playlists],
    heard_ids: [...store.heard],
    ...extra,
  };
}
