/*
 * 합성 사용자 행동 모형 (TOOLS · 명세 §9.4) — **순수 ESM**: DOM·Node 모듈·Math.random·Date.now 없음.
 * 브라우저 데모 모드(`?demo=`)의 "가상 청취 1회"도 이 파일을 그대로 import 한다(§4.12.4).
 *
 *   planSession(persona, { rngKey, vocab })                  세션 입력 고르기(지금·목표 칩, 속도 버튼) — 추천 전
 *   decideNudges(persona, input, { rngKey, mode })           보여 준 점을 끌지(참값 + 잡음) — 추천 전
 *   respond(persona, recLog, catalogIndex, { rngKey, history })
 *       → { events, nudges, answers, quit, played, latent, listening }
 *       recLog 는 §7.1 추천 문서(web-personal) 또는 fix-web 의 옛 추천 문서. 문서의 input.app 으로 앱을 가린다:
 *         web-personal  경로 + 더 들을 곡이 재생 큐, track_exit 1곡 1건, like/dislike on, post_change 새 필드(§7.2)
 *         fix-web       경로만 재생 큐(76e8bdf setupPlayer(seq)), track_milestone·track_complete·track_skip,
 *                       청취 기록 행(listeningHistory) — 새 추천·탭 닫힘에 남은 곡은 유실(B11)
 *
 * 공통 난수: 모든 반응 난수는 `${rngKey}|${song_id}|${목적}` 키의 해시다(lib_rng.u01). rngKey = "<persona>:<rep>:<session>" 이면
 * 세 팔(wp·twin·frozen)에서 같은 곡에 같은 반응이 나온다(§9.4).
 *
 * 이벤트는 { type, rec_id, t_s, payload } — t_s 는 추천 시각부터 흐른 초. 호출자가 created_at_ms = 추천 시각 + t_s·1000 을 붙인다.
 *
 * 데모 앱에서 쓰는 법(§4.12.4 "가상 청취 1회"):
 *   import { personaById, materializePersona } from "./tools/sim/personas.mjs";
 *   const persona = materializePersona(personaById(demoId), 0);
 *   const out = respond(persona, { id: LAST_REC_ID, ...recDoc }, CATALOG_INDEX, { rngKey: `${demoId}:demo:${n}`,
 *                       history: { recent_sessions, liked_ids, disliked_ids, wall_ids, heard_ids } });   // history 는 없어도 된다
 *   out.events 를 SESSION_LOG.events 에 { id, created_at_ms, rec_id, type, payload } 로 쌓고 모델을 다시 만든다.
 */
import { u01, normal, betaInv, normCdf, sigmoid, clamp, pick } from "./lib_rng.mjs";
import { BEHAVIOR, SIM } from "./personas.mjs";

const REASON_CODES = ["path_jump", "not_my_taste", "mood_mismatch", "vocal_bother", "too_repetitive", "arrival_mismatch", "length"];

