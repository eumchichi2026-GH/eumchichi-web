/*
 * fix-web 쌍둥이 (TOOLS · 명세 §9.3 · §11 "twin" 팔) — 76e8bdf 의 추천 경로를 그대로 재현한다.
 *
 *   엔진 2.5.1 + 규칙 v2.4.0  → baseline.mjs loadBaseline("76e8bdf") (기준 사본 tools/sim/baseline/ 을 임시 파일로 import 후 삭제)
 *   앱 규칙 (76e8bdf index.html — 기준 사본 tools/sim/baseline/index_76e8bdf.html, 아래 줄 번호도 그 파일 기준):
 *     buildHeardItems   L2328–2365  들어본 곡 = 청취 기록(10초 이상 또는 넘김) ∪ 벽 ∪ 좋아요·싫어요, 2.5.0 암묵 표(완주율 최고값·가장 최근 넘김)
 *                       + 벽 가수 항목 + preferred_genres 항목(세션 장르 저장 — 시뮬레이터 세션은 장르를 고르지 않아 비어 있음)
 *     loadHeardHistory  L1222       listeningHistory 최근 200행, loadPersonalFeedback L2179 이벤트 400건 창(STATE_DAYS·DISLIKE_REASONS)
 *     recentlyPlayedIds L2403–2413  이 기기 localStorage 60곡, "추천된" 경로 곡(더 들을 곡 제외)
 *     PACE_TP           L3477–3483  속도 버튼 = 전환점을 바꾼 규칙 사본 { fast 0.5, slow 1.0 }
 *     더 들을 곡          L3522–3537  원좌표 목표 거리순, 싫어요·최근 제외, 추정 길이 max(60, durationSec||180), 합이 분·60·0.85 까지 — 재생 큐 밖
 *     logRecommendation L2452       옛 추천 문서 모양 (input.app 없음)
 *   전체 사용자 통계(song_stats)는 시뮬레이터에 다른 사용자가 없어 {} — 세 팔 모두 같다.
 *
 * 사용: const twin = createTwin({ baseline, catalogIndex, tables });  twin.recommend(store, plan, at_ms) → { result, extras, recDoc, engineInput }
 */
const PACE_TP_76E8BDF = { fast: [{ up_to: 999, at: 0.5 }], slow: [{ up_to: 999, at: 1.0 }] };   // L3477 사본 (tables.PACE_TP 가 있으면 그것)
const HEARD_MIN_SECONDS = 10;                                                                   // L814
const RECENT_MAX = 60;                                                                          // L2404
const HISTORY_ROWS = 200, EVENT_WINDOW = 400;                                                   // L1225, L2203

const r3 = (x) => Number(Number(x).toFixed(3));

/**
 * @param o.baseline  { engine, rules } — 76e8bdf
 * @param o.catalogIndex CatalogIndex (계약 곡 + feature_bins)
 * @param o.tables    loadAppTablesAt("76e8bdf") 결과(PACE_TP·deriveStress) — 없으면 사본
 */