/* 엔진 artistKeys 와 같은 식 — "A;B;C" 다중 표기를 쪼개 공백 제거·소문자 */
export function artistKeys(artist) {
  return String(artist || "").split(/[;]/).map((a) => a.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
}
const hyp = (a, b) => Math.hypot(a.v - b.v, a.e - b.e);
const rawOf = (song) => ({ v: Number(song.V), e: Number(song.A) });
const B = (persona) => ({ ...BEHAVIOR, ...((persona && persona.behavior) || {}) });

// ── 참값: 취향 · 전환 · 좌표 ───────────────────────────────
/** 곡 취향 u(song) — 페르소나 효과 합 (§9.4) */
export function tasteOf(persona, song) {
  const t = (persona && persona.taste) || {};
  let u = 0;
  if (t.genre) for (const g of song.genres || []) u += Number(t.genre[g] || 0);
  if (t.artist) {   // 페르소나 표기("아이유")도 같은 키 규칙으로 맞춘다. 협업곡은 가장 큰 효과 하나
    const map = {};
    for (const [name, w] of Object.entries(t.artist)) for (const k of artistKeys(name)) map[k] = Number(w);
    let best = 0;
    for (const k of artistKeys(song.artist)) if (k in map && Math.abs(map[k]) > Math.abs(best)) best = map[k];
    u += best;
  }
  if (t.instrumental && typeof song.instrumental === "boolean") u += Number(t.instrumental[song.instrumental ? "yes" : "no"] || 0);
  if (t.feature) for (const [key, w] of Object.entries(t.feature)) {
    const [fid, bin] = key.split(":");
    if (song.feature_bins && song.feature_bins[fid] === bin) u += Number(w);
  }
  return u;
}

/** 두 곡 사이 특징 차 x_f ∈ [0,1] (명세 §4.8.1 과 같은 정의 — 페르소나가 '느끼는' 차이) + 작업 좌표 전환 거리 */
export function pairFeatures(a, b, coords, persona) {
  const K = B(persona);
  const x = { tempo: 0, vocal: 0, spoken: 0, genre: 0, va: 0, bpm_diff: null };
  if (!a || !b) return x;
  if (typeof a.tempo === "number" && typeof b.tempo === "number") {
    const d = Math.abs((K.bpm_base + K.bpm_span * a.tempo) - (K.bpm_base + K.bpm_span * b.tempo));
    x.bpm_diff = d; x.tempo = Math.min(1, d / K.bpm_scale);
  }
  if (typeof a.instrumental === "boolean" && typeof b.instrumental === "boolean" && a.instrumental !== b.instrumental) x.vocal = 1;
  if (typeof a.spokenness === "number" && typeof b.spokenness === "number") x.spoken = Math.min(1, Math.abs(a.spokenness - b.spokenness) / K.spoken_scale);
  const ga = a.genres || [], gb = b.genres || [];
  if (ga.length && gb.length && !gb.some((g) => ga.includes(g))) x.genre = 1;
  const ca = coords && coords.get ? coords.get(a.song_id) : null, cb = coords && coords.get ? coords.get(b.song_id) : null;
  if (ca && cb) x.va = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
  return x;
}
/** 전환 손실 T_k = Σ β_f·x_f + 1.0·max(0, 작업좌표 전환 − 0.10)/0.10 */
export function transitionLoss(persona, x) {
  const K = B(persona), beta = (persona && persona.beta) || {};
  let T = 0;
  for (const f of ["tempo", "vocal", "spoken", "genre"]) T += Number(beta[f] || 0) * (x[f] || 0);
  T += K.va_w * Math.max(0, (x.va || 0) - K.va_free) / K.va_scale;
  return T;
}
/** 단어의 참 좌표 = 표 좌표 + δ*(없으면 0) */
export function truthPoint(persona, field, label, table) {
  if (!table) return null;
  const d = persona && persona.calib && persona.calib[field] && label ? persona.calib[field][label] : null;
  return d ? { v: table.v + d[0], e: table.e + d[1] } : { v: table.v, e: table.e };
}

// ── 추천 전: 입력 고르기 · 좌표 끌기 ──────────────────────
/**
 * @param vocab RawFacts.vocab 모양 { mood_chips: [[라벨, v, e]], goal_chips: [...] }
 * @returns { labels, table, truth, pace_user }
 */
export function planSession(persona, { rngKey, vocab }) {
  const K = B(persona);
  const moods = vocab.mood_chips, goals = vocab.goal_chips;
  const byLabel = (list, l) => list.find((c) => c[0] === l);
  let mood;
  if (persona.mood_words_only && persona.mood_words_only.length) mood = byLabel(moods, pick(`${rngKey}|mood`, persona.mood_words_only));
  else if (persona.habit_words && persona.habit_words.length && u01(`${rngKey}|habit`) < (persona.habit_prob ?? SIM.habit_prob))
    mood = byLabel(moods, pick(`${rngKey}|mood`, persona.habit_words));
  if (!mood) mood = pick(`${rngKey}|mood_any`, moods);
  const goal = pick(`${rngKey}|goal`, goals);
  const table = { current: { v: mood[1], e: mood[2] }, target: { v: goal[1], e: goal[2] } };
  const labels = { current: { mode: "chip", chip: mood[0] }, target: { mode: "chip", chip: goal[0] } };
  const truth = { current: truthPoint(persona, "current", mood[0], table.current), target: truthPoint(persona, "target", goal[0], table.target) };
  let pace_user = null;
  const pi = Number(persona.pi_star || 0);
  if (Math.abs(pi) >= K.pace_button_min && u01(`${rngKey}|pacebtn`) < K.pace_button_p) pace_user = pi > 0 ? "fast" : "slow";
  return { labels, table, truth, pace_user };
}

/**
 * 보여 준 점(shown)이 참값에서 nudge_tol 넘게 틀리면 확률 nudge_p 로 옮긴다.
 *   mode "drag"  (web-personal 끌기) 참값 + N(0, nudge_sd) 로 옮김, nudged = true
 *   mode "arrow" (fix-web 화살표)    한 칸 0.05 단위로 참값에 가장 가까운 칸(로그에는 남지 않음)
 */
export function decideNudge(persona, field, { label, table, shown }, { rngKey, mode = "drag" } = {}) {
  const K = B(persona);
  const truth = truthPoint(persona, field, label, table);
  if (!shown || !truth || persona.nudge === false) return { point: shown, nudged: false, truth };
  if (hyp(shown, truth) <= K.nudge_tol || u01(`${rngKey}|nudge:${field}`) >= K.nudge_p) return { point: shown, nudged: false, truth };
  const [lo, hi] = K.point_clamp;
  let point;
  if (mode === "arrow") {
    const st = K.arrow_step;
    point = { v: clamp(shown.v + Math.round((truth.v - shown.v) / st) * st, lo, hi), e: clamp(shown.e + Math.round((truth.e - shown.e) / st) * st, lo, hi) };
    if (hyp(point, shown) < 1e-9) return { point: shown, nudged: false, truth };
  } else {
    point = { v: clamp(truth.v + normal(`${rngKey}|nudge:${field}:v`, 0, K.nudge_sd), lo, hi),
              e: clamp(truth.e + normal(`${rngKey}|nudge:${field}:e`, 0, K.nudge_sd), lo, hi) };
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return { point: { v: r6(point.v), e: r6(point.e) }, nudged: true, truth };
}
/** 추천 문서의 입력(input.labels·table_point·calib_applied) 기준으로 두 점의 끌기 결정 */
export function decideNudges(persona, input, { rngKey, mode = "drag" } = {}) {
  const out = {};
  for (const f of ["current", "target"]) {
    const label = input && input.labels && input.labels[f] ? input.labels[f].chip || null : null;
    const table = input && input.table_point ? input.table_point[f] : null;
    const cal = input && input.calib_applied ? input.calib_applied[f] : null;
    const shown = table ? (cal ? { v: table.v + (cal.dv || 0), e: table.e + (cal.de || 0) } : table)
                        : (f === "current" ? input && input.current_va : input && input.target_va) || null;
    out[f] = decideNudge(persona, f, { label, table: table || shown, shown }, { rngKey, mode });
  }
  return out;
}

// ── 청취 후 변화 ─────────────────────────────────────────
/** 잠재값 Ũ → change 분포. E[change] = 잡음 N(0, sd) 를 적분한 기대값(평가 지표), sample = 키로 뽑은 한 값 */
export function changeOf(U, key, persona) {
  const K = B(persona);
  const m = K.change_a + K.change_b * U;
  let E = 0;
  for (let k = -2; k <= 2; k++) {
    const lo = k === -2 ? -Infinity : k - 0.5, hi = k === 2 ? Infinity : k + 0.5;
    const p = (hi === Infinity ? 1 : normCdf((hi - m) / K.change_sd)) - (lo === -Infinity ? 0 : normCdf((lo - m) / K.change_sd));
    E += k * p;
  }
  const sample = clamp(Math.round(m + normal(key, 0, K.change_sd)), -2, 2);
  return { E, sample, mean: m };
}

// ── 추천 한 번 듣기 ──────────────────────────────────────
/**
 * @param persona      materializePersona 결과
 * @param recLog       { id?, input, sequence } — §7.1 또는 fix-web 옛 모양
 * @param catalogIndex { byId: Map, coords: Map }
 * @param opts.rngKey  "<persona>:<rep>:<session>"
 * @param opts.history { recent_sessions: [[song_id]], liked_ids, wall_ids, heard_ids, truth: {current, target}, pi_used, minutes, env }
 */
export function respond(persona, recLog, catalogIndex, { rngKey, history = {} } = {}) {
  const K = B(persona);
  const input = (recLog && recLog.input) || {};
  const wp = input.app === "web-personal";
  const recId = recLog.id ?? recLog.rec_id ?? null;
  const env = history.env || input.env || "local";
  const key = (id, what) => `${rngKey}|${id}|${what}`;
  const byId = catalogIndex.byId, coords = catalogIndex.coords;

  const rows = [...(recLog.sequence || [])].sort((a, b) => a.position - b.position);
  const pathRows = rows.filter((r) => (r.role || "path") === "path");
  const queue = wp ? rows : pathRows;                          // fix-web 은 경로만 재생 큐(76e8bdf L3628)
  const nPath = pathRows.length;
  const minutes = Number(history.minutes ?? (input.effective && input.effective.minutes) ?? input.recommend_minutes ?? 30);
  const reportedNow = input.current_va || null;
  const truth = history.truth || {};
  const s0 = truth.current || (input.table_point && input.table_point.current
    ? truthPoint(persona, "current", input.labels && input.labels.current && input.labels.current.chip, input.table_point.current) : reportedNow);
  const tgtTrue = truth.target || (input.table_point && input.table_point.target
    ? truthPoint(persona, "target", input.labels && input.labels.target && input.labels.target.chip, input.table_point.target) : input.target_va);
  const piUsed = history.pi_used ?? (wp
    ? Number(input.personal_meta && input.personal_meta.params && input.personal_meta.params.pi_used != null ? input.personal_meta.params.pi_used
        : input.pace_user === "fast" ? 1 : input.pace_user === "slow" ? -1 : 0)
    : input.pace_mode === "fast" ? 1 : input.pace_mode === "slow" ? -1 : 0);

  const repSet = new Set((history.recent_sessions || []).slice(0, persona.repeat ? persona.repeat.sessions : 3).flat());
  const liked = new Set(history.liked_ids || []), wall = new Set(history.wall_ids || []), heardBefore = new Set(history.heard_ids || []);
  const likedNow = new Set(liked), dislikedNow = new Set(history.disliked_ids || []);

  const events = [], listening = [], played = [];
  let seqNo = 0;
  const ev = (type, t_s, payload) => {
    seqNo++;
    const p = wp ? { app: "web-personal", env, client_id: `${recId}|${type}|${payload.song_id || ""}|${seqNo}`, ...payload } : payload;
    events.push({ type, rec_id: recId, t_s: Math.round(t_s * 1000) / 1000, payload: p });
  };

  let t = 5;                                    // 결과 화면에서 ▶ 누르기까지
  let s = s0 ? { ...s0 } : null;
  let prevSong = null, prevExp = null, quit = false, quitAfter = null, elapsed = 0, lastStartedPath = 0;
  let nTover = 0, nRep = 0;
  const first = { song: null, skipped: false, close: false };

  for (let qi = 0; qi < queue.length; qi++) {
    const row = queue[qi];
    const role = row.role || "path";
    if (quit) break;
    if (role === "extra" && elapsed >= minutes * 60) break;      // 시간 예산을 다 쓰면 더 들을 곡은 시작하지 않는다(위 last 판정과 같은 조건)
    const song = byId.get(row.song_id);
    if (!song) continue;
    const id = song.song_id;
    const catalog_s = Math.max(1, Number(song.duration_ms || 210000) / 1000);
    const duration_s = persona.preview ? K.preview_s : catalog_s;
    const u = tasteOf(persona, song);
    const x = pairFeatures(prevSong, song, coords, persona);
    const T = prevSong ? transitionLoss(persona, x) : 0;
    const rep = repSet.has(id);
    const repLogit = rep && persona.repeat ? persona.repeat.logit : 0;
    let firstAdd = 0;
    const isFirst = role === "path" && row.position === 1;
    if (isFirst) {
      first.song = song;
      if (persona.first_reject && reportedNow && hyp(rawOf(song), reportedNow) <= persona.first_reject.dist) { firstAdd = persona.first_reject.add_p; first.close = true; }
    }
    const replayDone = !!persona.replay_complete && (liked.has(id) || wall.has(id)) && heardBefore.has(id);
    let p = clamp(sigmoid(K.skip_logit0 + K.skip_u_coef * u + T + repLogit) + firstAdd, 0, 1);
    if (replayDone) p = 0;
    const skip = u01(key(id, "skip")) < p;
    let c, cause;
    if (skip) { c = K.skip_c[0] + (K.skip_c[1] - K.skip_c[0]) * u01(key(id, "skipc")); cause = "next"; }
    else if (replayDone) { c = 1; cause = "complete"; }
    else {
      const [a, b] = u > 0 ? K.beta_pos : K.beta_neg;
      c = betaInv(u01(key(id, "comp")), a, b);
      if (c >= K.complete_at) { c = 1; cause = "complete"; } else cause = "next";
    }
    const listened_s = Math.round(c * duration_s * 100) / 100;
    const completion = Math.min(1, listened_s / duration_s);
    const tStart = t, tEnd = t + listened_s;
    elapsed += listened_s;
    /* 이 곡 뒤에 다음 곡이 시작되나: 조기 이탈(P9: 경로 N곡째 뒤 확률 p) · 시간 예산(더 들을 곡) · 큐 끝 */
    if (persona.quit && role === "path" && row.position === persona.quit.after_path && qi < queue.length - 1
        && u01(`${rngKey}|quit`) < persona.quit.p) { quit = true; quitAfter = row.position; }
    const nextRow = queue[qi + 1];
    const last = quit || !nextRow || ((nextRow.role || "path") === "extra" && elapsed >= minutes * 60);
    if (last && cause === "next") cause = quit ? "pagehide" : "session_end";   // 끝까지 안 듣고 멈춤: 탭 닫기 / 「기록하고 나가기」
    if (qi === 0) ev("sequence_play_start", tStart + 0.2, { song_id: id });   // 첫 곡 재생이 실제로 시작될 때 (76e8bdf L2756)
    if (role === "path") lastStartedPath = Math.max(lastStartedPath, row.position);
    if (isFirst) first.skipped = skip || (completion < 0.3 && cause === "next");

    // 좋아요 (10초 이상 들어야 버튼이 열린다)
    let didLike = false;
    if (!skip && u > K.like_u && completion >= K.like_c && listened_s >= K.heard_min_s && !likedNow.has(id) && u01(key(id, "like")) < K.like_p) {
      didLike = true; likedNow.add(id); dislikedNow.delete(id);
      const tl = tStart + Math.min(listened_s, Math.max(K.heard_min_s + 1, listened_s * 0.8));
      ev("like", tl, wp ? { song_id: id, on: true, position: row.position, role } : { song_id: id });
    }
    // 싫어요 (넘기기 직전에 누른다) — 이유 하나
    let reason = null;
    if (skip) {
      const spokenHigh = song.feature_bins && song.feature_bins.spokenness === "high";
      if (persona.spoken_bother_p && spokenHigh && u01(key(id, "d_vocal")) < persona.spoken_bother_p) reason = "vocal_bother";
      else if (u < K.dislike_taste_u && u01(key(id, "d_taste")) < K.dislike_taste_p) reason = "not_my_taste";
      else if (T > K.dislike_jump_T && u01(key(id, "d_jump")) < K.dislike_jump_p) reason = "path_jump";
      else if (rep && persona.repeat && u01(key(id, "d_rep")) < persona.repeat.code_p) reason = "too_repetitive";
    }
    if (reason) {
      dislikedNow.add(id); likedNow.delete(id);
      const td = Math.max(tStart + 0.5, tEnd - 1);
      const pathIdx = pathRows.findIndex((r) => r.song_id === id);
      if (wp) {
        ev("dislike", td, { song_id: id, on: true, position: row.position, role });
        ev("dislike_reason", td + 0.5, { song_id: id, reason, position: row.position, role, phase: row.phase || (role === "extra" ? "extra" : null) });
      } else {
        ev("dislike", td, { song_id: id });
        ev("dislike_reason", td + 0.5, { song_id: id, reason, position: pathIdx >= 0 ? pathIdx + 1 : null, role: pathIdx >= 0 ? "path" : "extra" });
      }
    }

    // 재생 기록
    const exp = { song_id: id, position: row.position, role, queue_pos: qi + 1, started: true, listened_s, duration_s, catalog_s,
                  completion: Math.round(completion * 1e4) / 1e4, preview: duration_s <= 31 && catalog_s >= 45, cause,
                  prev_song_id: prevExp ? prevExp.song_id : null, prev_completion: prevExp ? prevExp.completion : null };
    if (wp) {
      ev("track_exit", tEnd, { ...exp, instance: 1, bg_credit_s: 0, seek_fwd_s: 0, liked: likedNow.has(id), disliked: dislikedNow.has(id) });
      if (cause === "complete") ev("track_complete", tEnd + 0.01, { song_id: id, position: row.position, completion_rate: 1, detected_by: "update" });
      else if (cause === "next") ev("track_skip", tEnd + 0.01, { song_id: id, position: row.position, direction: "next", listened_s, completion: exp.completion, started: true });
    } else {
      /* 76e8bdf: 25·50·75% 이정표, 끝·넘김 이벤트(position 은 재생 큐 위치), 청취 기록 행(listeningHistory) */
      for (const mark of [25, 50, 75]) if (completion >= mark / 100)
        ev("track_milestone", tStart + duration_s * mark / 100, { song_id: id, position: qi + 1, milestone: mark, duration_ms: Math.round(duration_s * 1000) });
      const row0 = { songId: id, listenedSeconds: Number(listened_s.toFixed(2)), durationSeconds: duration_s, completionRate: Number(completion.toFixed(3)),
                     skipped: cause === "next", seekEvents: 0, liked: likedNow.has(id), disliked: dislikedNow.has(id), addedToPlaylist: wall.has(id) };
      if (cause === "complete") {
        ev("track_complete", tEnd, { song_id: id, position: qi + 1, completion_rate: 1, detected_by: "update" });
        listening.push({ ...row0, reason: "complete", t_s: tEnd });
        listening.push({ ...row0, reason: last ? "sequence_complete" : "track_switch", t_s: tEnd + 0.2 });   // B10 이중 저장 그대로
        if (last) ev("sequence_complete", tEnd + 0.3, { minutes });
      } else if (cause === "next") {
        ev("track_skip", tEnd, { song_id: id, position: qi + 1, direction: "next" });
        listening.push({ ...row0, reason: "track_switch", t_s: tEnd + 0.2 });
      }
      /* session_end(마지막 곡을 안 끝냄): fix-web 에는 기록이 남지 않는다(B11) */
    }
    if (wp && cause === "complete" && last) ev("sequence_complete", tEnd + 0.3, { minutes });

    // 실제 상태 이동
    if (s && completion >= K.state_min_completion) s = { v: s.v + K.state_step * (song.V - s.v), e: s.e + K.state_step * (song.A - s.e) };
    if (prevSong && T > K.U_jump_T) nTover++;
    if (rep) nRep++;
    played.push({ ...exp, early_skip: completion < 0.3 && cause === "next", exposed: listened_s >= K.exposure_min_s,
                  liked: didLike, liked_state: likedNow.has(id), disliked: !!reason, reason, u, T, x, rep, replay: replayDone });
    prevSong = song; prevExp = exp;
    t = tEnd + 1;
    if (last) break;
  }

  // 「듣고 난 뒤」 — 잠재값 Ũ 와 응답
  const lastPlayed = played.length ? byId.get(played[played.length - 1].song_id) : null;
  const dist = s && tgtTrue ? hyp(s, tgtTrue) : 0;
  const U = K.U_dist_w * dist / K.U_dist_scale + K.U_jump_w * nTover + K.U_pace_w * Math.abs(Number(persona.pi_star || 0) - piUsed) + K.U_rep_w * nRep;
  const ch = changeOf(U, `${rngKey}|change`, persona);
  const responded = u01(`${rngKey}|post`) < K.post_p;

  // 이유 코드: 조건을 넘은 코드마다 code_p 로 선택(출처 user) + 세션 ai_code_p 로 AI 가 무작위 코드 하나
  const cond = {};
  const posOf = (pred) => played.filter((p) => p.role === "path" && pred(p)).map((p) => p.position);
  const pj = posOf((p) => p.T > K.U_jump_T); if (pj.length) cond.path_jump = pj;
  if (first.song && ((persona.first_reject && first.close && first.skipped) || (s0 && hyp(rawOf(first.song), s0) > K.mood_mismatch_dist))) cond.mood_mismatch = [1];
  if (lastPlayed && tgtTrue && hyp(rawOf(lastPlayed), tgtTrue) > K.arrival_mismatch_dist) { const lp = played.filter((p) => p.role === "path").at(-1); cond.arrival_mismatch = lp ? [lp.position] : []; }
  if (persona.repeat) { const rp = posOf((p) => p.rep); if (rp.length) cond.too_repetitive = rp; }
  if (persona.spoken_bother_p) { const vb = posOf((p) => p.early_skip && byId.get(p.song_id)?.feature_bins?.spokenness === "high"); if (vb.length) cond.vocal_bother = vb; }
  { const nt = posOf((p) => p.u < K.dislike_taste_u); if (nt.length) cond.not_my_taste = nt; }
  const codes = {}, positions = new Set();
  let length_dir = null;
  if (responded) {
    if (persona.noise) {
      for (const c of REASON_CODES) if (u01(`${rngKey}|noisecode:${c}`) < 0.1) { codes[c] = "user"; if (nPath) positions.add(1 + Math.floor(u01(`${rngKey}|noisepos:${c}`) * nPath)); }
    } else {
      for (const [c, pos] of Object.entries(cond)) if (u01(`${rngKey}|code:${c}`) < K.code_p) { codes[c] = "user"; for (const x of pos) positions.add(x); }
    }
    if (persona.length && minutes > persona.length.over_min && u01(`${rngKey}|length`) < persona.length.p) { codes.length = "user"; length_dir = persona.length.dir; }
    if (!persona.noise && u01(`${rngKey}|aicode`) < K.ai_code_p) {
      const free = REASON_CODES.filter((c) => !(c in codes));
      if (free.length) codes[pick(`${rngKey}|aicode:which`, free)] = "ai";
    }
  }
  // 속도 답 (web-personal 「듣고 난 뒤」 늘 보이는 한 줄)
  let pace_answer = null;
  if (wp && u01(`${rngKey}|paceans`) < K.pace_answer_p) {
    if (persona.noise) pace_answer = pick(`${rngKey}|paceans:which`, ["faster", "ok", "slower"]);
    else if (persona.pace_answer_mode === "p0") pace_answer = u01(`${rngKey}|paceok`) < K.p0_ok_p ? "ok" : pick(`${rngKey}|paceans:which`, ["faster", "slower"]);
    else { const gap = Number(persona.pi_star || 0) - piUsed; pace_answer = Math.abs(gap) > K.pace_answer_tol ? (gap > 0 ? "faster" : "slower") : "ok"; }
  }
  const codeList = Object.keys(codes);
  const aiCodes = codeList.filter((c) => codes[c] === "ai");
  const posList = [...positions].sort((a, b) => a - b);
  const note_ai = codeList.length ? { echo: "(합성 사용자 소감)", codes: codeList, other: null, positions: posList, tone: "neutral", liked: null } : null;
  const tPost = t + K.post_delay_s;
  const heard = Object.fromEntries(played.filter((p) => p.listened_s >= K.heard_min_s).map((p) => [p.song_id, p.listened_s]));
  const listenedTotal = Math.round(played.reduce((a, p) => a + p.listened_s, 0));
  if (wp && (responded || pace_answer)) {
    ev("post_change", tPost, {
      change: responded ? ch.sample : 0, touched: responded, va_before: input.current_va || null, va_target: input.target_va || null,
      listened_seconds: listenedTotal, misfit_reasons: responded ? codeList : [], note: note_ai ? "(합성 사용자 소감)" : null,
      reasons_source: responded ? codes : {}, ai_codes_removed_by_user: [], note_ai: responded ? note_ai : null,
      pace_answer, length_dir, rec_id: recId, heard,
    });
  } else if (!wp && responded) {
    ev("post_change", tPost, {
      change: ch.sample, va_before: input.current_va || null, va_target: input.target_va || null, listened_seconds: listenedTotal,
      misfit_reasons: codeList, note: note_ai ? "(합성 사용자 소감)" : null, reasons_source: codes, ai_codes_removed_by_user: [], note_ai,
    });
  }
  events.sort((a, b) => a.t_s - b.t_s);
  const nudges = decideNudges(persona, input, { rngKey, mode: wp ? "drag" : "arrow" });
  return {
    events, nudges, listening,
    answers: { responded, touched: responded, change: responded ? ch.sample : null, E_change: ch.E, U, pace_answer, length_dir,
               codes, ai_codes: aiCodes, positions: posList },
    quit: { quit, after_position: quitAfter, reached_frac: nPath ? lastStartedPath / nPath : 0,
            ended_by: quit ? "quit" : played.length && played[played.length - 1].cause === "complete" ? "complete" : "session_end" },
    played,
    latent: { s0, s_n: s, target_true: tgtTrue, dist_end: dist, U, E_change: ch.E, n_T_over: nTover, n_rep: nRep, pi_used: piUsed, reported_now: reportedNow,
              end_t_s: tPost },
  };
}