export function createTwin({ baseline, catalogIndex, tables = null }) {
  const { engine, rules } = baseline;
  const PACE_TP = (tables && tables.PACE_TP) || PACE_TP_76E8BDF;
  const deriveStress = (tables && tables.deriveStress) || ((cur) => {
    if (!cur) return 2;
    const tension = (1 - cur.v) * 0.6 + cur.e * 0.4;
    return Math.max(0, Math.min(4, Math.round(tension * 4)));
  });
  const songs = [...catalogIndex.byId.values()];
  const contract = songs;   // 계약 곡 모양 그대로 (feature_bins 는 규칙 preference.features 가 같아 동일)
  const ALGO = rules.rules_version + "+" + rules.rules_hash + (engine.ENGINE_VERSION ? "+e" + engine.ENGINE_VERSION : "");

  /* loadHeardHistory + loadPersonalFeedback + buildHeardItems (L1210–1234, L2179–2224, L2328–2365) */
  function heardItems(store, now_ms) {
    const days = (ms) => (ms ? Math.max(0, (now_ms - ms) / 86400000) : 0);
    const HEARD = {}, HOW = {};
    const noteHeard = (id, d, completion, skipped) => {
      if (!id) return;
      d = Math.max(0, Number(d) || 0);
      const fresh = !(id in HEARD) || d < HEARD[id];
      if (fresh) HEARD[id] = d;
      const h = HOW[id] || (HOW[id] = { completion: 0, skipped: false });
      if (Number(completion) > h.completion) h.completion = Number(completion) || 0;
      if (fresh) h.skipped = !!skipped;
    };
    const rows = store.listening.filter((r) => r.created_at_ms <= now_ms).slice(-HISTORY_ROWS).reverse();   // 최신순
    for (const r of rows) if (Number(r.listenedSeconds) >= HEARD_MIN_SECONDS || r.skipped) noteHeard(r.songId, days(r.created_at_ms), r.completionRate, r.skipped);
    const STATE_DAYS = {}, REASONS = {};
    const evs = store.events.filter((e) => e.created_at_ms <= now_ms).slice(-EVENT_WINDOW).reverse();
    for (const e of evs) {
      const sid = e.payload && e.payload.song_id, d = days(e.created_at_ms);
      if ((e.type === "like" || e.type === "playlist_add" || e.type === "dislike") && sid) STATE_DAYS[sid] = sid in STATE_DAYS ? Math.min(STATE_DAYS[sid], d) : d;
      else if (e.type === "dislike_reason" && sid && e.payload.reason && !(sid in REASONS)) REASONS[sid] = e.payload.reason;
    }
    const P = store.profile;
    const LIKED = new Set(P.likedSongs), DISLIKED = new Set(P.dislikedSongs), fav = new Set(P.favorite_tracks);
    const dmap = {};
    const see = (id, d) => { if (id && (!(id in dmap) || d < dmap[id])) dmap[id] = d; };
    for (const [id, d] of Object.entries(HEARD)) see(id, d);
    /* LISTEN_HISTORY(이 기기 100행)는 같은 기록의 사본이라 결과가 같다. TRACK_METRICS 는 새로 연 페이지라 비어 있다. */
    const wallSongs = new Set([...P.playlists, ...fav]);
    for (const id of wallSongs) see(id, 0);
    for (const id of LIKED) see(id, STATE_DAYS[id] || 0);
    for (const id of DISLIKED) see(id, STATE_DAYS[id] || 0);
    const items = [];
    for (const [id, d] of Object.entries(dmap)) {
      const c = catalogIndex.byId.get(id);
      if (!c) continue;
      const how = HOW[id] || {};
      items.push({ song_id: id, liked: LIKED.has(id), disliked: DISLIKED.has(id), pinned: wallSongs.has(id), completion: how.completion || 0,
                   skipped: !!how.skipped && !LIKED.has(id), reason: REASONS[id] || null, artist: c.artist, genres: c.genres, feature_bins: c.feature_bins, days: d });
    }
    const seen = new Set();
    for (const a of [...P.wallArtists, ...P.preferred_artists]) {
      const k = String(a || "").toLowerCase().replace(/\s+/g, "");
      if (!a || seen.has(k)) continue;
      seen.add(k);
      items.push({ pinned: true, artist: a, days: 0 });
    }
    for (const g of P.preferred_genres || []) items.push({ liked: true, genres: [g], days: 0 });
    return items;
  }

  /* buildUserProfile (L2370) */
  function userProfile(store, now_ms) {
    const items = heardItems(store, now_ms);
    const agg = engine.aggregateAffinity(items, rules);
    const b = agg.like_base, n = b.pos + b.neg;
    const snapshot = { mode: rules.preference.combine, heard: n, liked: b.pos, like_rate: n ? Number(((b.pos + 1) / (n + 2)).toFixed(4)) : null };
    return { user: { disliked: [...store.profile.dislikedSongs], recent_played: [...store.local.recent], global_stats: {}, ...agg }, snapshot, items };
  }

  /**
   * @param plan { now:{v,e}, target:{v,e}, minutes, pace_user, seed, input_mode }
   */
  function recommend(store, plan, now_ms) {
    const { user, snapshot } = userProfile(store, now_ms);
    const minutes = plan.minutes;
    const engineInput = {
      now: { V: plan.now.v, A: plan.now.e }, target: { V: plan.target.v, A: plan.target.e },
      stress: deriveStress(plan.now), load: null, genres: [], duration_min: minutes, seed: plan.seed, gates: [], user,
    };
    const rulesForRun = plan.pace_user ? { ...rules, iso: { ...rules.iso, transition_point: PACE_TP[plan.pace_user] } } : rules;
    const result = engine.recommend(contract, rulesForRun, engineInput);
    /* 가사·장르 조건이 없으므로 조건 완화(L3489)는 일어나지 않는다 */
    const seqIds = result.sequence.map((r) => r.song_id);
    // pushRecentlyPlayed(seq) — 경로 곡만, 최신 먼저 60곡
    store.local.recent = [...seqIds, ...store.local.recent].filter((v, i, a) => a.indexOf(v) === i).slice(0, RECENT_MAX);
    // 더 들을 곡 (L3522–3537)
    const estimated = (s) => Math.max(60, Number(s.duration_ms) / 1000 || 180);
    const used = new Set(seqIds);
    let total = seqIds.reduce((a, id) => a + estimated(catalogIndex.byId.get(id)), 0);
    const recentSet = new Set(store.local.recent), disliked = new Set(store.profile.dislikedSongs);
    const dT = (s) => Math.hypot(s.V - plan.target.v, s.A - plan.target.e);
    const pool = songs.filter((s) => !used.has(s.song_id) && !disliked.has(s.song_id) && !recentSet.has(s.song_id))
      .map((s, i) => ({ s, i, d: dT(s) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.s);
    const extras = [];
    for (const c of pool) {
      if (total >= minutes * 60 * 0.85) break;
      extras.push(c); used.add(c.song_id); total += estimated(c);
    }
    // logRecommendation (L2452) — 옛 문서 모양
    const recDoc = {
      algorithm_version: ALGO,
      input: {
        lyric_preference: "no_preference", genres: [], recommend_minutes: minutes,
        current_va: { v: r3(plan.now.v), e: r3(plan.now.e) }, target_va: { v: r3(plan.target.v), e: r3(plan.target.e) },
        input_mode: plan.input_mode || { current: "chip", target: "chip" },
        filters: { lyric: "no_preference", genres: [], genre_applied: null, genre_pool: null, pool: songs.length },
        personalization: snapshot, pace_mode: plan.pace_user || "auto", nl_text: null, nl_model: null, nl_v2: null,
      },
      sequence: [
        ...result.sequence.map((r, i) => ({ song_id: r.song_id, position: i + 1, role: "path", fit: r.trace.va_distance, band_size: r.trace.band_size,
          chosen_by: r.trace.chosen_by, pref_score: r.trace.pref_score, pref_match: !!r.trace.pref_match, pref_basis: r.trace.pref_basis || null, quadrant: r.trace.quadrant })),
        ...extras.map((s, i) => ({ song_id: s.song_id, position: result.sequence.length + i + 1, role: "extra" })),
      ],
    };
    return { result, extras, recDoc, engineInput, rulesForRun };
  }

  return { engine, rules, contract, recommend, userProfile, heardItems, ALGO };
}
