/*
 * web-personal 개인화 모듈 (personal.js) — 로그 → 개인 모델 → 정책 → 로그 문서 · 설명.
 *
 * 명세: docs/personalization_spec_20260927.md (동결). 아래 절 번호는 그 문서 기준.
 *   normalizeLogs        §3.1 노출 · §3.3 전환 라벨 · 옛 기록(track_complete/track_skip/track_milestone/track_autoplay_failed) 재구성
 *   buildPersonalModel   §4.1–4.10 학습기. §5 신용 할당 행렬에 없는 신호는 어떤 학습기도 움직이지 않는다
 *   resolvePolicy        §6.5 PersonalPolicy — 엔진은 받는 즉시 sanitizePersonal 로 한 번 더 자른다(이중 방어)
 *   safetyCheck          §2.2 7단계 · §11 B 봉투
 *   buildRecLog          §7.1 추천 문서 — 앱과 시뮬레이터가 같은 함수로 같은 모양을 만든다
 *   explainPolicy/Model  §4.12.3 설명 층 — 점수가 아니라 횟수("N번 중 M번")로 말한다
 *
 * 순수 ESM — DOM·Firebase 없음, engine.js 의 export 만 import 한다.
 * 비결정 난수·현재 시각 읽기 금지(I7) — 기준 시각 as_of_ms 는 인자로 받는다. 무작위는 새 가수 발견 칸(seededUniform) 한 곳뿐(§3.7).
 * 숫자는 전부 rules.personalization(§10) 에서 읽는다(I8). 이 파일의 상수는 단위 환산·열거값·부동소수 허용오차와,
 * 명세 본문에는 있으나 §10 에 키가 없는 값(SPEC_FALLBACK — 규칙에 키가 생기면 규칙 값이 이긴다)뿐이다.
 */
import {
  fnv1a32, seededUniform, aggregateAffinity, artistKeys, makeFeatureBinner, makeExtraBinner,
  workingCoords, songCount, transitionAt, adjFeatures, sanitizePersonal, median,
} from "./engine.js";

export const PERSONAL_VERSION = "p1.0.0";
export const SCHEMAS = { raw: "wp-raw/1", model: "wp-model/1", policy: "wp-policy/1", meta: "wp-meta/1" };

// ── 단위 · 열거값 · 허용오차 (규칙 값이 아님) ─────────────────
const DAY_MS = 86400000;
const EPS = 1e-9;                  // 부동소수 비교 허용오차 (iso_path_quality.mjs 와 같은 값)
const EXACT_EPS = 1e-6;            // 옛 기록의 칩 좌표 '정확히 같음' (§4.1.2)
const STRESS_MAX = 4;              // 스트레스 척도 0~4 — 앱 deriveStress 와 같은 척도
const NEUTRAL = 0.5;               // 감정 평면의 중립 좌표 — 앱 nlEmoPoint 의 0.5 와 같음
const FEATS = ["tempo", "vocal", "spoken", "genre", "va"];     // 전환 특징(§4.8.1). va 는 학습 전용(λ)
const ADJ_FEATS = ["tempo", "vocal", "spoken", "genre"];       // 전환 비용에 들어가는 특징
const CAUSES = ["complete", "next", "prev", "jump", "new_rec", "pagehide", "session_end", "autoplay_fail"];
const REASONS = ["path_jump", "not_my_taste", "mood_mismatch", "vocal_bother", "too_repetitive", "arrival_mismatch", "length"];
const PACE_ANSWERS = { faster: 1, ok: 0, slower: -1 };
const SOFT_GATES = { soft_spoken: "exclude_spoken" };          // personalization.gates 키 → rules.gates id

/* 명세 본문에 숫자가 있지만 §10 personalization 절에 키가 없는 값. 규칙 파일에 같은 경로의 키가 생기면 그 값을 쓴다(ruleOr).
   임의로 만든 값이 아니라 명세 문장을 그대로 옮긴 것이다. 통합 때(9/28) 여기 있는 키는 모두 규칙 v2.5.0-wp 에 들어갔다 —
   지금은 규칙 값이 이기고, 이 표는 옛 규칙 사본(키가 없는 파일)을 받았을 때의 안전망으로만 남는다. */
const SPEC_FALLBACK = {
  "outcome.legacy_skip_c": 0.1,             // §3.1 옛 track_skip 에 track_milestone 이 없으면 c = 0.1
  "outcome.ai_code_weight": 0.5,            // §3.3·§4.6·§4.9·§4.10 "AI 가 고르고 사용자가 지우지 않은 코드 가중 0.5"
  "outcome.mismatch_max_position": 2,       // §4.1.5·§4.4 "mood_mismatch(위치 ≤ 2)"
  "safety.envelope.turn_min": 0.02,         // §11 B3 방향 꺾임 판정 — iso_path_quality.mjs 의 TURN_MIN
  "safety.envelope.reversal_eps": 0.01,     // §10 safety.envelope — pathMetrics(result) 한 인자 호출(§9.2)용
  "pace.quit_guard.min_arrival_song": 2,    // §4.3.4 K = max(2, floor(f_med·n))
  "adjacency.bpm_offset": 50,               // §4.8.1 bpm = 50 + 150·tempo
  "adjacency.bpm_per_tag": 150,
  "bounds.taste_features_max": 3,           // §6.5 taste_features ≤ 3
};

const R3 = (x) => Math.round(x * 1e3) / 1e3;
const R6 = (x) => Math.round(x * 1e6) / 1e6;
const R9 = (x) => Math.round(x * 1e9) / 1e9;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (x) => typeof x === "number" && Number.isFinite(x);
const isStr = (x) => typeof x === "string" && x.length > 0;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const has = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const uniq = (xs) => [...new Set((xs || []).filter((x) => x !== null && x !== undefined && x !== ""))];
const firstNum = (...xs) => { for (const x of xs) if (num(x)) return x; return null; };
const validPt = (p) => (p && num(p.v) && num(p.e) ? { v: clamp(p.v, 0, 1), e: clamp(p.e, 0, 1) } : null);
const R3pt = (p) => (p ? { v: R3(p.v), e: R3(p.e) } : null);
const byPos = (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0);

function cfg(rules) {
  const p = rules && rules.personalization;
  if (!p || typeof p !== "object") throw new Error("personal.js: rules.personalization 절이 없습니다 (명세 §10)");
  return p;
}
function ruleOr(PR, path) {
  let v = PR;
  for (const k of path.split(".")) v = v == null ? undefined : v[k];
  return v ?? SPEC_FALLBACK[path];
}

// ── 정규 JSON · digest ─────────────────────────────────────
/* 키를 정렬한 JSON — 같은 내용이면 키 삽입 순서와 무관하게 같은 문자열. undefined·함수는 JSON 처럼 뺀다. */
function canon(x) {
  const out = [];
  const walk = (v) => {
    if (v === undefined || typeof v === "function") { out.push("null"); return; }
    if (v === null) { out.push("null"); return; }
    const t = typeof v;
    if (t === "number") { out.push(Number.isFinite(v) ? String(v) : "null"); return; }
    if (t === "boolean") { out.push(v ? "true" : "false"); return; }
    if (t !== "object") { out.push(JSON.stringify(v)); return; }
    if (Array.isArray(v)) {
      out.push("[");
      for (let i = 0; i < v.length; i++) { if (i) out.push(","); walk(v[i]); }
      out.push("]");
      return;
    }
    const keys = Object.keys(v).sort();
    let first = true;
    out.push("{");
    for (const k of keys) {
      const z = v[k];
      if (z === undefined || typeof z === "function") continue;
      if (!first) out.push(",");
      first = false;
      out.push(JSON.stringify(k), ":");
      walk(z);
    }
    out.push("}");
  };
  walk(x);
  return out.join("");
}
export function digest(obj) {
  return fnv1a32(canon(obj)).toString(16).padStart(8, "0");
}

// ── 카탈로그 색인 (§6.2) ────────────────────────────────────
/* 호출자가 만든 CatalogIndex 를 그대로 쓰되, 빠진 것(작업 좌표·특징 묶음)만 엔진 export 로 채운다.
   편의상 ContractSong 배열을 그대로 넘겨도 된다(도구·시험). 결과는 (입력 객체, 규칙)별로 한 번만 만든다. */
const IDX_CACHE = new WeakMap();   // ci → WeakMap(rules → 색인)
function catalogDigest(arr) {
  const lines = arr.map((s) => `${s.song_id}:${s.V}:${s.A}`).sort();
  return fnv1a32(lines.join("\n")).toString(16).padStart(8, "0");
}
function ensureIndex(ci, rules) {
  const cacheable = ci && typeof ci === "object" && rules && typeof rules === "object";
  const hit = cacheable && IDX_CACHE.get(ci);
  if (hit && hit.has(rules)) return hit.get(rules);
  const arr = Array.isArray(ci) ? ci
    : ci && ci.byId ? [...(ci.byId instanceof Map ? ci.byId.values() : Object.values(ci.byId))] : [];
  const extra = (cfg(rules).taste && cfg(rules).taste.extra_features) || [];
  const needBins = arr.some((s) => !s.feature_bins);
  const needP = extra.length > 0 && arr.some((s) => !s.feature_bins_p);
  let byId = ci && ci.byId instanceof Map ? ci.byId : null;
  if (!byId || needBins || needP) {
    const fb = needBins ? makeFeatureBinner(arr, rules) : null;   // 경계는 반드시 전체 카탈로그로(engine 주석)
    const xb = needP ? makeExtraBinner(arr, extra) : null;
    byId = new Map(arr.map((s) => [s.song_id, (fb && !s.feature_bins) || (xb && !s.feature_bins_p)
      ? { ...s, ...(fb && !s.feature_bins ? { feature_bins: fb(s) } : {}), ...(xb && !s.feature_bins_p ? { feature_bins_p: xb(s) } : {}) }
      : s]));
  }
  const coords = ci && ci.coords instanceof Map ? ci.coords : arr.length ? workingCoords(arr, rules) : new Map();
  const out = { n: num(ci && ci.n) ? ci.n : arr.length, digest: (ci && ci.digest) || (arr.length ? catalogDigest(arr) : null), byId, coords };
  if (cacheable) { if (!IDX_CACHE.has(ci)) IDX_CACHE.set(ci, new WeakMap()); IDX_CACHE.get(ci).set(rules, out); }
  return out;
}
function vaDist(ca, cb, rules) {
  const ax = (rules.ranking && rules.ranking.terms && rules.ranking.terms[0] && rules.ranking.terms[0].axes) || { V: 1, A: 1 };
  const dv = ca[0] - cb[0], da = ca[1] - cb[1];
  return Math.sqrt(ax.V * dv * dv + ax.A * da * da);
}

// ── 공통 정의 (§3) ─────────────────────────────────────────
/* §3.5 스트레스 — 앱 deriveStress(L838)와 같은 식. p 는 보정이 적용된 지금 좌표(원좌표). */
export function stressOf(point, rules) {
  const p = validPt(point);
  if (!p) return null;
  const SF = cfg(rules).safety;
  return Math.round(STRESS_MAX * clamp((1 - p.v) * SF.stress_w_v + p.e * SF.stress_w_a, 0, 1));
}

/* §3.1 노출·들음·조기 넘김·끝까지 */
function isExposed(e, PR) {
  return !!e && e.started === true && num(e.listened_s) && e.listened_s >= PR.outcome.exposure_min_s && e.cause !== "autoplay_fail";
}
function isEarlySkip(e, PR) {
  return isExposed(e, PR) && PR.listen_vote.skip_causes.includes(e.cause) && (Number(e.completion) || 0) < PR.outcome.skip_below;
}
function isKept(e, PR) {
  return isExposed(e, PR) && (Number(e.completion) || 0) >= PR.outcome.keep_from;
}
function isPreview(durationS, catalogS, O) {
  return num(durationS) && num(catalogS) && durationS <= O.preview_max_duration_s && catalogS >= O.preview_catalog_min_s;
}

/* §3.2 청취 표 (9/20 합의). 표가 없으면 null.
   φ = 미리듣기 preview_factor × 옛 기록 legacy_factor (둘 다면 곱). a = 전환 귀속분(§4.8.4, 콜드스타트 0). */
export function listenVote(exposure, rules, attribution = 0) {
  const PR = cfg(rules), O = PR.outcome, LV = PR.listen_vote;
  const e = exposure;
  if (!isExposed(e, PR)) return null;
  const phi = (e.preview ? O.preview_factor : 1) * (e.source === "legacy" ? O.legacy_factor : 1);
  const c = Number(e.completion) || 0;
  if (c >= O.keep_from) return { pos: R9(LV.unit * phi), neg: 0 };
  if (c < O.skip_below && LV.skip_causes.includes(e.cause)) {
    return { pos: 0, neg: R9(LV.unit * phi * (1 - clamp(Number(attribution) || 0, 0, 1))) };
  }
  return null;   // 0.30~0.70, 또는 c < 0.30 이지만 넘김이 아닌 종료(prev·pagehide·new_rec·session_end) — 표 없음
}

/* 세션 코드의 가중 — 사용자 1 · AI 가 고르고 사용자가 지우지 않은 것 0.5 · 지운 것 0 */
function codeWeight(post, code, PR) {
  if (!post || !has(post.reasons, code) || (post.ai_removed || []).includes(code)) return 0;
  return post.reasons[code] === "ai" ? ruleOr(PR, "outcome.ai_code_weight") : 1;
}

/* §3.3 전환 라벨 — { y, w(출처 가중) } | null */
function labelOf(a, b, s, PR) {
  const O = PR.outcome;
  if (!a || !b) return null;
  if (!((Number(a.completion) || 0) >= O.engaged_prev_min || a.cause === "complete")) return null;   // 앞 곡이 몰입 상태
  if (!b.started || b.cause === "autoplay_fail") return null;
  if (a.cause !== "complete" && a.cause !== "next") return null;   // 자동 넘김 또는 '다음'으로 도달(점프·이전 제외)
  const dis = (s.dislikes || []).find((d) => d.song_id === b.song_id);
  if (dis && (dis.reason == null || dis.reason === "not_my_taste")) return null;   // 취향으로 이미 설명됨
  let w1 = 0;
  if (isEarlySkip(b, PR)) w1 = 1;
  if (dis && dis.reason === "path_jump") w1 = 1;
  const cw = codeWeight(s.post, "path_jump", PR);   // 위치 없는 세션 path_jump 는 라벨을 만들지 않는다
  if (cw > 0 && b.role === "path" && (s.post.positions || []).includes(b.position)) w1 = Math.max(w1, cw);
  if (w1 > 0) return { y: 1, w: w1 };
  if (isKept(b, PR) || (s.likes_on || []).includes(b.song_id)) return { y: 0, w: 1 };
  return null;   // 30~70% 는 제외
}
export function transitionLabel(prevExp, exp, session, rules) {
  const r = labelOf(prevExp, exp, session || {}, cfg(rules));
  return r ? r.y : null;
}

/* 큰 변화 표시 L_f (§4.8.3) — 두 곡 중 하나라도 카탈로그에 없으면 null */
function largeFlags(aId, bId, S) {
  const a = S.idx.byId.get(aId), b = S.idx.byId.get(bId);
  if (!a || !b) return null;
  const A = S.PR.adjacency;
  const x = adjFeatures(a, b, { bpm_scale: A.bpm_scale, spoken_scale: A.spoken_scale, half_double_fold: A.half_double_fold,
                               bpm_offset: ruleOr(S.PR, "adjacency.bpm_offset"), bpm_per_tag: ruleOr(S.PR, "adjacency.bpm_per_tag") }) || {};
  const ca = S.idx.coords.get(aId), cb = S.idx.coords.get(bId);
  return {
    tempo: num(x.bpm_diff) && x.bpm_diff >= A.large.tempo_bpm ? 1 : 0,
    vocal: Number(x.vocal) >= 1 ? 1 : 0,
    spoken: num(a.spokenness) && num(b.spokenness) && Math.abs(a.spokenness - b.spokenness) >= A.large.spoken ? 1 : 0,
    genre: Number(x.genre) >= 1 ? 1 : 0,
    va: ca && cb && vaDist(ca, cb, S.rules) >= A.large.va ? 1 : 0,
  };
}

// ── 표 좌표 (§4.1.2) ──────────────────────────────────────
const normLabel = (s) => String(s || "").replace(/\s/g, "");
function labelShares(lab) {
  if (!lab || lab.mode === "tap") return [];
  if (lab.mode === "chip") return isStr(lab.chip) ? [{ label: lab.chip, share: 1 }] : [];
  if (lab.mode === "nl") {
    if (typeof lab.nl === "string") return lab.nl ? [{ label: lab.nl, share: 1 }] : [];
    const arr = (Array.isArray(lab.nl) ? lab.nl : []).filter((x) => x && isStr(x.label) && Number(x.intensity) > 0);
    const tot = arr.reduce((a, x) => a + Number(x.intensity), 0);
    if (!(tot > 0)) return [];
    const m = new Map();   // 같은 단어가 두 번 나오면 몫을 합친다
    for (const x of arr) m.set(x.label, (m.get(x.label) || 0) + Number(x.intensity) / tot);
    return [...m].map(([label, share]) => ({ label, share }));
  }
  return [];
}
/* 단어 → 표 좌표. 칩은 MOOD_CHIPS/GOAL_CHIPS, 자연어 지금 기분은 앱 nlCurrentPoint(강도 가중 평균, nlClamp)와 같은 식,
   자연어 목표는 단어 좌표 그대로(applyNLToState). rules(선택)를 주면 nlClamp 범위를 calib.clamp 에서 읽는다. */
export function tablePoint(field, labels, vocab, rules) {
  const lab = labels && labels.mode ? labels : labels && labels[field];
  if (!lab || !vocab) return null;
  const find = (list, l) => (list || []).find((x) => Array.isArray(x) && normLabel(x[0]) === normLabel(l));
  const cl0 = rules && rules.personalization && rules.personalization.calib ? rules.personalization.calib.clamp : vocab.nl_clamp;
  const cl = (x) => (Array.isArray(cl0) ? clamp(x, cl0[0], cl0[1]) : x);
  if (lab.mode === "chip") {
    const c = find(field === "current" ? vocab.mood_chips : vocab.goal_chips, lab.chip);
    return c ? { v: c[1], e: c[2] } : null;
  }
  if (lab.mode !== "nl") return null;
  if (field === "target") {
    const name = typeof lab.nl === "string" ? lab.nl : lab.nl && lab.nl.label;
    const c = find([...(vocab.goal_chips || []), ...(vocab.nl_extra_goal || [])], name);
    return c ? { v: c[1], e: c[2] } : null;
  }
  const arr = Array.isArray(lab.nl) ? lab.nl : [];
  if (!arr.length) return null;
  const list = [...(vocab.mood_chips || []), ...(vocab.nl_extra_emo || [])];
  let w = 0, v = 0, e = 0;
  for (const c of arr) {
    const L = find(list, c && c.label);
    const k = vocab.nl_k ? Number(vocab.nl_k[String(c && c.intensity)]) : NaN;
    if (!L || !num(k)) return null;
    const it = Number(c.intensity);
    v += cl(NEUTRAL + (L[1] - NEUTRAL) * k) * it;
    e += cl(NEUTRAL + (L[2] - NEUTRAL) * k) * it;
    w += it;
  }
  return w > 0 ? { v: v / w, e: e / w } : null;
}

// ── 로그 정규화 (§6.3) ────────────────────────────────────
function normProfile(p) {
  p = p || {};
  const wp = p.wp_personal_v1 && typeof p.wp_personal_v1 === "object" ? p.wp_personal_v1 : {};
  /* preferred_genres 는 읽지 않는다(B2·D3 — 세션 장르 선택이 저장돼 오염). taste_vector 도 읽지 않는다(B5 — 핀과 중복). */
  return {
    liked: uniq(p.likedSongs), disliked: uniq(p.dislikedSongs), playlists: uniq(p.playlists), favorite_tracks: uniq(p.favorite_tracks),
    wall_meta: p.wallMeta && typeof p.wallMeta === "object" ? p.wallMeta : {},
    pinned_artists: uniq(p.pinned_artists_resolved),
    recommend_minutes: num(p.recommend_minutes) && p.recommend_minutes > 0 ? p.recommend_minutes : null,
    wp: {
      opt_out: !!wp.opt_out, resets: obj(wp.resets), dislike_reasons: obj(wp.dislike_reasons), state_at: obj(wp.state_at),
      gate_off_until: obj(wp.gate_off_until), calib_prompt_seen: obj(wp.calib_prompt_seen),
    },
  };
}
function obj(x) { return x && typeof x === "object" && !Array.isArray(x) ? x : {}; }

/* 학습에 꼭 필요한 필드만 본다(모양 전체 검사는 validateEvent). 틀리면 그 이벤트만 버린다. */
function coreValid(type, p) {
  if (type === "track_exit") return isStr(p.song_id) && CAUSES.includes(p.cause) && num(p.listened_s) && p.listened_s >= 0;
  if (["track_complete", "track_skip", "track_milestone", "track_autoplay_failed", "like", "dislike", "dislike_reason"].includes(type)) return isStr(p.song_id);
  return true;
}

export function normalizeLogs(raw, catalogIndex, rules) {
  const PR = cfg(rules);
  const idx = ensureIndex(catalogIndex, rules);
  raw = raw || {};
  const prof = normProfile(raw.profile);
  const sl = raw.session_log || {};

  // 1) 추천 문서 — id 로 중복 제거(서버 사본 우선), 시각 오름차순
  const recMap = new Map();
  for (const r of [...(raw.recommendations || []), ...(sl.recommendations || [])]) {
    if (!r || typeof r !== "object") continue;
    const id = r.id ?? r.rec_id;
    const at = firstNum(r.created_at_ms, r.at_ms, r.created_at);
    if (id == null || id === "" || recMap.has(String(id)) || at === null) continue;
    recMap.set(String(id), { doc: r, id: String(id), at });
  }
  const recs = [...recMap.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 2) 이벤트 — client_id(없으면 문서 id)로 중복 제거, 시각 오름차순
  let nInvalid = 0;
  const evMap = new Map();
  for (const e of [...(raw.events || []), ...(sl.events || [])]) {
    if (!e || !isStr(e.type)) { nInvalid++; continue; }
    const at = firstNum(e.created_at_ms, e.at_ms, e.created_at);
    const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
    if (at === null || !coreValid(e.type, payload)) { nInvalid++; continue; }
    const key = isStr(payload.client_id) ? "c:" + payload.client_id : e.id ? "i:" + e.id : "h:" + canon([e.type, at, e.rec_id ?? null, payload]);
    if (evMap.has(key)) continue;
    evMap.set(key, { id: e.id ?? null, key, rec_id: e.rec_id ?? null, type: e.type, payload, at });
  }
  const events = [...evMap.values()].sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // 3) 이벤트 → 추천. rec_id 가 null 이면 그 이전 orphan_window_h 시간 안의 가장 최근 추천에 붙이고, 없으면 버린다(§3.1)
  const byRec = new Map(recs.map((r) => [r.id, []]));
  const G = { dislike_reason: {}, state_at: {}, resets: {}, gate_off_until: {} };
  const orphanMs = PR.load.orphan_window_h * 3600000;
  let nAtt = 0, nDrop = 0;
  for (const e of events) {
    let rid = null;
    if (e.rec_id != null && e.rec_id !== "") { if (byRec.has(String(e.rec_id))) rid = String(e.rec_id); }
    else {
      let lo = 0, hi = recs.length;   // at ≤ e.at 인 마지막 추천
      while (lo < hi) { const m = (lo + hi) >> 1; if (recs[m].at <= e.at) lo = m + 1; else hi = m; }
      const j = lo - 1;
      if (j >= 0 && e.at - recs[j].at <= orphanMs) { rid = recs[j].id; nAtt++; } else nDrop++;
    }
    if (rid !== null) byRec.get(rid).push(e);
    globalEvent(G, e, PR);   // 곡 상태·이유·초기화는 추천에 붙지 않아도 쓴다(400건 창 유실 대비, B16)
  }

  // 4) 세션
  const S = { PR, rules, idx, prof, vocab: raw.vocab || null, likedSet: new Set(prof.liked), dislikedSet: new Set(prof.disliked) };
  const sessions = recs.map((r, i) => buildSession(r, byRec.get(r.id), recs[i + 1] || null, S));
  const nWp = sessions.filter((s) => s.app === "web-personal").length;
  const L = PR.load;
  return {
    as_of_ms: firstNum(raw.as_of_ms),
    uid: raw.uid ?? null,
    sessions,
    source: {
      n_recs: recs.length, n_events: events.length, n_sessions: sessions.length, n_sessions_wp: nWp, n_sessions_legacy: sessions.length - nWp,
      n_orphans_attached: nAtt, n_orphans_dropped: nDrop, n_invalid_events: nInvalid,
      partial: (raw.recommendations || []).length >= L.recs || (raw.events || []).length >= L.event_pages * L.event_page_size,
    },
    cursor: { last_event_ms: events.length ? events[events.length - 1].at : null, last_rec_ms: recs.length ? recs[recs.length - 1].at : null },
    profile: prof,
    global: G,
  };
}

function globalEvent(G, e, PR) {
  const p = e.payload, sid = p.song_id;
  if (e.type === "dislike_reason" && isStr(sid) && isStr(p.reason)) {
    const c = G.dislike_reason[sid];
    if (!c || e.at >= c.at) G.dislike_reason[sid] = { reason: p.reason, at: e.at };
  } else if ((e.type === "like" || e.type === "dislike" || e.type === "playlist_add") && isStr(sid) && p.on !== false) {
    G.state_at[sid] = Math.max(G.state_at[sid] ?? -Infinity, e.at);
  } else if (e.type === "personal_reset" && isStr(p.procedure)) {
    G.resets[p.procedure] = Math.max(G.resets[p.procedure] ?? -Infinity, e.at);
  } else if (e.type === "auto_gate_off" && isStr(p.gate)) {
    G.gate_off_until[p.gate] = Math.max(G.gate_off_until[p.gate] ?? -Infinity, e.at + PR.gates.user_off_days * DAY_MS);
  }
}

/* 옛 기록의 단어: 칩·자연어 표 좌표와 최종 좌표가 '정확히 같을 때만' 받아들임 관측(o = 0). 다르면 버린다(심사 C-7). */
function legacyLabel(field, mode, nl, fin, vocab, rules) {
  if (!fin || !vocab) return null;
  if (mode === "chip") {
    const list = field === "current" ? vocab.mood_chips : vocab.goal_chips;
    const c = (list || []).find((x) => Math.abs(x[1] - fin.v) < EXACT_EPS && Math.abs(x[2] - fin.e) < EXACT_EPS);
    return c ? { mode: "chip", chip: c[0] } : null;
  }
  if (mode === "nl" && nl && nl.final) {
    const val = field === "current" ? nl.final.current : nl.final.target;
    if (!val || (Array.isArray(val) && !val.length)) return null;
    const lab = { mode: "nl", nl: val };
    const t = tablePoint(field, lab, vocab, rules);
    return t && Math.abs(R3(t.v) - fin.v) < EXACT_EPS && Math.abs(R3(t.e) - fin.e) < EXACT_EPS ? lab : null;
  }
  return null;
}

function normInput(inp, S, app) {
  const { PR, rules, vocab } = S;
  const now = validPt(inp.current_va), target = validPt(inp.target_va);
  const labels = { current: null, target: null };
  let nowT = null, tgtT = null, nudged = { current: false, target: false };
  if (app === "web-personal" && inp.labels && typeof inp.labels === "object") {
    labels.current = inp.labels.current ?? null; labels.target = inp.labels.target ?? null;
    const tp = inp.table_point || {};   // 표 좌표가 빠진 기록은 단어 표에서 다시 계산한다
    nowT = validPt(tp.current) ?? validPt(tablePoint("current", labels.current, vocab, rules));
    tgtT = validPt(tp.target) ?? validPt(tablePoint("target", labels.target, vocab, rules));
    nudged = { current: !!(inp.nudged && inp.nudged.current), target: !!(inp.nudged && inp.nudged.target) };
  } else {
    const mode = inp.input_mode || {};
    for (const field of ["current", "target"]) {
      const fin = field === "current" ? now : target;
      const lab = legacyLabel(field, mode[field], inp.nl_v2, fin, vocab, rules);
      if (lab) { labels[field] = lab; if (field === "current") nowT = fin; else tgtT = fin; }   // 표 = 최종 → o = 0
      else if (mode[field] === "tap") labels[field] = { mode: "tap" };
    }
  }
  const eff = inp.effective && typeof inp.effective === "object" ? inp.effective : {};
  const cons = inp.nl_v2 && inp.nl_v2.final && inp.nl_v2.final.constraints;
  const pu = has(inp, "pace_user") ? inp.pace_user : inp.pace_mode;
  const stress = num(inp.stress) ? inp.stress : now ? stressOf(now, rules) : null;
  return {
    now, target, now_table: nowT, target_table: tgtT, labels, nudged,
    minutes: firstNum(eff.minutes, inp.recommend_minutes),
    minutes_base: firstNum(inp.minutes_base),
    nl_minutes: !!(cons && num(cons.minutes)),
    lyric: eff.lyric ?? inp.lyric_preference ?? null,
    genres: Array.isArray(eff.genres) ? eff.genres : Array.isArray(inp.genres) ? inp.genres : [],
    pace_user: pu === "fast" || pu === "slow" ? pu : null,
    stress,
    high_stress: typeof inp.high_stress === "boolean" ? inp.high_stress : stress !== null && stress >= PR.safety.high_stress_min,
  };
}

/* 경로 행의 구간(이동/머묾). 새 기록은 phase 필드, 없으면 경유지 좌표가 마지막 경유지(목표)와 같은지,
   그것도 없으면(옛 기록) 엔진 waypoints 와 같은 식으로 도착 걸음을 다시 계산한다. */
function arrivalMask(n, at) {
  const out = [];
  for (let k = 0; k < n; k++) out.push((n === 1 ? 1 : at > 0 ? (k / (n - 1)) / at : 1) >= 1);
  return out;
}
function arrivalIndex(n, at) {
  const m = arrivalMask(n, at);
  const i = m.indexOf(true);
  return i >= 0 ? i + 1 : n;
}
function pathPhases(rows, input, S) {
  const n = rows.length;
  if (!n) return [];
  if (rows.every((r) => r.phase === "move" || r.phase === "hold")) return rows.map((r) => r.phase);
  if (rows.every((r) => num(r.wp_V) && num(r.wp_A))) {
    const t = rows[n - 1];
    return rows.map((r) => (Math.abs(r.wp_V - t.wp_V) < EPS && Math.abs(r.wp_A - t.wp_A) < EPS ? "hold" : "move"));
  }
  const pu = input.pace_user;
  const minutes = input.minutes ?? S.rules.inputs.duration_min.default;
  const at = pu ? S.PR.pace.manual_tp[pu] : transitionAt(S.rules, minutes);
  return arrivalMask(n, at).map((a) => (a ? "hold" : "move"));
}

function normPost(p) {
  const src = obj(p.reasons_source);
  const reasons = {};
  for (const c of Array.isArray(p.misfit_reasons) ? p.misfit_reasons : []) if (isStr(c)) reasons[c] = src[c] === "ai" ? "ai" : "user";
  const na = p.note_ai && typeof p.note_ai === "object" ? p.note_ai : null;
  return {
    change: num(p.change) ? p.change : null,
    touched: typeof p.touched === "boolean" ? p.touched : null,
    reasons,
    ai_removed: Array.isArray(p.ai_codes_removed_by_user) ? p.ai_codes_removed_by_user.filter(isStr) : [],
    positions: na && Array.isArray(na.positions) ? na.positions.map(Number).filter(Number.isInteger) : [],
    pace_answer: has(PACE_ANSWERS, p.pace_answer) ? p.pace_answer : null,
    length_dir: p.length_dir === "long" || p.length_dir === "short" ? p.length_dir : null,
    end_va: validPt(p.end_va),
  };
}

function fromExit(e, rowOf, S) {
  const p = e.payload, O = S.PR.outcome;
  const song = S.idx.byId.get(p.song_id);
  const row = rowOf.get(p.song_id);
  const catalogS = num(p.catalog_s) ? p.catalog_s : song && num(song.duration_ms) ? song.duration_ms / 1000 : null;
  const durationS = num(p.duration_s) && p.duration_s > 0 ? p.duration_s : null;
  /* listened_s 는 §3.1 정의대로 '실제 재생 + 백그라운드 보정(bg_credit_s)'이 이미 들어간 값으로 읽는다(payload 의 bg_credit_s 는 진단용). */
  const listened = Math.max(0, p.listened_s);
  const len = durationS ?? catalogS;
  return {
    song_id: p.song_id,
    position: num(p.position) ? p.position : row ? row.position : null,
    role: p.role === "extra" || p.role === "path" ? p.role : row ? row.role : "path",
    instance: num(p.instance) ? p.instance : 1,
    started: p.cause === "autoplay_fail" ? false : p.started === true,
    listened_s: listened, duration_s: durationS, catalog_s: catalogS,
    completion: num(p.completion) ? clamp(p.completion, 0, 1) : len ? Math.min(1, listened / len) : 0,
    preview: typeof p.preview === "boolean" ? p.preview : isPreview(durationS, catalogS, O),
    cause: p.cause,
    prev_song_id: isStr(p.prev_song_id) ? p.prev_song_id : null,
    prev_completion: num(p.prev_completion) ? p.prev_completion : null,
    at_ms: e.at, source: "track_exit",
  };
}

/* 옛 기록(§3.1): track_complete{completion_rate} → c · track_skip{direction} → cause, c 는 그 곡의 track_milestone 최댓값/100
   (없으면 0.1) · track_autoplay_failed → autoplay_fail. 곡·추천 연결은 (rec_id, song_id) 로만 — 옛 position 은 재생 큐 위치라 쓰지 않는다(B14). */
function legacyExposures(evs, rowOf, S) {
  const O = S.PR.outcome;
  const ms = new Map(), dur = new Map();
  for (const e of evs) if (e.type === "track_milestone" && isStr(e.payload.song_id)) {
    const sid = e.payload.song_id;
    if (num(e.payload.milestone)) ms.set(sid, Math.max(ms.get(sid) || 0, e.payload.milestone));
    if (num(e.payload.duration_ms) && e.payload.duration_ms > 0) dur.set(sid, e.payload.duration_ms / 1000);
  }
  const noMilestoneC = ruleOr(S.PR, "outcome.legacy_skip_c");
  const out = [], inst = new Map();
  for (const e of evs) {
    const p = e.payload, sid = p.song_id;
    let cause, c;
    if (e.type === "track_complete") { cause = "complete"; c = num(p.completion_rate) ? clamp(p.completion_rate, 0, 1) : 1; }
    else if (e.type === "track_skip") {
      cause = ["next", "prev", "jump"].includes(p.direction) ? p.direction : "unknown";
      c = num(p.completion) ? clamp(p.completion, 0, 1) : ms.has(sid) ? clamp(ms.get(sid) / 100, 0, 1) : noMilestoneC;
    } else if (e.type === "track_autoplay_failed") { cause = "autoplay_fail"; c = 0; }
    else continue;
    const row = rowOf.get(sid);
    if (!row) continue;   // 그 추천의 시퀀스에 없는 곡은 버린다
    const song = S.idx.byId.get(sid);
    const catalogS = song && num(song.duration_ms) ? song.duration_ms / 1000 : null;
    const durationS = dur.has(sid) ? dur.get(sid) : null;
    const base = durationS ?? catalogS ?? S.PR.extras.default_duration_s;
    const k = (inst.get(sid) || 0) + 1; inst.set(sid, k);
    out.push({
      song_id: sid, position: row.position, role: row.role, instance: k,
      started: cause !== "autoplay_fail", listened_s: cause === "autoplay_fail" ? 0 : R3(c * base),
      duration_s: durationS, catalog_s: catalogS, completion: R6(c), preview: isPreview(durationS, catalogS, O),
      cause, prev_song_id: null, prev_completion: null, at_ms: e.at, source: "legacy",
    });
  }
  return out;
}

function buildSession(r, evs, next, S) {
  const { PR } = S;
  const doc = r.doc, inp = doc.input && typeof doc.input === "object" ? doc.input : {};
  const app = inp.app === "web-personal" ? "web-personal" : "fix-web";
  const input = normInput(inp, S, app);
  const rows = Array.isArray(doc.sequence) ? doc.sequence.filter((x) => x && isStr(x.song_id)) : [];
  const pr = rows.filter((x) => (x.role || "path") === "path").sort(byPos);
  const er = rows.filter((x) => x.role === "extra").sort(byPos);
  const n = pr.length;
  const phases = pathPhases(pr, input, S);
  const path = pr.map((x, i) => ({ song_id: x.song_id, position: num(x.position) ? x.position : i + 1, phase: phases[i],
                                   pmarg: num(x.p_pmarg) ? x.p_pmarg : null, discovery: x.discovery === true, replay: x.replay === true }));
  const extras = er.map((x, i) => ({ song_id: x.song_id, position: num(x.position) ? x.position : n + i + 1, pmarg: num(x.p_pmarg) ? x.p_pmarg : null,
                                     replay: x.replay === true }));
  const rowOf = new Map();
  for (const x of path) if (!rowOf.has(x.song_id)) rowOf.set(x.song_id, { ...x, role: "path" });
  for (const x of extras) if (!rowOf.has(x.song_id)) rowOf.set(x.song_id, { ...x, role: "extra", phase: "extra" });
  const hi = path.findIndex((x) => x.phase === "hold");

  // 좋아요(켬)·싫어요(이유)·「듣고 난 뒤」 — 켬/끔 방향이 없는 옛 이벤트는 지금 프로필 상태로 읽는다(B13)
  const likes = new Map(), dis = new Map();
  let post = null;
  for (const e of evs) {
    const p = e.payload, sid = p.song_id;
    if (e.type === "like" && isStr(sid)) likes.set(sid, typeof p.on === "boolean" ? p.on : S.likedSet.has(sid));
    else if (e.type === "dislike" && isStr(sid)) {
      const on = typeof p.on === "boolean" ? p.on : S.dislikedSet.has(sid);
      const d = dis.get(sid);
      if (on) { if (!d) dis.set(sid, { reason: null, position: firstNum(p.position), phase: null, fromReason: false }); }
      else if (d && !d.fromReason) dis.delete(sid);
    } else if (e.type === "dislike_reason" && isStr(sid) && isStr(p.reason)) {
      dis.set(sid, { reason: p.reason, position: firstNum(p.position), phase: isStr(p.phase) ? p.phase : null, fromReason: true });
    } else if (e.type === "post_change") post = normPost(p);
  }
  const likes_on = [...likes].filter(([, on]) => on).map(([id]) => id);
  const dislikes = [...dis].map(([song_id, d]) => {
    const row = rowOf.get(song_id);
    return { song_id, reason: d.reason, position: d.position ?? (row ? row.position : null), phase: d.phase ?? (row ? row.phase : null) };
  });

  // 노출 — web-personal 추천은 track_exit 만(같은 곡의 track_skip/complete 도 운영 앱용으로 쓰이므로 이중 계산 방지)
  const exits = evs.filter((e) => e.type === "track_exit");
  const exposures = exits.length ? exits.map((e) => fromExit(e, rowOf, S)) : legacyExposures(evs, rowOf, S);
  exposures.sort((a, b) => a.at_ms - b.at_ms || a.instance - b.instance || (Number(a.position) || 0) - (Number(b.position) || 0));
  for (let i = 0; i < exposures.length; i++) {   // 재생 순서의 앞 곡 (§3.3 — track_exit.prev_song_id 로 잇는다)
    const x = exposures[i];
    if (x.source === "legacy") {
      x.prev_index = i > 0 ? i - 1 : null;
      if (i > 0) { x.prev_song_id = exposures[i - 1].song_id; x.prev_completion = exposures[i - 1].completion; }
    } else {
      let j = i - 1;
      while (j >= 0 && exposures[j].song_id !== x.prev_song_id) j--;
      x.prev_index = x.prev_song_id && j >= 0 ? j : null;
    }
  }

  const s = {
    rec_id: r.id, at_ms: r.at, app, seed: inp.seed ?? null, input,
    used: app === "web-personal" && inp.personal_meta && inp.personal_meta.params ? inp.personal_meta.params : null,
    policy: inp.personal_policy || null,
    n_path: n, arrival_index: hi >= 0 ? path[hi].position : null, path, extras, exposures, transitions: [],
    likes_on, dislikes, post,
    reached_frac: null, rerequested_within_10min: false, ended_by: "unknown",
  };

  // 전환 (§3.3·§4.8.3). w 는 출처 가중 × 옛 기록 배수까지 — 시간 감쇠는 모델이 as_of_ms 로 곱한다
  const A = PR.adjacency;
  for (const b of exposures) {
    if (b.prev_index == null) continue;
    const a = exposures[b.prev_index];
    const lab = labelOf(a, b, s, PR);
    if (!lab) continue;
    const L = largeFlags(a.song_id, b.song_id, S);
    if (!L) continue;
    const row = rowOf.get(b.song_id);
    const pm = row && num(row.pmarg) ? row.pmarg : 0;   // 여백을 모르는 옛 기록은 0 (§3.4)
    s.transitions.push({ prev: a.song_id, cur: b.song_id, position: b.position, label: lab.y,
                         w: R9(lab.w * (b.source === "legacy" ? PR.outcome.legacy_factor : 1)), L,
                         q: R9(sigmoid(A.theta0 + A.theta_margin * pm)), at_ms: b.at_ms, source: b.source });
  }

  // 도달 비율 f(§4.3.4) — 재생이 시작된 마지막 경로 위치 / n. 넘김은 f 를 늘릴 뿐 줄이지 않는다
  const startedPath = exposures.filter((x) => x.role === "path" && x.started && num(x.position));
  s.reached_frac = n > 0 && startedPath.length ? R6(Math.min(1, Math.max(...startedPath.map((x) => x.position)) / n)) : null;
  s.rerequested_within_10min = !!next && next.at - r.at <= PR.load.rerequest_window_s * 1000;
  const lastExp = exposures[exposures.length - 1];
  if (exposures.some((x) => x.role === "path" && x.position === n && (x.cause === "complete" || isKept(x, PR)))) s.ended_by = "complete";
  else if (s.rerequested_within_10min || (lastExp && lastExp.cause === "new_rec")) s.ended_by = "new_rec";
  else if (startedPath.length) s.ended_by = "quit";
  return s;
}

// ── 개인 모델 (§6.4) ───────────────────────────────────────
function mergeMax(...maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(obj(m))) { const x = firstNum(v); if (x !== null) out[k] = Math.max(out[k] ?? -Infinity, x); }
  return out;
}
function likeBase(aff) {
  const b = (aff && aff.like_base) || {};
  const n = (b.pos || 0) + (b.neg || 0);
  return n > 0 ? ((b.pos || 0) + 1) / (n + 2) : null;   // 엔진 likeBaseRate 와 같은 식
}
function hasPins(aff) {
  return Object.values((aff && aff.artist_affinity) || {}).some((r) => r.pin > 0) || Object.values((aff && aff.song_likes) || {}).some((r) => r.pin > 0);
}
/* 엔진 shrunk(…, decay, p0, pin) 과 같은 식 — 설명과 게이트 (b) 에만 쓴다 */
function shrunkScore(rec, p0, rules) {
  const pk = rules.preference.shrinkage.personal_k, hl = rules.preference.decay.half_life_days;
  const decay = hl ? Math.pow(0.5, Number(rec.last_days || 0) / hl) : 1;
  const n = ((rec.pos || 0) + (rec.neg || 0)) * decay + (rec.pin || 0);
  if (n <= 0) return p0;
  return ((rec.pos || 0) * decay + (rec.pin || 0) + p0 * pk) / (n + pk);
}

export function buildPersonalModel(norm, catalogIndex, rules, opts = {}) {
  const PR = cfg(rules);
  const asOf = firstNum(opts && opts.as_of_ms, norm && norm.as_of_ms);
  if (asOf === null) throw new Error("buildPersonalModel: as_of_ms 가 필요합니다 (I7 — 기준 시각은 인자로 받는다)");
  const idx = ensureIndex(catalogIndex, rules);
  const prof = (norm && norm.profile) || normProfile(null);
  const G = (norm && norm.global) || {};
  const sessions = (norm && Array.isArray(norm.sessions) ? norm.sessions : []);
  const resets = mergeMax(prof.wp.resets, G.resets);
  /* 초기화(resets[procedure]) 이전의 근거는 그 학습기에서 모두 무시한다(§3.6). "all" 은 모든 학습기. */
  const resetAt = (...procs) => Math.max(-Infinity, resets.all ?? -Infinity, ...procs.map((p) => resets[p] ?? -Infinity));
  const X = { PR, rules, idx, prof, G, asOf, resetAt, sessions, days: (ms) => (num(ms) ? Math.max(0, (asOf - ms) / DAY_MS) : 0) };

  const adjacency = buildAdjacency(X);
  const taste = buildTaste(X, adjacency);
  const calibCur = buildCalib("current", X), calibTgt = buildCalib("target", X);
  const prompts = buildPrompts(X);
  const pace = buildPace(X);
  const start = buildStart(X, adjacency);
  const length = buildLength(X);
  const hold = buildHold(X);
  const gates = buildGates(X, taste);
  const diversity = buildDiversity(X);
  const LB = PR.decay.lookback_sessions;
  const history = sessions.filter((s) => s.app === "web-personal" && s.used).slice(-LB)
    .map((s) => ({ rec_id: s.rec_id, at_ms: s.at_ms, params: s.used }));
  let nExp = 0;
  for (const s of sessions) for (const e of s.exposures) if (isExposed(e, PR)) nExp++;

  const src = (norm && norm.source) || { n_recs: 0, n_events: 0, n_sessions: 0, n_sessions_wp: 0, n_sessions_legacy: 0, n_orphans_attached: 0, n_orphans_dropped: 0, n_invalid_events: 0, partial: false };
  const model = {
    schema: SCHEMAS.model, personal_version: PERSONAL_VERSION, as_of_ms: asOf, digest: null,
    source: { ...src, n_sessions: sessions.length, cursor: (norm && norm.cursor) || { last_event_ms: null, last_rec_ms: null } },
    evidence: { E: taste.E, n_exposures: nExp, n_transitions: adjacency.n_trans, n_pace_votes: pace.votes, n_length_votes: length.votes,
                n_calib_edits: { current: calibCur.n_edit, target: calibTgt.n_edit } },
    taste: { items: taste.items, affinity: taste.affinity, E: taste.E, mu: taste.mu, discovery: taste.discovery, disliked_ids: taste.disliked_ids },
    calib: { current: calibCur, target: calibTgt, prompts: { current: prompts.current, target: prompts.target } },
    pace: { pi: pace.pi, W: pace.W, votes: pace.votes, quit: pace.quit },
    start: { arm: start.arm, ratio: start.ratio, n1: start.n1, mismatch_up: start.mismatch_up, mismatch_down: start.mismatch_down, since_rec_id: start.since_rec_id },
    length: { bias_log2: length.bias_log2, W: length.W, base_minutes: length.base_minutes, S: length.S, applied: length.applied },
    hold: { arm: hold.arm, arrival_w: hold.arrival_w, repetitive_w: hold.repetitive_w, arrival_n: hold.arrival_n, repetitive_n: hold.repetitive_n, since_rec_id: hold.since_rec_id },
    adjacency: { m: adjacency.m, m0: adjacency.m0, applied: adjacency.applied, m_applied: adjacency.m_applied, O: adjacency.O, Etilde: adjacency.Etilde,
                 n_large: adjacency.n_large, n_trans: adjacency.n_trans, lambda: adjacency.lambda },
    gates: { soft: gates.soft, evidence: gates.evidence, off_until: gates.off_until },
    diversity,
    resets,
    history,
    counts_for_explain: {
      taste: taste.counts, pace: pace.counts, length: length.counts, adjacency: adjacency.counts, path_jump: adjacency.path_jump,
      start: { first_n: start.n1, first_rej: start.O1 },
      hold: { arrival_w: hold.arrival_w, repetitive_w: hold.repetitive_w, arrival_n: hold.arrival_n, repetitive_n: hold.repetitive_n },
      gates: { vocal_bother_w: gates.evidence.vocal_bother_w, vocal_bother_n: gates.evidence.vocal_bother_n },
      diversity: { too_repetitive_w: diversity.repetitive_sessions_w, too_repetitive_n: diversity.repetitive_sessions_n },
      calib: { mismatch: prompts.counts },
    },
  };
  model.digest = digest({ ...model, digest: undefined });
  return model;
}

export function emptyModel(rules) {
  const m = buildPersonalModel({ sessions: [], profile: normProfile(null), global: {} }, [], rules, { as_of_ms: 0 });
  m.as_of_ms = null;
  m.digest = digest({ ...m, digest: undefined });
  return m;
}

/* §4.8.3 전환 배수 — 취향 기대 거절률 q 를 오프셋으로 둔 결합 곱셈 모형, 사전 Gamma(κ, κ), 순환 갱신 */
function fitMultipliers(T, A) {
  const k = A.kappa, lo = Math.log(A.mult_range[0]), hi = Math.log(A.mult_range[1]);
  const nF = FEATS.length, n = T.length;
  /* 전환마다 큰 변화 특징 번호만 들고, 특징별로 해당 전환 목록을 미리 모은다(20회 × 5특징 반복의 속도용 — 더하는 순서는 그대로) */
  const fl = T.map((t) => FEATS.map((f, i) => (t.L[f] ? i : -1)).filter((i) => i >= 0));
  const byF = FEATS.map(() => []);
  for (let j = 0; j < n; j++) for (const i of fl[j]) byF[i].push(j);
  const m = new Array(nF).fill(1);
  let m0 = 1;
  const prod = (j, skip) => { let p = 1; for (const i of fl[j]) if (i !== skip) p *= m[i]; return p; };
  let sy = 0;
  for (const t of T) sy += t.w * t.y;
  const oF = byF.map((js) => { let o = 0; for (const j of js) o += T[j].w * T[j].y; return o; });
  for (let it = 0; it < A.iterations; it++) {
    let e = 0;
    for (let j = 0; j < n; j++) e += T[j].w * T[j].q * prod(j, -1);
    m0 = (sy + k) / (e + k);
    for (let i = 0; i < nF; i++) {
      let ef = 0;
      for (const j of byF[i]) ef += T[j].w * T[j].q * m0 * prod(j, i);
      m[i] = Math.exp(clamp(Math.log((oF[i] + k) / (ef + k)), lo, hi));
    }
  }
  const out = { m: {}, m0, O: {}, Et: {}, nL: {} };
  FEATS.forEach((f, i) => {
    let et = 0;
    for (const j of byF[i]) et += T[j].w * T[j].q * m0 * prod(j, i);
    out.m[f] = m[i]; out.O[f] = oF[i]; out.Et[f] = et; out.nL[f] = byF[i].length;
  });
  return out;
}

function buildAdjacency(X) {
  const { PR, rules, sessions, resetAt, days } = X;
  const A = PR.adjacency;
  const r0 = resetAt("adjacency");
  const T = [];
  const counts = Object.fromEntries(FEATS.map((f) => [f, { large_n: 0, large_y: 0, small_n: 0, small_y: 0 }]));
  for (const s of sessions) for (const t of s.transitions || []) {
    if (!(t.at_ms >= r0)) continue;
    T.push({ y: t.label, q: t.q, L: t.L, w: t.w * Math.pow(0.5, days(t.at_ms) / PR.decay.transition_half_life_days) });
    for (const f of FEATS) { const c = counts[f]; if (t.L[f]) { c.large_n++; c.large_y += t.label; } else { c.small_n++; c.small_y += t.label; } }
  }
  /* 위치 없는 세션 path_jump 는 어느 전환인지 몰라 라벨을 만들지 않는다 — 패널 횟수로만 센다(§5) */
  const pj = { located: 0, unlocated: 0 };
  for (const s of sessions) if (s.at_ms >= r0 && codeWeight(s.post, "path_jump", PR) > 0) pj[s.post.positions.length ? "located" : "unlocated"]++;
  const fit = fitMultipliers(T, A);
  const applied = {}, m = {}, mApp = {}, O = {}, Et = {};
  for (const f of FEATS) {
    /* 적용 문턱(심사 A-3): 80% 구간이 1 을 벗어남 ∧ 큰 변화 쌍 수 ∧ 전환 총수 */
    applied[f] = Math.abs(Math.log(fit.m[f])) >= A.z_apply / Math.sqrt(fit.O[f] + A.kappa)
      && fit.nL[f] >= A.min_large && T.length >= A.min_transitions;
    m[f] = R6(fit.m[f]); mApp[f] = applied[f] ? m[f] : 1; O[f] = R6(fit.O[f]); Et[f] = R6(fit.Et[f]);
  }
  const jw = Number(rules.path.jump_weight || 0);
  return {
    m, m0: R6(fit.m0), applied, m_applied: mApp, O, Etilde: Et, n_large: fit.nL, n_trans: T.length,
    lambda: R9(clamp(jw * mApp.va, A.lambda_range[0], A.lambda_range[1])), counts, path_jump: pj,
  };
}

/* §4.8.4 전환 귀속분 a_e = clamp(1 − 1/Π m_f^{L_ef}, 0, attrib_max) — 적용된 배수만. 앞 곡이 없으면 0. */
function attributionOf(s, e, adj, X) {
  if (e.prev_index == null) return 0;
  const a = s.exposures[e.prev_index];
  const L = a ? largeFlags(a.song_id, e.song_id, X) : null;
  if (!L) return 0;
  let p = 1;
  for (const f of FEATS) if (L[f]) p *= adj.m_applied[f];
  return clamp(1 - 1 / p, 0, X.PR.adjacency.attrib_max);
}

/* §4.7.1 취향 항목 · §4.7.3 μ · §4.7.4 발견 칸 상태 */
function buildTaste(X, adj) {
  const { PR, rules, idx, prof, G, sessions, resetAt, days } = X;
  const T = PR.taste, LV = PR.listen_vote;
  const rT = resetAt("taste");
  const liked = new Set(prof.liked), disliked = new Set(prof.disliked);
  const walls = new Set([...prof.playlists, ...prof.favorite_tracks]);   // 벽·선호곡 (2.5.1 코드 기준 playlist 곡도 핀)
  const explicit = (id) => liked.has(id) || disliked.has(id) || walls.has(id);

  // 1) 청취 표 — 시간순으로 더하다가 곡당 상한(per_song_cap)에 닿으면 멈춘다. 명시 상태가 있는 곡은 쓰지 않는다
  const votes = new Map();
  for (const s of sessions) for (const e of s.exposures) {
    if (!(e.at_ms >= rT) || explicit(e.song_id)) continue;
    const v = listenVote(e, rules, attributionOf(s, e, adj, X));
    if (!v || v.pos + v.neg <= 0) continue;
    let r = votes.get(e.song_id);
    if (!r) votes.set(e.song_id, (r = { pos: 0, neg: 0, last: null, kept: 0, skips: 0 }));
    const room = LV.per_song_cap - (r.pos + r.neg);
    if (room <= EPS) continue;
    const f = v.pos + v.neg > room ? room / (v.pos + v.neg) : 1;
    r.pos = R9(r.pos + v.pos * f); r.neg = R9(r.neg + v.neg * f);
    r.last = Math.max(r.last ?? -Infinity, e.at_ms);
    if (v.pos > 0) r.kept++; else r.skips++;
  }

  // 2) 항목 — 명시 상태(싫어요·좋아요·벽)가 먼저, 그 밖의 곡은 청취 표
  const wallMs = (id) => { const w = prof.wall_meta[id]; const t = w && typeof w.at === "string" ? Date.parse(w.at) : NaN; return num(t) ? t : null; };
  const stateMs = (id) => firstNum(prof.wp.state_at[id], G.state_at && G.state_at[id], wallMs(id));
  const reasonOf = (id) => {   // wp_personal_v1.dislike_reasons ∪ 최신 dislike_reason 이벤트 중 늦은 것 (B16)
    const a = prof.wp.dislike_reasons[id], b = G.dislike_reason && G.dislike_reason[id];
    const am = a ? firstNum(a.at_ms) : null;
    if (a && b) return b.at >= (am ?? -Infinity) ? b.reason : a.reason ?? null;
    return (b && b.reason) || (a && a.reason) || null;
  };
  const scopeMap = { ...((rules.preference && rules.preference.dislike_scope) || {}), ...(T.dislike_scope_add || {}) };
  const isTasteDislike = (reason) => {
    const sc = scopeMap[isStr(reason) && has(scopeMap, reason) ? reason : "_no_reason"] || [];
    return sc.includes("artist") && sc.includes("features");
  };
  const extraIds = (T.extra_features || []).map((f) => f.id);
  const ids = [...new Set([...liked, ...disliked, ...walls, ...votes.keys()])].sort();
  const items = [];
  const c = { likes: 0, dislikes_taste: 0, dislikes_other: 0, pins_song: 0, pins_artist: 0, completes: 0, skips: 0, vote_sum: 0 };
  const groupSrc = new Map();   // song_id → { likes, completes, skips, pins, dislikes } (설명용 횟수)
  for (const id of ids) {
    const song = idx.byId.get(id);
    if (!song) continue;
    const base = { song_id: id, artist: song.artist ?? null, genres: Array.isArray(song.genres) ? song.genres : [], feature_bins: song.feature_bins || {} };
    if (extraIds.length && song.feature_bins_p) base.feature_bins_p = song.feature_bins_p;
    if (explicit(id)) {
      const t = stateMs(id);
      if (rT > -Infinity && !(t >= rT)) continue;   // 초기화 이전(또는 시각을 모르는) 명시 상태는 무시
      const it = { ...base, liked: liked.has(id), disliked: disliked.has(id), pinned: walls.has(id),
                   reason: disliked.has(id) ? reasonOf(id) : null, days: R6(days(t)) };
      items.push(it);
      /* 엔진 aggregateAffinity 와 같은 우선순위: 벽 > 좋아요 > 싫어요 */
      if (it.pinned) { c.pins_song++; groupSrc.set(id, { pins: 1 }); }
      else if (it.liked && !it.disliked) { c.likes++; groupSrc.set(id, { likes: 1 }); }
      else if (it.disliked) { if (isTasteDislike(it.reason)) { c.dislikes_taste++; groupSrc.set(id, { dislikes: 1 }); } else c.dislikes_other++; }
    } else {
      const v = votes.get(id);
      if (!v || v.pos + v.neg <= 0) continue;
      items.push({ ...base, vote: { pos: v.pos, neg: v.neg, pin: 0 }, days: R6(days(v.last)) });
      c.vote_sum = R9(c.vote_sum + v.pos + v.neg); c.completes += v.kept; c.skips += v.skips;
      groupSrc.set(id, { completes: v.kept, skips: v.skips });
    }
  }
  if (!(rT > -Infinity)) for (const a of prof.pinned_artists) { items.push({ pinned: true, artist: a, days: 0 }); c.pins_artist++; }

  // 3) μ = mu_max·E/(E + k_mu) — 증거량으로 정하는 결정식(보상 학습 없음, 심사 A-1)
  const E = R9(c.likes + c.dislikes_taste + T.pin_evidence_w * (c.pins_song + c.pins_artist) + c.vote_sum);
  const mu = R9(T.mu_max * E / (E + T.k_mu));
  const affOpts = { scope_add: T.dislike_scope_add || {} };
  if (extraIds.length) affOpts.extra_feature_ids = extraIds;
  const affinity = aggregateAffinity(items, rules, affOpts);

  // 4) 발견 칸 일시정지 — 발견 곡이 연속 pause_after_skips 번 조기 넘김되면 다음 pause_sessions 세션 동안 끔
  const D = T.discovery, rD = resetAt("discovery");
  let consec = 0, paused = null;
  sessions.forEach((s, si) => {
    if (!(s.at_ms >= rD)) return;
    for (const row of s.path) if (row.discovery) {
      const e = s.exposures.find((x) => x.song_id === row.song_id);
      if (!e) continue;
      if (isEarlySkip(e, PR)) { consec++; if (consec >= D.pause_after_skips) { paused = si + D.pause_sessions; consec = 0; } }
      else if (isExposed(e, PR)) consec = 0;
    }
  });

  return {
    items, affinity, E, mu, discovery: { paused_until_session: paused, consecutive_skips: consec },
    disliked_ids: [...disliked],
    counts: { ...c, n_items: items.length, groups: tasteGroups(items, affinity, groupSrc, rules) },
  };
}

/* 설명용 묶음 — 내 평균(p0)보다 높은 묶음 3개·낮은 묶음 2개와 그 횟수(§4.7 설명) */
function tasteGroups(items, aff, src, rules) {
  const p0 = likeBase(aff) ?? (hasPins(aff) ? NEUTRAL : null);
  if (p0 === null) return { p0: null, top: [], bottom: [] };
  const featSpecs = (rules.preference && rules.preference.features) || [];
  const featLabel = Object.fromEntries(featSpecs.map((f) => [f.id, f.label || f.id]));
  const featBool = Object.fromEntries(featSpecs.map((f) => [f.id, f.bins === "boolean"]));
  const BIN_WORD = { low: "낮음", mid: "중간", high: "높음" };
  const names = new Map();   // 가수 키 → 표기
  const cnt = new Map();     // 묶음 키 → 횟수
  const addCnt = (key, s) => {
    const r = cnt.get(key) || { likes: 0, completes: 0, skips: 0, pins: 0, dislikes: 0 };
    for (const k of Object.keys(r)) r[k] += (s && s[k]) || 0;
    cnt.set(key, r);
  };
  for (const it of items) {
    for (const part of String(it.artist || "").split(";")) { const k = artistKeys(part)[0]; if (k && !names.has(k)) names.set(k, part.trim()); }
    const s = it.song_id ? src.get(it.song_id) : { pins: 1 };
    if (!s) continue;
    if (it.artist) for (const k of artistKeys(it.artist)) addCnt("artist:" + k, s);
    for (const g of it.genres || []) addCnt("genre:" + g, s);
    for (const [fid, b] of Object.entries(it.feature_bins || {})) addCnt("feature:" + fid + ":" + b, s);
  }
  const rows = [];
  const push = (kind, key, rec, label) => {
    const sc = shrunkScore(rec, p0, rules);
    if (Math.abs(sc - p0) < EPS) return;
    rows.push({ kind, key, label, score: R6(sc), ...(cnt.get(kind + ":" + key) || { likes: 0, completes: 0, skips: 0, pins: 0, dislikes: 0 }) });
  };
  for (const [k, r] of Object.entries(aff.artist_affinity || {})) push("artist", k, r, names.get(k) || k);
  for (const [g, r] of Object.entries(aff.genre_affinity || {})) push("genre", g, r, g);
  for (const [key, r] of Object.entries(aff.feature_affinity || {})) {
    const i = key.lastIndexOf(":"), fid = key.slice(0, i), b = key.slice(i + 1);
    const lab = featBool[fid] ? (b === "yes" ? String(featLabel[fid]).replace(/\s*여부$/, "") : String(featLabel[fid]).replace(/\s*여부$/, "") + " 아님")
                              : `${featLabel[fid] || fid} ${BIN_WORD[b] || b}`;
    push("feature", key, r, lab);
  }
  const cmp = (a, b) => b.score - a.score || (a.kind + a.key < b.kind + b.key ? -1 : 1);
  const top = rows.filter((r) => r.score > p0).sort(cmp).slice(0, 3);
  const bottom = rows.filter((r) => r.score < p0).sort((a, b) => -cmp(a, b)).slice(0, 2);
  return { p0: R6(p0), top, bottom };
}

/* §4.1.2 좌표 보정 — 두 층 축소(단어 → 필드 전체). 관측은 항상 보정 전 표 좌표 기준 o = 최종 − 표(심사 C-1) */
function buildCalib(field, X) {
  const { PR, sessions, resetAt, days } = X;
  const C = PR.calib;
  const g = { W: 0, Sv: 0, Se: 0 };
  const L = {};
  let nEditAll = 0;
  for (const s of sessions) {
    const inp = s.input;
    const parts = labelShares(inp.labels && inp.labels[field]);   // 탭은 표 좌표가 없어 관측이 아니다
    if (!parts.length) continue;
    const table = field === "current" ? inp.now_table : inp.target_table;
    const fin = field === "current" ? inp.now : inp.target;
    if (!table || !fin) continue;
    const nudged = !!(inp.nudged && inp.nudged[field]);
    const ov = R9(R3(fin.v) - R3(table.v)), oe = R9(R3(fin.e) - R3(table.e));
    const w0 = (nudged ? C.w_edit : C.w_accept) * Math.pow(0.5, days(s.at_ms) / PR.decay.calib_half_life_days);
    const edit = nudged && Math.max(Math.abs(ov), Math.abs(oe)) >= C.edit_eps;
    let used = false;
    for (const { label, share } of parts) {
      if (!(s.at_ms >= resetAt("calib:" + field, "calib:" + field + ":" + label))) continue;
      const w = w0 * share;
      const r = L[label] || (L[label] = { W: 0, Sv: 0, Se: 0, n_edit: 0, dir: { v: [0, 0], e: [0, 0] } });   // dir: [+ 방향, − 방향] 옮김 수
      r.W += w; r.Sv += w * ov; r.Se += w * oe;
      g.W += w; g.Sv += w * ov; g.Se += w * oe;
      if (edit) {
        r.n_edit++; used = true;
        if (Math.abs(ov) >= C.edit_eps) r.dir.v[ov > 0 ? 0 : 1]++;
        if (Math.abs(oe) >= C.edit_eps) r.dir.e[oe > 0 ? 0 : 1]++;
      }
    }
    if (used) nEditAll++;
  }
  const gdv = g.Sv / (g.W + C.k_user), gde = g.Se / (g.W + C.k_user);
  const labels = {};
  for (const label of Object.keys(L).sort()) {
    const r = L[label];
    labels[label] = {
      dv: R9(clamp((r.Sv + C.k_label * gdv) / (r.W + C.k_label), -C.max_axis, C.max_axis)),
      de: R9(clamp((r.Se + C.k_label * gde) / (r.W + C.k_label), -C.max_axis, C.max_axis)),
      W: R9(r.W), n_edit: r.n_edit,
      applied: r.n_edit >= C.min_edits_label || nEditAll >= C.min_edits_global,
      dir: r.dir,
    };
  }
  return { g: { dv: R9(gdv), de: R9(gde), W: R9(g.W) }, labels, n_edit: nEditAll };
}

/* §4.1.5 안내 — 최근 lookback 세션에서 같은 단어로 mood_mismatch(위치 ≤ 2 이거나 없음)·arrival_mismatch 가 쌓이면 */
function buildPrompts(X) {
  const { PR, sessions, prof, asOf } = X;
  const C = PR.calib;
  const maxPos = ruleOr(PR, "outcome.mismatch_max_position");
  const cnt = { current: {}, target: {} };
  for (const s of sessions.slice(-PR.decay.lookback_sessions)) {
    const post = s.post;
    const mood = s.dislikes.some((d) => d.reason === "mood_mismatch" && (d.position == null || d.position <= maxPos))
      || (codeWeight(post, "mood_mismatch", PR) > 0 && (!post.positions.length || post.positions.some((p) => p <= maxPos)));
    const arr = s.dislikes.some((d) => d.reason === "arrival_mismatch") || codeWeight(post, "arrival_mismatch", PR) > 0;
    if (mood) for (const { label } of labelShares(s.input.labels.current)) cnt.current[label] = (cnt.current[label] || 0) + 1;
    if (arr) for (const { label } of labelShares(s.input.labels.target)) cnt.target[label] = (cnt.target[label] || 0) + 1;
  }
  const seen = prof.wp.calib_prompt_seen || {};
  const out = { current: [], target: [], counts: cnt };
  for (const f of ["current", "target"]) for (const label of Object.keys(cnt[f]).sort()) {
    if (cnt[f][label] < C.prompt_after_mismatch) continue;
    const t = firstNum(seen[f + ":" + label]);
    if (t !== null && asOf - t < C.prompt_repeat_days * DAY_MS) continue;   // 7일 안에 반복하지 않는다
    out[f].push(label);
  }
  return out;
}

/* §4.3 속도 π (가우스 축소) · §4.3.4 이탈 가드 */
function buildPace(X) {
  const { PR, sessions, resetAt } = X;
  const P = PR.pace, gam = PR.decay.session_gamma;
  const ss = sessions.filter((s) => s.at_ms >= resetAt("pace"));
  let S = 0, W = 0, votes = 0;
  const counts = { fast: 0, slow: 0, faster: 0, ok: 0, slower: 0 };
  for (let j = 0; j < ss.length; j++) {   // j = 몇 세션 전 (0 = 가장 최근)
    const s = ss[ss.length - 1 - j], g = Math.pow(gam, j);
    const pu = s.input.pace_user;
    if (pu === "fast" || pu === "slow") {   // 속도 버튼 직접 선택 (옛 기록은 input.pace_mode)
      const v = pu === "fast" ? 1 : -1;
      S += g * P.w_chip * v; W += g * P.w_chip; votes++; counts[pu]++;
    }
    const ans = s.post && s.post.pace_answer;
    if (ans) {   // 「듣고 난 뒤」 속도 답 — 그 추천에 실제로 쓴 π 기준으로 한 걸음
      const piU = pu === "fast" ? 1 : pu === "slow" ? -1 : s.used && num(s.used.pi_used) ? s.used.pi_used : 0;
      const v = clamp(piU + P.vote_step * PACE_ANSWERS[ans], -1, 1);
      S += g * P.w_answer * v; W += g * P.w_answer; votes++; counts[ans]++;
    }
  }
  const pi = clamp(S / (W + P.k0), -1, 1);
  // 이탈 가드 — 10분 안 재요청·노출 0 세션 제외, 가상 세션(f = 1)을 더한 중앙값
  const QG = P.quit_guard;
  const win = ss.slice(-PR.decay.lookback_sessions).filter((s) => s.reached_frac != null && !s.rerequested_within_10min);
  const fMed = win.length >= QG.min_sessions ? median([...win.map((s) => s.reached_frac), ...Array(QG.prior_sessions).fill(1)]) : null;
  return { pi: R9(pi), W: R9(W), votes, quit: { f_med: fMed === null ? null : R6(fMed), n: win.length }, counts };
}

/* §4.4 시작 오프셋 — 취향 통제 비율 + mood_mismatch 명시 확인, 이력 현상(팔이 바뀌면 그 뒤 세션만 센다) */
function startStats(s, X, adj = null) {
  const PR = X.PR, A = PR.adjacency;
  const maxPos = ruleOr(PR, "outcome.mismatch_max_position");
  const q = (row) => sigmoid(A.theta0 + A.theta_margin * (row && num(row.pmarg) ? row.pmarg : 0));
  const firstExp = (pos) => s.exposures.find((e) => e.role === "path" && e.position === pos && e.cause !== "autoplay_fail");
  const mm = s.dislikes.filter((d) => d.reason === "mood_mismatch");
  const mmSongs = new Set(mm.map((d) => d.song_id));
  const rej = (e) => isEarlySkip(e, PR) || mmSongs.has(e.song_id);   // not_my_taste 는 취향 신호라 넣지 않는다
  /* [2026-09-29] 전환 통제(start.expect_transition): 이동 곡의 거절에는 들어온 전환 몫이 섞이고 첫 곡에는 없다 —
     이동 곡의 기대 거절 q 에 들어온 전환의 큰 변화 특징마다 적합 배수 m_f(적용 문턱 전, §4.8.3)를 곱한다. 없으면 q 만(이전 동작). */
  const transMult = (e) => {
    if (!adj || PR.start.expect_transition !== true || e.prev_index == null) return 1;
    const a = s.exposures[e.prev_index];
    const L = a ? largeFlags(a.song_id, e.song_id, X) : null;
    let m = 1;
    if (L) for (const f of FEATS) if (L[f] && num(adj.m[f])) m *= adj.m[f];
    return m;
  };
  const out = { O1: 0, E1: 0, n1: 0, Or: 0, Er: 0, nr: 0, up: 0, down: 0 };
  const row1 = s.path[0];
  if (row1) { const e = firstExp(row1.position); if (e && isExposed(e, PR)) { out.n1 = 1; out.E1 = q(row1); out.O1 = rej(e) ? 1 : 0; } }
  for (const row of s.path.slice(1)) {
    if (row.phase !== "move") continue;
    const e = firstExp(row.position);
    if (e && isExposed(e, PR)) { out.nr++; out.Er += q(row) * transMult(e); out.Or += rej(e) ? 1 : 0; }
  }
  const post = s.post;
  for (const d of mm) { if (num(d.position) && d.position <= maxPos) out.up++; if (d.position === 1) out.down++; }
  if (post && post.reasons.mood_mismatch === "user" && post.positions.some((p) => p <= maxPos)) out.up++;
  const cw = codeWeight(post, "mood_mismatch", PR);
  if (cw > 0 && post.positions.includes(1)) out.down += cw;
  return out;
}
function buildStart(X, adj = null) {
  const { PR, sessions, resetAt } = X;
  const ST = PR.start, arms = ST.arms, LB = PR.decay.lookback_sessions;
  const r0 = resetAt("start");
  const agg = (w) => {
    const a = { O1: 0, E1: 0, n1: 0, Or: 0, Er: 0, nr: 0, up: 0, down: 0 };
    for (const x of w) for (const k of Object.keys(a)) a[k] += x[k];
    const n = a.n1 + a.nr, pbar = n > 0 ? (a.O1 + a.Or) / n : 0;
    const d1 = a.E1 + 2 * pbar, dr = a.Er + 2 * pbar;
    const sr1 = d1 > 0 ? (a.O1 + 2 * pbar) / d1 : null, srr = dr > 0 ? (a.Or + 2 * pbar) / dr : null;
    a.ratio = sr1 !== null && srr ? sr1 / srr : null;
    return a;
  };
  let ai = 0, win = [], since = null;
  for (const s of sessions) {
    if (s.app !== "web-personal" || !(s.at_ms >= r0)) continue;
    win.push(startStats(s, X, adj));
    if (win.length > LB) win.shift();
    const a = agg(win);
    if (ai > 0 && a.down >= ST.down_mismatch_n) { ai--; win = []; since = s.rec_id; }
    else if (ai < arms.length - 1 && a.n1 >= ST.min_first_songs && a.ratio !== null && a.ratio >= ST.ratio_up * ST.pop_first_ratio && a.up >= 1) {
      ai++; win = []; since = s.rec_id;
    }
  }
  const a = agg(win);
  return { arm: arms[ai], ratio: a.ratio === null ? null : R6(a.ratio), n1: a.n1, O1: a.O1, mismatch_up: R6(a.up), mismatch_down: R6(a.down), since_rec_id: since };
}

/* §4.5 감상 시간 — log2 분 척도의 절대 표, 기준 시간이 닻 */
function buildLength(X) {
  const { PR, rules, sessions, prof, resetAt } = X;
  const LN = PR.length, gam = PR.decay.session_gamma;
  const mins = sessions.filter((s) => !s.input.nl_minutes && num(s.input.minutes) && s.input.minutes > 0).slice(-LN.base_sessions).map((s) => s.input.minutes);
  const base = mins.length ? median(mins) : prof.recommend_minutes ?? Number(rules.inputs.duration_min.default);
  const ss = sessions.filter((s) => s.at_ms >= resetAt("length"));
  let S = 0, W = 0, votes = 0;
  const counts = { long: 0, short: 0 };
  for (let j = 0; j < ss.length; j++) {
    const s = ss[ss.length - 1 - j];
    const dir = s.post && s.post.length_dir;
    if (!dir || !num(s.input.minutes) || s.input.minutes <= 0) continue;
    if (s.post.reasons.length === "ai") continue;   // AI 가 고른 length 는 표가 아니다 (reasons 의 "length" 키)
    const g = Math.pow(gam, j);
    S += g * (Math.log2(s.input.minutes) + LN.vote_step_log2 * (dir === "short" ? 1 : -1));
    W += g; votes++; counts[dir]++;
  }
  const lb = Math.log2(base);
  const bias = clamp((S + LN.k0 * lb) / (W + LN.k0) - lb, LN.clamp_log2[0], LN.clamp_log2[1]);
  return { bias_log2: R9(bias), W: R9(W), S: R9(S), base_minutes: base, votes, applied: Math.abs(bias) >= LN.apply_abs_log2, counts };
}

/* §4.6.2 머묾 반경 — 규칙 기반 계단, 이력 현상. 머묾 곡의 조기 넘김은 쓰지 않는다(취향) */
function holdStats(s, PR) {
  const holdPos = new Set(s.path.filter((r) => r.phase === "hold").map((r) => r.position));
  const ac = codeWeight(s.post, "arrival_mismatch", PR), ad = s.dislikes.filter((d) => d.reason === "arrival_mismatch" && d.phase === "hold").length;
  const aw = ac + ad;
  const rd = s.dislikes.filter((d) => d.reason === "too_repetitive" && d.phase === "hold").length;
  let rw = rd, rc = 0;
  const cw = codeWeight(s.post, "too_repetitive", PR);
  if (cw > 0 && s.post.positions.length && s.post.positions.every((p) => holdPos.has(p))) { rw += cw; rc = 1; }
  /* an·rn = 설명용 횟수(가중 없이 — 세션 코드 1번 + 곡 싫어요 곡마다 1번). 학습은 가중 합(aw·rw)으로 한다 */
  return { aw, rw, an: (ac > 0 ? 1 : 0) + ad, rn: rc + rd };
}
function buildHold(X) {
  const { PR, sessions, resetAt } = X;
  const H = PR.hold, arms = H.arms, LB = PR.decay.lookback_sessions;
  let ai = arms.indexOf(H.p0_radius);
  if (ai < 0) ai = arms.reduce((b, a, i) => (Math.abs(a - H.p0_radius) < Math.abs(arms[b] - H.p0_radius) ? i : b), 0);
  const r0 = resetAt("hold");
  let win = [], since = null;
  const sum = (k) => win.reduce((a, x) => a + x[k], 0);
  for (const s of sessions) {
    if (s.app !== "web-personal" || !(s.at_ms >= r0)) continue;   // 반경을 쓴 web-personal 세션만
    win.push(holdStats(s, PR));
    if (win.length > LB) win.shift();
    if (sum("aw") >= H.arrival_mismatch_min && ai > 0) { ai--; win = []; since = s.rec_id; }           // 좁힘이 넓힘보다 우선
    else if (sum("rw") >= H.repetitive_min && ai < arms.length - 1) { ai++; win = []; since = s.rec_id; }
  }
  return { arm: arms[ai], arrival_w: R6(sum("aw")), repetitive_w: R6(sum("rw")), arrival_n: sum("an"), repetitive_n: sum("rn"), since_rec_id: since };
}

/* §4.9 소프트 말 많은 곡 게이트 — 켜짐 (a) vocal_bother · (b) 말 비중 '높음' 묶음 비율, 마지막 근거로부터 expire_days 뒤 만료 */
function buildGates(X, taste) {
  const { PR, rules, sessions, prof, G, asOf, idx, resetAt } = X;
  const GS = PR.gates.soft_spoken;
  const gate = (rules.gates || []).find((g) => g.id === SOFT_GATES.soft_spoken);
  const fid = gate ? (((rules.preference && rules.preference.features) || []).find((f) => f.field === gate.field) || {}).id : null;
  const isHigh = (sid) => { const s = idx.byId.get(sid); return !!(fid && s && s.feature_bins && s.feature_bins[fid] === "high"); };
  const r0 = resetAt("gates");
  let vb = 0, vbN = 0, lastA = null, lastB = null;
  for (const s of sessions) {
    if (!(s.at_ms >= r0)) continue;
    const inWin = asOf - s.at_ms <= GS.window_days * DAY_MS;
    let w = codeWeight(s.post, "vocal_bother", PR);
    if (w > 0 && GS.corroborate_codes === true) {
      /* [2026-09-29] 세션 코드는 그 세션에 말 비중 '높음' 경로 곡을 조기 넘김한 일이 있을 때만 센다(코드에 위치가 있으면 그 위치에서) —
         말 많은 곡이 없던 세션의 '가사·목소리가 거슬려요'(다른 이유·잡음)가 게이트를 켜지 않게 */
      const hs = new Set(s.exposures.filter((e) => e.role === "path" && isHigh(e.song_id) && isEarlySkip(e, PR)).map((e) => e.position));
      const pos = (s.post && s.post.positions) || [];
      if (!(pos.length ? pos.some((p) => hs.has(p)) : hs.size > 0)) w = 0;
    }
    let n = w > 0 ? 1 : 0;   // 설명용 횟수(가중 없이) — 세션 코드 1번 + 곡 싫어요 곡마다 1번
    for (const d of s.dislikes) if (d.reason === "vocal_bother" && isHigh(d.song_id)) { w += 1; n++; }
    if (w > 0) { if (inWin) { vb += w; vbN += n; } lastA = Math.max(lastA ?? -Infinity, s.at_ms); }
  }
  /* (b) 의 마지막 근거 = 말 비중 '높음' 곡에 대한 가장 최근 부정 근거(취향 싫어요·말 거슬림 싫어요·부정 청취 표) 시각 — 취향 항목의 경과일로 잰다 */
  for (const it of taste.items) {
    if (!it.song_id || !isHigh(it.song_id) || !(it.days >= 0)) continue;
    const neg = it.vote ? it.vote.neg > 0 : it.disliked && !it.pinned && !(it.liked && !it.disliked);
    if (neg && asOf - it.days * DAY_MS >= r0) lastB = Math.max(lastB ?? -Infinity, asOf - it.days * DAY_MS);
  }
  const aff = taste.affinity;
  const rec = fid ? (aff.feature_affinity || {})[fid + ":high"] : null;
  const p0 = likeBase(aff) ?? (hasPins(aff) ? NEUTRAL : null);
  const score = rec && p0 !== null ? shrunkScore(rec, p0, rules) : null;
  const nB = rec ? (rec.pos || 0) + (rec.neg || 0) : 0;
  const onA = vb >= GS.vocal_bother_min;
  const onB = score !== null && nB >= GS.min_n && score <= GS.rate_ratio_max * p0;
  const lastEv = Math.max(onA && lastA !== null ? lastA : -Infinity, onB && lastB !== null ? lastB : -Infinity);
  const on = (onA || onB) && lastEv > -Infinity && asOf - lastEv <= GS.expire_days * DAY_MS;
  const off = mergeMax(prof.wp.gate_off_until, G.gate_off_until);
  const userOff = gate && (off[gate.id] ?? -Infinity) > asOf;
  return {
    soft: on && gate && !userOff ? [gate.id] : [],
    evidence: { vocal_bother_w: R6(vb), vocal_bother_n: vbN, spoken_score: score === null ? null : R6(score), spoken_n: R6(nB), last_evidence_ms: lastEv > -Infinity ? lastEv : null },
    off_until: off,
  };
}

/* §4.10 다양성 — 가수 상한 · 기기 무관 최근 창 · 좋아요 곡 다시 넣기 */
function buildDiversity(X) {
  const { PR, rules, sessions, prof, asOf, resetAt } = X;
  const D = PR.diversity, RP = D.replay;
  const recent = sessions.filter((s) => s.at_ms >= resetAt("diversity")).slice(-PR.decay.lookback_sessions);
  let rep = 0, repN = 0;   // too_repetitive 세션 가중(출처 무관, AI 유지 0.5) — 세션당 최대 1 · repN = 설명용 세션 수(가중 없이)
  for (const s of recent) {
    const w = Math.max(s.dislikes.some((d) => d.reason === "too_repetitive") ? 1 : 0, codeWeight(s.post, "too_repetitive", PR));
    rep += w; if (w > 0) repN++;
  }
  const maxCap = Number(rules.diversity.max_per_artist);
  const window = rep >= D.repetitive_sessions_for_window ? D.recent_window_repetitive : D.recent_window;
  const cap = rep >= D.repetitive_sessions_for_cap ? Math.min(D.artist_cap_low, maxCap) : maxCap;   // 규칙 값보다 올리지 않는다
  // 최근 창 — 두 앱의 추천 문서(경로 + 더 들을 곡, 보여 줬지만 안 들은 곡 포함), 최신순 서로 다른 곡
  const ids = [], seen = new Set(), lastSeen = new Map();
  const see = (id, t) => lastSeen.set(id, Math.max(lastSeen.get(id) ?? -Infinity, t));
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    for (const r of [...s.path, ...s.extras]) { see(r.song_id, s.at_ms); if (!seen.has(r.song_id)) { seen.add(r.song_id); ids.push(r.song_id); } }
    for (const e of s.exposures) see(e.song_id, e.at_ms);
  }
  const recentIds = ids.slice(0, Math.min(window, PR.bounds.exclude_ids_max));
  // 다시 넣기 — 일시정지(연속 조기 넘김) · 곡 차단(too_repetitive 30일) · 쿨다운 7일
  const rR = resetAt("replay");
  let consec = 0, paused = null;
  const blockUntil = new Map();
  sessions.forEach((s, si) => {
    for (const d of s.dislikes) if (d.reason === "too_repetitive") blockUntil.set(d.song_id, Math.max(blockUntil.get(d.song_id) ?? -Infinity, s.at_ms + RP.song_block_days * DAY_MS));
    if (!(s.at_ms >= rR)) return;
    for (const row of [...s.path, ...s.extras]) if (row.replay) {
      const e = s.exposures.find((x) => x.song_id === row.song_id);
      if (!e) continue;
      if (isEarlySkip(e, PR)) { consec++; if (consec >= RP.pause_after_skips) { paused = si + RP.pause_sessions; consec = 0; } }
      else if (isExposed(e, PR)) consec = 0;
    }
  });
  const love = new Set([...prof.liked, ...prof.playlists, ...prof.favorite_tracks]);
  const disliked = new Set(prof.disliked);
  const replayIds = recentIds.filter((id) => love.has(id) && !disliked.has(id) && !((blockUntil.get(id) ?? -Infinity) > asOf)
    && asOf - (lastSeen.get(id) ?? -Infinity) > RP.cooldown_days * DAY_MS).slice(0, PR.bounds.replay_ids_max);
  return {
    artist_cap: cap, recent_window: window, recent_ids: recentIds, replay_ids: replayIds,
    replay: { paused_until_session: paused, consecutive_skips: consec }, repetitive_sessions_w: R6(rep), repetitive_sessions_n: repN,
  };
}

// ── 보정 · 시간 제안 (앱이 부른다) ────────────────────────────
/* §4.1.3 — 표 좌표를 만든 직후 부르고, 반환한 point 를 CUR_VA/TGT_VA 로 쓴다. labels 는 그 필드의 라벨이거나 {current, target} 전체. */
export function calibratePoint(model, field, labels, tablePt, rules) {
  const PR = cfg(rules), C = PR.calib;
  const lab = labels && labels.mode ? labels : labels && labels[field] ? labels[field] : null;
  const t = validPt(tablePt);
  const out = { point: t, applied: null, basis: null, prompt: null, prompt_key: null };
  if (!t || !lab || lab.mode === "tap") return out;
  const M = model && model.calib && model.calib[field];
  const parts = labelShares(lab);
  let dv = 0, de = 0, basis = null, best = -1;
  for (const { label, share } of parts) {
    const r = M && M.labels && M.labels[label];
    if (!r || !r.applied) continue;   // 옮김 관측이 문턱에 못 미치면 δ = 0
    dv += share * r.dv; de += share * r.de;
    if (share > best) { best = share; basis = { label, n_edit: r.n_edit >= C.min_edits_label ? r.n_edit : M.n_edit }; }
  }
  dv = clamp(dv, -C.max_axis, C.max_axis); de = clamp(de, -C.max_axis, C.max_axis);
  /* 0.5 넘기 보호 — 표 좌표가 중립 한쪽에 있을 때 보정이 중립을 넘으려면 그 단어에 같은 방향 옮김이 cross_neutral_min_edits 번 이상 */
  const guard = (x, d, axis) => {
    if (d === 0 || x === NEUTRAL) return d;
    if (!((x < NEUTRAL && x + d > NEUTRAL) || (x > NEUTRAL && x + d < NEUTRAL))) return d;
    const di = d > 0 ? 0 : 1;
    const n = Math.max(0, ...parts.map(({ label }) => { const r = M && M.labels && M.labels[label]; return r && r.dir ? r.dir[axis][di] : 0; }));
    return n >= C.cross_neutral_min_edits ? d : NEUTRAL - x;
  };
  dv = guard(t.v, dv, "v"); de = guard(t.e, de, "e");
  const p = { v: R9(clamp(t.v + dv, C.clamp[0], C.clamp[1])), e: R9(clamp(t.e + de, C.clamp[0], C.clamp[1])) };
  const adv = R9(p.v - t.v), ade = R9(p.e - t.e);
  if (Math.abs(adv) > EPS || Math.abs(ade) > EPS) { out.point = p; out.applied = { dv: adv, de: ade }; out.basis = basis; }
  const pr = model && model.calib && model.calib.prompts ? model.calib.prompts[field] || [] : [];
  const hit = parts.find(({ label }) => pr.includes(label));
  if (hit) {
    out.prompt = field === "current"
      ? "지난번 첫 곡이 기분과 달랐다고 하셨어요. 점을 끌어서 지금 기분에 맞춰 볼까요?"
      : "지난번 끝 분위기가 원한 것과 달랐다고 하셨어요. 목표 점을 끌어서 맞춰 볼까요?";
    out.prompt_key = field + ":" + hit.label;
  }
  return out;
}

/* §4.5 — 다음 세션 감상 시간 기본값 제안. 선언을 바꾸지 않고 제안만 한다(I4). */
export function suggestMinutes(model, baseMinutes, rules) {
  const PR = cfg(rules), LN = PR.length;
  const Lm = (model && model.length) || {};
  const base = num(baseMinutes) && baseMinutes > 0 ? baseMinutes : num(Lm.base_minutes) && Lm.base_minutes > 0 ? Lm.base_minutes : Number(rules.inputs.duration_min.default);
  const lb = Math.log2(base);
  const S = Number(Lm.S) || 0, W = Number(Lm.W) || 0;
  const bias = clamp((S + LN.k0 * lb) / (W + LN.k0) - lb, LN.clamp_log2[0], LN.clamp_log2[1]);
  const applied = Math.abs(bias) >= LN.apply_abs_log2;
  const minutes = applied
    ? clamp(Math.round(Math.pow(2, lb + bias) / LN.round_minutes) * LN.round_minutes, LN.minutes_range[0], LN.minutes_range[1])
    : base;
  return { minutes, bias_log2: R6(bias), applied };
}

// ── 정책 (§6.5) ──────────────────────────────────────────
function withPolicyDigest(p) {
  p.digest = digest({ ...p, digest: undefined });
  return p;
}
/* I1 항등원 — 넣어도 곡 순서와 2.5.1 trace 키 값이 같다(새 p_* 키만 추가) */
export function neutralPolicy(rules) {
  const PR = cfg(rules), A = PR.adjacency;
  return withPolicyDigest({
    v: 1, schema: SCHEMAS.policy, digest: null, model_digest: null,
    stress: null, high_stress: false,
    tp: null, quit_frac: null,
    start_offset: 0, start_min_journey: PR.start.min_journey,
    hold_radius: 0, hold_min_songs: PR.hold.min_songs, hold_order: "fit", hold_min_pool: 0, hold_cluster: false, hold_path_q: false, hold_break: null,
    corridor_bands: null, j_move: null, j_hold: null, pers_bucket: null, pers_jitter: null,
    mu: Number(rules.preference.pref_weight || 0), taste_features: null,
    adj_w: { tempo: 0, vocal: 0, spoken: 0, genre: 0 },
    bpm_scale: A.bpm_scale, spoken_scale: A.spoken_scale, half_double_fold: A.half_double_fold,
    lambda: Number(rules.path.jump_weight || 0),
    discovery_u: null,
    soft_gates: [], soft_min_pool: PR.gates.soft_min_pool,
    artist_cap: Number(rules.diversity.max_per_artist), artist_cap_by_key: false,
    exclude_ids: null, replay_ids: [], replay_max: 0,
  });
}

function compressAffinity(u) {
  if (!u) return null;
  const tbl = (t) => {
    const o = {};
    for (const k of Object.keys(t || {}).sort()) {
      const r = t[k] || {};
      o[k] = { pos: R3(r.pos || 0), neg: R3(r.neg || 0), pin: R3(r.pin || 0), last_days: R3(r.last_days || 0) };
    }
    return o;
  };
  const b = u.like_base || {};
  return { like_base: { pos: R3(b.pos || 0), neg: R3(b.neg || 0) }, song_likes: tbl(u.song_likes), artist_affinity: tbl(u.artist_affinity),
           genre_affinity: tbl(u.genre_affinity), feature_affinity: tbl(u.feature_affinity) };
}

/* 유의한 묶음만 엔진에 넘긴다(§4.7 보강, 2026-09-29). 청취 표 한 표(listen_vote.unit)를 관측 1회, 좋아요·싫어요 1 을 관측 1/unit 회로 보고
   z = |p̂ − p0|·√(N / (p0(1 − p0))) 가 taste.group_z_min 보다 작은 가수·장르·특징 묶음은 뺀다 → 엔진에서 '모르면 내 평균'(p0).
   벽(pin)이 있는 묶음과 곡 자체의 기록(song_likes — 넓혀 추정한 것이 아니라 그 곡의 직접 근거)은 늘 남긴다.
   group_z_min 이 없으면 그대로(이전 동작). 학습 모드(personal·geometry)에서만 부른다 — p0 정책·빈 모델은 영향 없음. */
function significantAffinity(aff, PR) {
  const zMin = PR.taste && num(PR.taste.group_z_min) ? PR.taste.group_z_min : null;
  if (!aff || zMin === null) return aff;
  const p0 = likeBase(aff);
  if (p0 === null || p0 <= 0 || p0 >= 1) return aff;
  const unit = PR.listen_vote.unit;
  const keep = (r) => {
    if ((r.pin || 0) > 0) return true;
    const n = (r.pos || 0) + (r.neg || 0);
    return n > 0 && Math.abs((r.pos || 0) / n - p0) * Math.sqrt((n / unit) / (p0 * (1 - p0))) >= zMin;
  };
  const tbl = (t) => { const o = {}; for (const k of Object.keys(t || {})) if (keep(t[k])) o[k] = t[k]; return o; };
  return { ...aff, artist_affinity: tbl(aff.artist_affinity), genre_affinity: tbl(aff.genre_affinity), feature_affinity: tbl(aff.feature_affinity) };
}

/* resolvePolicy(model, ctx, rules, { mode })
   mode "personal"(기본) — 학습값 전부 · "p0" — 기준 실행 R: 모집단 기본 + 비학습 사실(싫어요·최근 창)만
   · "geometry" — 안전 폴백 A′(§2.2 7단계): 경로 모수(tp·s·이탈 가드·r)만 P0 로 되돌리고 나머지는 개인값
   · "path" — 안전 확인의 둘째 기준 R_path(§2.2 7단계, 2026-09-29): 경로 모수만 개인값, 곡 레인(취향·전환·게이트·다양성)은 P0 — geometry 의 거울 */
export function resolvePolicy(model, ctx, rules, { mode = "personal" } = {}) {
  const PR = cfg(rules);
  model = model || emptyModel(rules);
  ctx = ctx || {};
  const A = PR.adjacency, SF = PR.safety, HS = SF.high_stress, B = PR.bounds;
  const band = Number(rules.preference.band);
  const learned = mode === "personal" || mode === "geometry";   // 취향·전환·게이트·다양성 학습값
  const pathLearned = mode === "personal" || mode === "path";    // 경로 모수 학습값
  const stress = ctx.now ? stressOf(ctx.now, rules) : null;
  const high = stress !== null && stress >= SF.high_stress_min;
  const minutes = num(ctx.minutes) && ctx.minutes > 0 ? ctx.minutes : Number(rules.inputs.duration_min.default);
  const paceUser = ctx.pace_user === "fast" || ctx.pace_user === "slow" ? ctx.pace_user : null;

  // 속도 → tp (§4.3.3). 버튼을 누르면 엔진이 manual_tp 를 쓰므로 tp 는 null(사용자 선언이 이긴다, I4)
  let tp = null, piUsed = paceUser ? (paceUser === "fast" ? 1 : -1) : 0;
  if (pathLearned && !paceUser && Math.abs(model.pace.pi) >= PR.pace.apply_abs) {
    const atDef = transitionAt(rules, minutes);
    let pi = model.pace.pi;
    if (high && pi > 0 && !HS.faster_pace_allowed) pi = 0;   // I5 — 자동은 기본보다 빠를 수 없음
    if (pi !== 0) {
      let t = pi >= 0 ? atDef - pi * (atDef - PR.pace.tp_fast) : atDef + -pi * (PR.pace.tp_slow - atDef);
      if (songCount(rules, minutes) <= PR.pace.small_n_max) t = Math.max(t, PR.pace.small_n_min_tp);
      if (high) t = Math.max(t, atDef);
      tp = R9(clamp(t, B.tp[0], B.tp[1]));
      piUsed = pi;
    }
  }
  // 이탈 가드 (§4.3.4) — '천천히' 직접 선택·고긴장이면 끔
  const qf = model.pace.quit && model.pace.quit.f_med;
  const quit = pathLearned && PR.pace.quit_guard.enabled && paceUser !== "slow" && !high && num(qf) && qf < PR.pace.quit_guard.apply_below
    ? R9(clamp(qf, B.quit_frac[0], B.quit_frac[1])) : null;
  // 시작 오프셋 (§4.4) · 머묾 반경 (§4.6)
  let s0 = pathLearned ? model.start.arm : 0;
  if (high) s0 = Math.min(s0, HS.start_offset_max);
  let r = pathLearned ? model.hold.arm : PR.hold.p0_radius;
  if (high) r = Math.min(r, HS.hold_radius_max);
  // 취향 강도 μ (§4.7.3)
  const mu = learned ? clamp(model.taste.mu, 0, Math.max(PR.taste.mu_max, Number(rules.preference.pref_weight || 0))) : 0;
  // 전환 비용 (§4.8.2–4.8.5). 고긴장은 더 엄격하게만(배수 ≥ adj_mult_min)
  const mEff = {};
  for (const f of FEATS) {
    let m = learned && model.adjacency.applied[f] ? model.adjacency.m[f] : 1;
    if (high) m = Math.max(m, HS.adj_mult_min);
    mEff[f] = R6(m);
  }
  /* 반올림하지 않고 엔진 sanitizePersonal 과 같은 곱셈 순서(band × base × scale × 배수)로 계산한다 — 고긴장 하한을 다시 적용해도
     비트 단위로 같은 값이 나와야 정책이 sanitize 의 고정점이 된다(로그의 personal_policy = 이 정책) */
  const adjW = {};
  for (const f of ADJ_FEATS) adjW[f] = clamp(band * A.base_weights_bands[f] * A.scale * mEff[f], B.adj_w_bands_each[0] * band, B.adj_w_bands_each[1] * band);
  const jw = Number(rules.path.jump_weight || 0);
  const lambda = R9(clamp(jw * mEff.va, A.lambda_range[0], Math.min(A.lambda_range[1], B.lambda_max)));
  // 새 가수 발견 칸 (§4.7.4) — 무작위는 이 한 곳뿐, 시드 고정
  const D = PR.taste.discovery;
  const nextIdx = model.source && num(model.source.n_sessions) ? model.source.n_sessions : 0;
  const dPaused = num(model.taste.discovery.paused_until_session) && nextIdx <= model.taste.discovery.paused_until_session;
  const discovery = learned && mu >= D.min_mu && model.taste.E >= D.min_E && !(high && !HS.discovery) && !dPaused
    ? seededUniform(ctx.seed ?? null, "discovery") : null;
  // 다양성 (§4.10)
  const dv = model.diversity;
  const rPaused = num(dv.replay.paused_until_session) && nextIdx <= dv.replay.paused_until_session;
  const replay = learned && !rPaused ? dv.replay_ids.slice(0, B.replay_ids_max) : [];
  const replaySet = new Set(replay);
  const winN = learned ? dv.recent_window : PR.diversity.recent_window;
  const exclude = dv.recent_ids.slice(0, winN).filter((id) => !replaySet.has(id)).slice(0, B.exclude_ids_max);
  const extra = (PR.taste.extra_features || []).slice(0, ruleOr(PR, "bounds.taste_features_max"));

  const policy = withPolicyDigest({
    v: 1, schema: SCHEMAS.policy, digest: null, model_digest: model.digest ?? null,
    stress, high_stress: high,
    tp, quit_frac: quit,
    start_offset: R9(clamp(s0, B.start_offset[0], B.start_offset[1])), start_min_journey: PR.start.min_journey,
    hold_radius: R9(clamp(r, B.hold_radius[0], B.hold_radius[1])), hold_min_songs: PR.hold.min_songs, hold_order: PR.hold.order,
    hold_min_pool: num(PR.hold.min_pool) && r >= PR.hold.p0_radius ? PR.hold.min_pool : 0,   // 좁힌 팔(끝 분위기 불만으로 학습)은 넓히지 않는다
    hold_cluster: PR.hold.cluster === true,   // 머묾 곡끼리 turn_min 안(§4.6.1 변경 20260929) — 곡 레인(경유지 무관)
    hold_path_q: PR.hold.quantize_path === true,   // 머묾 걸음의 진행·λ 전환 비용도 pers_bucket 으로 양자화(§4.6.1 변경 20260929)
    hold_break: PR.hold.cluster_break === "j_hold" ? SF.j_hold : null,   // 묶음 밖 도착 영역 곡의 거리 비용 = 머묾 J(§4.6.1 변경 20260930)
    corridor_bands: SF.corridor_bands, j_move: R9(SF.j_move_bands * band), j_hold: SF.j_hold,
    pers_bucket: num(SF.pers_bucket_bands) ? R9(SF.pers_bucket_bands * band) : null,
    pers_jitter: SF.pers_mode === "perturb" && num(SF.pers_bucket_bands) ? R9(SF.pers_bucket_bands * band) : null,   // 이동 걸음 개인 비용 흔들기(§3.8 변경 20260930)
    mu: R9(mu), taste_features: extra.length ? extra : null,
    adj_w: adjW, bpm_scale: A.bpm_scale, spoken_scale: A.spoken_scale, half_double_fold: A.half_double_fold,
    lambda,
    discovery_u: discovery,
    soft_gates: learned ? [...model.gates.soft] : [], soft_min_pool: PR.gates.soft_min_pool,
    artist_cap: learned ? dv.artist_cap : Number(rules.diversity.max_per_artist), artist_cap_by_key: true,
    exclude_ids: exclude,
    replay_ids: replay, replay_max: replay.length ? clamp(PR.diversity.replay.max_per_session, B.replay_max[0], B.replay_max[1]) : 0,
  });

  /* 엔진 사용자 — 취향 표는 소수 3자리로 줄인 값을 그대로 쓴다: 로그의 user_affinity 로 정확히 재현하기 위해(§7.1, H3) */
  const aff = compressAffinity(learned ? significantAffinity(model.taste.affinity, PR) : aggregateAffinity([], rules, { scope_add: PR.taste.dislike_scope_add || {} }));
  const user = {
    disliked: uniq([...(model.taste.disliked_ids || []), ...(Array.isArray(ctx.disliked_now) ? ctx.disliked_now : [])]),
    recent_played: exclude,
    global_stats: ctx.global_stats || {},
    ...aff,
  };

  // 좌표 보정 기록 (§7.1 params.calib) — 앱이 준 값이 있으면 그것, 없으면 같은 모델로 다시 계산
  const calib = {};
  for (const field of ["current", "target"]) {
    const given = ctx.calib_applied && ctx.calib_applied[field];
    const lab = ctx.labels ? ctx.labels[field] : null;
    const firstLabel = (labelShares(lab)[0] || {}).label ?? null;
    if (given && num(given.dv) && num(given.de)) calib[field] = { label: firstLabel, dv: R6(given.dv), de: R6(given.de) };
    else {
      const c = calibratePoint(model, field, lab, field === "current" ? ctx.now_table : ctx.target_table, rules);
      calib[field] = c.applied ? { label: c.basis ? c.basis.label : firstLabel, dv: R6(c.applied.dv), de: R6(c.applied.de) } : null;
    }
  }
  const explain = mode === "personal" ? explainPolicy(policy, model, rules, ctx) : [];
  const vbw = model.gates.evidence.vocal_bother_w || 0;
  const meta = {
    schema: SCHEMAS.meta, personal_version: PERSONAL_VERSION, mode, rules_hash: rules.rules_hash ?? null,
    model_digest: model.digest ?? null, policy_digest: policy.digest, as_of_ms: model.as_of_ms ?? null,
    cursor: (model.source && model.source.cursor) || { last_event_ms: null, last_rec_ms: null },
    evidence: { E: model.evidence.E, n_exposures: model.evidence.n_exposures, n_transitions: model.evidence.n_transitions, n_pace_votes: model.evidence.n_pace_votes },
    params: {
      pi: pathLearned ? model.pace.pi : 0, pi_used: R9(piUsed),
      start_arm: policy.start_offset, hold_arm: policy.hold_radius,
      minutes_bias: learned && model.length.applied ? model.length.bias_log2 : 0,
      mu: policy.mu, m: mEff, lambda: policy.lambda, calib,
      soft_gates: policy.soft_gates, artist_cap: policy.artist_cap, recent_window: winN,
    },
    explain_codes: explain.map((c) => c.id),
    /* §4.12.1 앱 완화 순서 — instrumental_only 를 직접 골랐거나 최근 30일 vocal_bother ≥ 2 이면 장르를 먼저 푼다 */
    relax_order: ctx.lyric === "instrumental_only" || (learned && vbw >= PR.relax.vocal_bother_min) ? PR.relax.order_vocal_bother : PR.relax.order_default,
  };
  return { policy, user, explain, meta };
}

// ── 안전 확인 (§2.2 7단계 · §11 B) ─────────────────────────
/* 경로 모양 — 엔진 작업 좌표(trace 의 song_V/A · wp_V/A). 정의는 iso_path_quality.mjs(20260926) 와 같다:
   역행 = 이동 구간에서 목표와의 거리가 앞 곡보다 reversal_eps 넘게 멀어진 걸음, 꺾임 = 연속 두 걸음이 둘 다 turn_min 넘게
   움직이며 90° 넘게 방향을 바꿈, 머묾 지그재그 = 머묾 구간의 마지막 곡이 가장 가깝지 않음.
   문턱은 rules.personalization.safety.envelope 에서 읽는다. 명세 §9.2 의 한 인자 호출 pathMetrics(result) 도 받는다 —
   그때는 같은 값의 명세 보충값(SPEC_FALLBACK)을 쓴다(통합 때 추가). */
export function pathMetrics(result, rules = null) {
  const { wp_step, rev_x, ...m } = pathShapeFull(result, rules);   // 공개 모양(§7.1 Metrics)은 그대로
  return m;
}
/* pathMetrics + 안전 확인 전용 두 값: wp_step = 가장 긴 경유지 걸음(경로 모수가 정한 의도된 이동), rev_x = 역행 걸음마다 멀어진 거리 */
function pathShapeFull(result, rules) {
  const PR = rules && rules.personalization && typeof rules.personalization === "object" ? rules.personalization : null;
  const back = ruleOr(PR, "safety.envelope.reversal_eps"), turnMin = ruleOr(PR, "safety.envelope.turn_min");
  const seq = ((result && result.sequence) || []).filter((x) => x && x.trace);
  const n = seq.length;
  if (!n) return { arrival: null, max_jump: null, reversals: 0, turns: 0, n: 0, hold_zigzag: null, start_dist: null, wp_step: null, rev_x: [] };
  const c = seq.map((x) => [Number(x.trace.song_V), Number(x.trace.song_A)]);
  const wp = seq.map((x) => [Number(x.trace.wp_V), Number(x.trace.wp_A)]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const t = wp[n - 1];
  let hs = n - 1;
  while (hs > 0 && d(wp[hs - 1], t) < EPS) hs--;   // 머묾 구간 시작(경유지 = 목표)
  let rev = 0, turns = 0, maxJ = 0, wpStep = 0;
  const revX = [];
  for (let i = 1; i < n; i++) {
    maxJ = Math.max(maxJ, d(c[i], c[i - 1]));
    wpStep = Math.max(wpStep, d(wp[i], wp[i - 1]));
    if (i <= hs && d(c[i], t) > d(c[i - 1], t) + back) { rev++; revX.push(R6(d(c[i], t) - d(c[i - 1], t))); }
    if (i + 1 < n) {
      const u = [c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]], v = [c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]];
      if (Math.hypot(...u) > turnMin && Math.hypot(...v) > turnMin && u[0] * v[0] + u[1] * v[1] < 0) turns++;
    }
  }
  const hold = c.slice(hs);
  return {
    arrival: R6(d(c[n - 1], t)), max_jump: R6(maxJ), reversals: rev, turns, n,
    hold_zigzag: hold.length >= 2 ? d(hold[hold.length - 1], t) > Math.min(...hold.map((p) => d(p, t))) + EPS : null,
    start_dist: R6(d(c[0], wp[0])), wp_step: R6(wpStep), rev_x: revX,
  };
}
/* 경로 모수(두 레인 I3 — 경유지를 바꾸는 값). 정책 A 와 기준 정책에서 이 값이 모두 같으면 R_path ≡ R, A′ ≡ A 이다. */
export const PATH_PARAM_KEYS = ["tp", "quit_frac", "start_offset", "hold_radius", "hold_min_pool"];   // hold_min_pool 은 r 에서 정해진다(좁힌 팔은 0)
export function pathParamsDiffer(polA, polRef) {
  return !!polA && !!polRef && PATH_PARAM_KEYS.some((k) => (polA[k] ?? null) !== (polRef[k] ?? null));
}
/* 한 레인 비교 — X 가 기준 ref 보다 봉투만큼 나쁜가(ref 가 없으면 절대 기준만).
   도착·최대 전환: 절대 기준을 넘고 '그리고' ref 보다 over_ref 넘게 나쁠 때. path(경로 레인: R_path vs R)이면 최대 전환에서
   경유지 걸음이 늘어난 만큼(× path_wp_step_allow)은 경로 모수의 의도로 본다 — 학습 tp 는 bounds.tp[0] = manual_tp.fast 이상이라
   늘어난 걸음은 수동 '빠르게' 이하다. 역행: reversal_eps + reversal_tol 을 넘은 걸음 수가 ref 의 역행 수보다 많을 때.
   머묾 지그재그는 언제나, 곡 수가 ref 보다 적으면(작은 풀 폴백 실패). */
function laneViolations(X, ref, env, { path = false } = {}) {
  const v = [];
  const hasR = !!(ref && ref.n);
  if (!X || !X.n) { if (hasR) v.push("empty"); return v; }
  const allow = path && hasR ? Math.max(0, X.wp_step - ref.wp_step) * env.path_wp_step_allow : 0;
  if (X.arrival > env.arrival_abs && (!hasR || X.arrival > ref.arrival + env.arrival_over_ref)) v.push("arrival");
  if (X.max_jump > env.max_jump_abs && (!hasR || X.max_jump > ref.max_jump + allow + env.max_jump_over_ref)) v.push("max_jump");
  if (X.rev_x.filter((x) => x > env.reversal_eps + env.reversal_tol).length > (hasR ? ref.reversals : 0)) v.push("reversal");
  if (X.hold_zigzag === true) v.push("hold_zigzag");
  if (hasR && X.n < ref.n) v.push("short");
  return v;
}
/* 안전 확인(§2.2 7단계) — 기준 두 개(2026-09-29 변경).
   R      = p0 (경로·곡 레인 모두 P0)
   R_path = 곡 레인 P0 + A 의 경로 모수 (resolvePolicy mode "path"). 경유지가 A 와 같다(I3).
   ① A 가 R 에 대해 봉투 안이면 통과 — 이전과 같은 판정(resRp 를 주지 않으면 여기서 끝: 위반이면 lane "song").
   ② 아니면 경로 레인: R_path 가 R 에 대해 봉투 안인가(경유지 걸음 증가분 허용). 밖이면 lane "path"(위반 이름 앞에 path_) → 앱은 A′(geometry).
   ③ 경로 레인이 안이면 곡 레인: A 가 R_path 에 대해 봉투 안인가. 안이면 통과(①의 위반은 경로 모수의 의도된 효과), 밖이면 lane "song".
   반환 A·R·Rp 는 공개 pathMetrics 모양(§7.1 Metrics). */
export function safetyCheck(resA, resR, rules, { resRp = null } = {}) {
  const PRc = cfg(rules), e = PRc.safety.envelope;
  const env = { ...e, reversal_eps: ruleOr(PRc, "safety.envelope.reversal_eps"),
                reversal_tol: num(e.reversal_tol) ? e.reversal_tol : 0, path_wp_step_allow: num(e.path_wp_step_allow) ? e.path_wp_step_allow : 0 };
  const A = resA ? pathShapeFull(resA, rules) : null;
  const R = resR ? pathShapeFull(resR, rules) : null;
  const Rp = resRp ? pathShapeFull(resRp, rules) : null;
  const pub = (m) => { if (!m) return null; const { wp_step, rev_x, ...x } = m; return x; };
  const done = (violations, lane) => ({ ok: violations.length === 0, violations, lane, A: pub(A), R: pub(R), Rp: pub(Rp) });
  const v0 = laneViolations(A, R, env);
  if (!v0.length) return done([], null);
  if (!Rp) return done(v0, "song");
  const vp = laneViolations(Rp, R, env, { path: true });
  if (vp.length) return done(vp.map((x) => `path_${x}`), "path");
  const vs = laneViolations(A, Rp, env);
  return done(vs, vs.length ? "song" : null);
}

// ── 로그 문서 (§7.1) ──────────────────────────────────────
const nz = (x) => (x === undefined ? null : x);
function phaseOfRow(row, lastWp) {
  const t = row.trace || {};
  if (t.p_phase === "move" || t.p_phase === "hold") return t.p_phase;
  if (lastWp && num(t.wp_V) && num(t.wp_A)) return Math.abs(t.wp_V - lastWp[0]) < EPS && Math.abs(t.wp_A - lastWp[1]) < EPS ? "hold" : "move";
  return null;
}
/* buildRecLog — 앱이 user_id·is_anonymous·created_at·algorithm_version 을 붙인다.
   resA = 실제로 보여 준 결과(폴백 뒤), resR = 기준 실행 R, policyOut = 개인 resolvePolicy 결과.
   usedOut(선택) = 최종 결과를 만든 resolvePolicy 결과(폴백 geometry 면 A′), refOut(선택) = p0 결과 — fallback "p0" 이면 그것을 쓴 것으로 적는다.
   ctx.log_extra(선택) = 기존 필드(filters·nl_text·nl_model·nl_v2·personalization 등) — 그대로 input 에 싣는다. */
export function buildRecLog({ ctx = {}, policyOut = null, resA = null, resR = null, extras = null, safety = null, fallback = null,
                              env = {}, catalogIndex = null, rules, usedOut = null, refOut = null } = {}) {
  const PR = cfg(rules);
  ctx = ctx || {};
  const idx = catalogIndex ? ensureIndex(catalogIndex, rules) : null;
  const labels = ctx.labels || {};
  const stress = ctx.now ? stressOf(ctx.now, rules) : null;
  const used = usedOut || (fallback === "p0" && refOut ? refOut : policyOut);
  const minutes = num(ctx.minutes) ? ctx.minutes : null;
  const paceUser = ctx.pace_user === "fast" || ctx.pace_user === "slow" ? ctx.pace_user : null;

  let personalPolicy = null, meta = null, userAff = null;
  if (used && used.policy) {
    const sp = sanitizePersonal(used.policy, rules, { duration_min: minutes ?? Number(rules.inputs.duration_min.default), pace: paceUser });
    personalPolicy = sp ? JSON.parse(JSON.stringify(sp)) : null;
    const m = used.meta || {};
    const aIds = resA && resA.sequence ? resA.sequence.map((x) => x.song_id) : [];
    const rIds = resR && resR.sequence ? resR.sequence.map((x) => x.song_id) : [];
    const rSet = new Set(rIds);
    meta = {
      schema: SCHEMAS.meta, personal_version: PERSONAL_VERSION,
      engine_version: nz(resA && resA.engine_version), rules_hash: rules.rules_hash ?? null,
      model_digest: m.model_digest ?? used.policy.model_digest ?? null,
      policy_digest: (personalPolicy && personalPolicy.digest) || used.policy.digest || null,
      as_of_ms: m.as_of_ms ?? null, cursor: m.cursor || { last_event_ms: null, last_rec_ms: null },
      evidence: m.evidence || null, params: m.params || null,
      fallback: fallback ?? null,
      safety: safety ? { A: safety.A ?? null, R: safety.R ?? null, Rp: safety.Rp ?? null, lane: safety.lane ?? null, violations: safety.violations || [] }
                     : { A: resA ? pathMetrics(resA, rules) : null, R: resR ? pathMetrics(resR, rules) : null, Rp: null, lane: null, violations: [] },
      reference_ids: rIds,
      changed_n: resR ? aIds.filter((id) => !rSet.has(id)).length : 0,
      explain_codes: m.explain_codes || (used.explain || []).map((c) => c.id),
      catalog_n: idx ? idx.n : null, catalog_digest: idx ? idx.digest : null,
      global_stats_digest: ctx.global_stats_digest ?? null,
    };
    userAff = compressAffinity(used.user);
  }

  let calibApplied = ctx.calib_applied || null;
  if (!calibApplied) {
    const pc = meta && meta.params && meta.params.calib;
    calibApplied = { current: pc && pc.current ? { dv: pc.current.dv, de: pc.current.de } : null,
                     target: pc && pc.target ? { dv: pc.target.dv, de: pc.target.de } : null };
  }
  const modeOf = (l) => (l && isStr(l.mode) ? l.mode : null);
  const input = {
    // 기존 필드 (fix-web 과 같은 이름) — 앱이 log_extra 로 덮어쓸 수 있다
    lyric_preference: ctx.lyric ?? null, genres: Array.isArray(ctx.genres) ? ctx.genres : [], recommend_minutes: minutes,
    current_va: R3pt(validPt(ctx.now)), target_va: R3pt(validPt(ctx.target)),
    input_mode: { current: modeOf(labels.current), target: modeOf(labels.target) },
    pace_mode: paceUser || "auto",
    ...(ctx.log_extra && typeof ctx.log_extra === "object" ? ctx.log_extra : {}),
    // 새 필드 (§7.1)
    app: env.app || "web-personal", env: env.env || "prod",
    seed: ctx.seed ?? null, session_no: ctx.session_no ?? null,
    effective: ctx.effective || { lyric: ctx.lyric ?? null, genres: Array.isArray(ctx.genres) ? ctx.genres : [], minutes },
    minutes_base: ctx.minutes_base ?? null, minutes_suggested: ctx.minutes_suggested ?? null,
    relaxed: ctx.relaxed ?? null,
    pace_user: paceUser,
    stress, high_stress: stress !== null && stress >= PR.safety.high_stress_min,
    labels: { current: labels.current ?? null, target: labels.target ?? null },
    table_point: { current: R3pt(validPt(ctx.now_table)), target: R3pt(validPt(ctx.target_table)) },
    calib_applied: calibApplied,
    nudged: { current: !!(ctx.nudged && ctx.nudged.current), target: !!(ctx.nudged && ctx.nudged.target) },
    personal_policy: personalPolicy,
    personal_meta: meta,
    user_affinity: userAff,
  };

  // 시퀀스 — 경로 행 + 더 들을 곡 행
  const seq = (resA && resA.sequence) || [];
  const lastT = seq.length ? seq[seq.length - 1].trace || {} : {};
  const lastWp = num(lastT.wp_V) && num(lastT.wp_A) ? [lastT.wp_V, lastT.wp_A] : null;
  const rows = seq.map((x, i) => {
    const t = x.trace || {};
    return {
      song_id: x.song_id, position: i + 1, role: "path",
      fit: nz(t.va_distance), band_size: nz(t.band_size), chosen_by: nz(t.chosen_by), pref_score: nz(t.pref_score),
      pref_match: t.pref_match === undefined ? null : !!t.pref_match, pref_basis: t.pref_basis || null, quadrant: nz(t.quadrant),
      wp_V: nz(t.wp_V), wp_A: nz(t.wp_A), song_V: nz(t.song_V), song_A: nz(t.song_A),
      phase: phaseOfRow(x, lastWp),
      p_pmarg: nz(t.p_pmarg), p_pers: nz(t.p_pers), p_adj: nz(t.p_adj), p_adj_x: nz(t.p_adj_x), p_bpm_diff: nz(t.p_bpm_diff),
      p_geo_best: nz(t.p_geo_best), p_chosen_by: nz(t.p_chosen_by),
      discovery: t.p_discovery === true, replay: t.p_replay === true, soft_relaxed: t.p_soft_relaxed === true,
    };
  });
  const ex = Array.isArray(extras) ? extras : extras && Array.isArray(extras.extras) ? extras.extras : [];
  ex.forEach((x, j) => {
    const t = x.trace || {};
    rows.push({ song_id: x.song_id, position: seq.length + j + 1, role: "extra", phase: "extra",
                fit: nz(t.va_distance), song_V: nz(t.song_V), song_A: nz(t.song_A),
                p_pmarg: nz(t.p_pmarg), p_pers: nz(t.p_pers), p_adj: nz(t.p_adj), p_adj_x: nz(t.p_adj_x) });
  });
  return { input, sequence: rows };
}

// ── 이벤트 모양 검사 (§7.2) ────────────────────────────────
const isInt = (x) => Number.isInteger(x);
const isPosInt = (x) => Number.isInteger(x) && x >= 1;
const isNonNeg = (x) => num(x) && x >= 0;
const isUnit = (x) => num(x) && x >= 0 && x <= 1;
const isBool = (x) => typeof x === "boolean";
const KNOWN_TYPES = ["track_exit", "like", "dislike", "dislike_reason", "post_change", "pace_choice", "calib_reset", "auto_gate_off",
  "personal_reset", "personal_toggle", "compare_view", "track_complete", "track_skip", "spotify_click", "sequence_play_start",
  "sequence_complete", "track_autoplay_failed", "seek", "playlist_add", "track_milestone", "track_transition_trace"];
export function validateEvent(type, payload) {
  const errors = [];
  if (!isStr(type)) return { ok: false, errors: ["type: 문자열이어야 합니다"] };
  const p = payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, errors: ["payload: 객체여야 합니다"] };
  const need = (k, ok, what) => { if (!ok(p[k])) errors.push(`${k}: ${what}`); };
  const opt = (k, ok, what) => { if (p[k] !== undefined && p[k] !== null && !ok(p[k])) errors.push(`${k}: ${what}`); };
  const oneOf = (xs) => (x) => xs.includes(x);
  // 공통 — web-personal 이 쓰는 모든 이벤트
  need("app", (x) => x === "web-personal", '"web-personal" 이어야 합니다');
  need("env", oneOf(["prod", "local", "demo"]), "prod|local|demo");
  need("client_id", isStr, "문자열(rec_id|type|song_id|순번)");
  if (!KNOWN_TYPES.includes(type)) errors.push(`type: 알 수 없는 이벤트 "${type}"`);
  const roles = oneOf(["path", "extra"]);
  switch (type) {
    case "track_exit":
      need("song_id", isStr, "문자열"); need("position", isPosInt, "1 이상 정수(시퀀스 위치)"); opt("queue_pos", isInt, "정수|null");
      need("role", roles, "path|extra"); need("instance", isPosInt, "1 이상 정수"); need("started", isBool, "불리언");
      need("listened_s", isNonNeg, "0 이상 수"); opt("duration_s", isNonNeg, "0 이상 수|null"); opt("catalog_s", isNonNeg, "0 이상 수|null");
      need("completion", isUnit, "0~1"); need("preview", isBool, "불리언"); need("cause", oneOf(CAUSES), CAUSES.join("|"));
      opt("prev_song_id", isStr, "문자열|null"); opt("prev_completion", isUnit, "0~1|null");
      opt("bg_credit_s", isNonNeg, "0 이상 수"); opt("seek_fwd_s", isNonNeg, "0 이상 수");
      opt("liked", isBool, "불리언"); opt("disliked", isBool, "불리언"); opt("recovered", isBool, "불리언");
      if (p.cause === "autoplay_fail" && p.started === true) errors.push("started: autoplay_fail 이면 false");
      break;
    case "like": case "dislike":
      need("song_id", isStr, "문자열"); need("on", isBool, "불리언(켬/끔, B13)"); opt("position", isPosInt, "1 이상 정수|null"); opt("role", roles, "path|extra");
      break;
    case "dislike_reason":
      need("song_id", isStr, "문자열"); need("reason", oneOf(REASONS), REASONS.join("|")); opt("position", isPosInt, "1 이상 정수|null");
      opt("role", roles, "path|extra"); opt("phase", oneOf(["move", "hold", "extra"]), "move|hold|extra");
      break;
    case "post_change":
      need("change", (x) => isInt(x) && x >= -2 && x <= 2, "−2~+2 정수"); need("touched", isBool, "불리언(B17)");
      opt("pace_answer", (x) => has(PACE_ANSWERS, x), "faster|ok|slower|null"); opt("length_dir", oneOf(["long", "short"]), "long|short|null");
      opt("rec_id", isStr, "문자열"); opt("heard", (x) => typeof x === "object" && !Array.isArray(x) && Object.values(x).every(isNonNeg), "{ song_id: 초 }");
      opt("misfit_reasons", (x) => Array.isArray(x) && x.every(isStr), "문자열 배열");
      opt("reasons_source", (x) => typeof x === "object" && Object.values(x).every(oneOf(["user", "ai"])), "{ code: user|ai }");
      opt("ai_codes_removed_by_user", (x) => Array.isArray(x) && x.every(isStr), "문자열 배열");
      opt("end_va", (x) => !!validPt(x), "{v,e}|null");
      break;
    case "pace_choice":
      opt("choice", oneOf(["fast", "slow"]), "fast|slow|null"); opt("suggested", num, "수|null"); need("source", (x) => x === "user", '"user"');
      break;
    case "calib_reset": need("field", oneOf(["current", "target"]), "current|target"); opt("label", isStr, "문자열|null"); break;
    case "auto_gate_off": need("gate", isStr, "문자열"); break;
    case "personal_reset": need("procedure", isStr, "문자열"); break;
    case "personal_toggle": need("on", isBool, "불리언"); break;
    case "compare_view": need("changed_n", (x) => isInt(x) && x >= 0, "0 이상 정수"); break;
    case "track_complete": need("song_id", isStr, "문자열"); opt("position", isPosInt, "1 이상 정수"); opt("completion_rate", isUnit, "0~1"); break;
    case "track_skip":
      need("song_id", isStr, "문자열"); need("direction", oneOf(["next", "prev", "jump"]), "next|prev|jump"); opt("position", isPosInt, "1 이상 정수");
      opt("listened_s", isNonNeg, "0 이상 수"); opt("completion", isUnit, "0~1"); opt("started", isBool, "불리언");
      break;
    case "track_autoplay_failed": case "spotify_click": case "sequence_play_start": case "seek": case "playlist_add": case "track_milestone":
      need("song_id", isStr, "문자열"); break;
    default: break;
  }
  return { ok: errors.length === 0, errors };
}

// ── 설명 (§4.12.3) — 횟수로 말한다 ──────────────────────────
const josa = (w, a, b) => { const ch = String(w).charCodeAt(String(w).length - 1); return ch >= 0xac00 && ch <= 0xd7a3 && (ch - 0xac00) % 28 !== 0 ? a : b; };
const signed = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2);
const FEAT_WORD_VA = "분위기 거리";   // va 는 학습 전용 특징이라 규칙의 feature_labels 에 없다
const featWord = (PR, f) => (f === "va" ? FEAT_WORD_VA : ((PR.adjacency && PR.adjacency.feature_labels) || {})[f] || f);
function calibWords(dv, de) {
  const main = Math.abs(de) >= Math.abs(dv) ? "e" : "v";
  const dir = main === "e" ? (de < 0 ? "조금 더 가라앉은 쪽" : "조금 더 들뜬 쪽") : (dv < 0 ? "조금 더 어두운 쪽" : "조금 더 밝은 쪽");
  const parts = [];
  if (Math.abs(dv) >= 0.005) parts.push("기분 " + signed(dv));   // 표시 반올림(소수 둘째 자리) 아래는 적지 않는다
  if (Math.abs(de) >= 0.005) parts.push("활력 " + signed(de));
  return { dir, axes: parts.join(" · ") };
}
function paceCountText(model) {
  const c = (model.counts_for_explain && model.counts_for_explain.pace) || {};
  const W = { fast: "‘빠르게’", slow: "‘천천히’", faster: "‘더 빨리’", ok: "‘딱 좋았어요’", slower: "‘더 천천히’" };
  const parts = Object.keys(W).filter((k) => c[k] > 0).map((k) => `${W[k]} ${c[k]}번`);
  return parts.length ? parts.join(" · ") + " 기준" : "";
}
function quitK(f, n, PR) { return Math.max(ruleOr(PR, "pace.quit_guard.min_arrival_song"), Math.floor(f * n)); }
/* 엔진 arrivalAt 과 같은 순서(자동 tp → 이탈 가드 상한 → n ≤ 3 보호 → 고긴장 하한) — 설명의 '도착 곡 번호'용. n 은 시간 기준 곡 수 */
function mirrorArrivalAt(rules, minutes, n, policy) {
  const PR = cfg(rules);
  const atDef = transitionAt(rules, minutes);
  let at = policy.tp != null ? policy.tp : atDef, personalized = policy.tp != null;
  if (policy.quit_frac != null && n > 1) {
    const cap = Math.max(PR.bounds.tp[0], (quitK(policy.quit_frac, n, PR) - 1) / (n - 1));
    if (at > cap) { at = cap; personalized = true; }
  }
  if (personalized && n <= PR.pace.small_n_max) at = Math.max(at, PR.pace.small_n_min_tp);
  if (policy.high_stress && !PR.safety.high_stress.faster_pace_allowed) at = Math.max(at, atDef);
  return at;
}
function strongestAdj(model) {
  const A = model.adjacency;
  let best = null;
  for (const f of FEATS) if (A.applied[f] && A.m[f] !== 1 && (!best || Math.abs(Math.log(A.m[f])) > Math.abs(Math.log(A.m[best])))) best = f;
  return best;
}
/* 설명·패널의 "근거 N번"은 횟수로 말한다(명세 §4.12.3) — 가중 합(E, 청취 표 ¼ 등)은 확신 점에만 쓴다.
   취향 근거 횟수 = 좋아요 + 취향 싫어요 + 벽 곡 + 벽 가수 + 끝까지 들음 + 넘김 */
function tasteCount(model) {
  const t = (model.counts_for_explain && model.counts_for_explain.taste) || {};
  return ["likes", "dislikes_taste", "pins_song", "pins_artist", "completes", "skips"].reduce((a, k) => a + (Number(t[k]) || 0), 0);
}
const countOf = (x) => (num(x) ? Math.round(x) : 0);
function tasteText(model) {
  const t = (model.counts_for_explain && model.counts_for_explain.taste) || {};
  const g = t.groups && t.groups.top && t.groups.top[0];
  const cnt = [];
  const src = g || t;
  if (src.likes) cnt.push(`좋아요 ${src.likes}`);
  if (src.completes) cnt.push(`끝까지 ${src.completes}`);
  if (src.pins || src.pins_song || src.pins_artist) cnt.push(`벽 ${(src.pins || 0) + (src.pins_song || 0) + (src.pins_artist || 0)}`);
  return `${g ? g.label + " 취향" : "내 기록"} 반영${cnt.length ? " (" + cnt.join(" · ") + ")" : ""}`;
}

/* 결과 상단 "이번 추천에 반영된 나" — 칩 ≤ 3, 기본값에서 벗어난 것만, 고정 우선순위
   (속도 → [시작점] → 좌표 보정 → 연결 → 취향[·발견] → 게이트 → 다양성 → 머묾). ctx(선택)를 주면 도착 곡 번호·이번 단어 보정까지 말한다. */
export function explainPolicy(policy, model, rules, ctx = null) {
  if (!policy) return [];
  const PR = cfg(rules);
  model = model || emptyModel(rules);
  const chips = [];
  const push = (id, text, procedure) => chips.push({ id, text, procedure });
  const minutes = ctx && num(ctx.minutes) && ctx.minutes > 0 ? ctx.minutes : null;
  const n = minutes !== null ? songCount(rules, minutes) : null;
  // 1) 속도 · 이탈 가드
  if (policy.tp != null) {
    const atDef = minutes !== null ? transitionAt(rules, minutes) : null;
    const faster = atDef !== null ? policy.tp < atDef : model.pace.pi > 0;
    const k = n ? arrivalIndex(n, mirrorArrivalAt(rules, minutes, n, policy)) : null;
    const cnt = paceCountText(model);
    push("pace", `${faster ? "빠르게" : "천천히"} 도착${k ? ` · ${k}번째 곡` : ""}${cnt ? ` (${cnt})` : ""}`, "pace");
  }
  if (policy.quit_frac != null) {
    const K = n ? quitK(policy.quit_frac, n, PR) : null;
    push("quit_guard", K ? `보통 ${K}번째 곡쯤에서 멈추셔서 그 전에 목표에 닿게 했어요`
                         : `보통 경로의 ${Math.round(policy.quit_frac * 100)}%쯤에서 멈추셔서 그 전에 목표에 닿게 했어요`, "pace");
  }
  // 2) 시작점
  if (policy.start_offset > 0) {
    const c = (model.counts_for_explain && model.counts_for_explain.start) || {};
    push("start", `첫 곡을 자주 넘기셔서(첫 곡 ${c.first_n || 0}번 중 ${c.first_rej || 0}번) 한 걸음 목표 쪽에서 시작해요`, "start");
  }
  // 3) 좌표 보정 — 이번에 고른 단어에 보정이 걸렸을 때
  if (ctx && ctx.labels) for (const field of ["current", "target"]) {
    const r = calibratePoint(model, field, ctx.labels, field === "current" ? ctx.now_table : ctx.target_table, rules);
    if (!r.applied || !r.basis) continue;
    const w = calibWords(r.applied.dv, r.applied.de);
    push("calib_" + field, `‘${r.basis.label}’ 내 기준 위치로 (${w.axes} · 직접 옮김 ${r.basis.n_edit}번)`, "calib:" + field);
  }
  // 4) 연결
  const band = Number(rules.preference.band), A = PR.adjacency;
  const adjChanged = ADJ_FEATS.some((f) => Math.abs(policy.adj_w[f] - band * A.base_weights_bands[f] * A.scale) > EPS)
    || Math.abs(policy.lambda - Number(rules.path.jump_weight || 0)) > EPS;
  const sf = strongestAdj(model);
  if (adjChanged && sf) {
    const c = model.counts_for_explain.adjacency[sf];
    const m = model.adjacency.m[sf];
    push("adjacency", m > 1 ? `${featWord(PR, sf)} 흐름을 ${m.toFixed(1)}배 신경 써서 이어요 (크게 바뀐 뒤 ${c.large_n}번 중 ${c.large_y}번 넘김)`
                            : `${featWord(PR, sf)} 변화는 덜 신경 써서 이어요 (크게 바뀐 뒤 ${c.large_n}번 중 ${c.large_y}번 넘김)`, "adjacency");
  }
  // 5) 취향 · 발견
  if (policy.mu > 0 && model.taste.E > 0) push("taste", tasteText(model), "taste");
  if (policy.discovery_u != null) push("discovery", "아직 안 들어본 가수의 곡도 한 곡 넣어 봐요", "discovery");
  // 6) 게이트
  if ((policy.soft_gates || []).length) {
    const vn = countOf(model.gates.evidence.vocal_bother_n);
    push("gate_spoken", `말 많은 곡은 빼고 골랐어요${vn > 0 ? ` — ‘가사·목소리가 거슬려요’ ${vn}번` : ""}`, "gates");
  }
  // 7) 다양성
  const maxCap = Number(rules.diversity.max_per_artist);
  const winChanged = model.diversity.recent_window !== PR.diversity.recent_window;
  if (policy.artist_cap < maxCap || winChanged || (policy.replay_ids || []).length) {
    const repN = countOf(model.diversity.repetitive_sessions_n);
    const bits = [];
    if (winChanged) bits.push(`최근 ${model.diversity.recent_window}곡 쉬기`);
    if (policy.artist_cap < maxCap) bits.push(`같은 가수 ${policy.artist_cap}곡까지`);
    if ((policy.replay_ids || []).length) bits.push("좋아요한 곡 오랜만에 다시 넣기");
    push("diversity", bits.join(" · ") + (repN > 0 ? ` (‘너무 자주 나와요’ ${repN}번)` : ""), "diversity");
  }
  // 8) 머묾
  if (Math.abs(policy.hold_radius - PR.hold.p0_radius) > EPS && Math.abs(model.hold.arm - PR.hold.p0_radius) > EPS) {   // 학습한 계단일 때만(중립·고긴장 상한 제외)
    push("hold", policy.hold_radius < PR.hold.p0_radius ? "끝 분위기가 달랐다는 기록이 있어 마지막 곡들을 목표에 더 가깝게 모았어요"
                                                         : "도착 뒤 같은 곡이 반복된다는 기록이 있어 목표 근처에서 더 넓게 골랐어요", "hold");
  }
  return chips.slice(0, 3);
}

/* 내 방 "내 취향 모델" 패널 (§4.12.3) — 카드마다 한 줄 문장 · 근거 횟수 · 확신 점(1~5) · 기본값 · 지난 추천 이후 바뀜 · 추이 · 초기화 */
export function explainModel(model, rules, { history } = {}) {
  const PR = cfg(rules);
  model = model || emptyModel(rules);
  const H = (Array.isArray(history) ? history : model.history || []).filter((h) => h && h.params).slice()
    .sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));
  const last = H.length ? H[H.length - 1].params : null;
  const series = (fn) => H.map((h) => ({ at_ms: h.at_ms ?? null, value: nz(fn(h.params)) }));
  const dots = (x) => 1 + Math.round(4 * clamp(num(x) ? x : 0, 0, 1));   // 1~5 점
  const differs = (a, b) => (num(a) && num(b) ? Math.abs(a - b) > 1e-3 : canon(a) !== canon(b));
  const cards = [];
  const card = (c) => cards.push({ evidence: 0, confidence: 1, is_default: true, changed: false, series: [], ...c });
  const C = PR.calib;
  const cx = model.counts_for_explain || {};

  // 기분 해석 · 목표 해석
  for (const field of ["current", "target"]) {
    const M = model.calib[field];
    const applied = Object.entries(M.labels || {}).filter(([, r]) => r.applied && (Math.abs(r.dv) > EPS || Math.abs(r.de) > EPS))
      .sort((a, b) => b[1].n_edit - a[1].n_edit || (a[0] < b[0] ? -1 : 1));
    const top = applied[0];
    let text;
    if (top) {
      const [label, r] = top, w = calibWords(r.dv, r.de);
      text = field === "current"
        ? `‘${label}’${josa(label, "을", "를")} 고르시면 보통 ${w.dir}(${w.axes})으로 옮기셔서 거기서 시작해요 — 직접 옮기신 ${r.n_edit}번 기준.`
        : `‘${label}’ 목표를 평소 옮기시던 곳(${w.axes})에 두어요 — 직접 옮기신 ${r.n_edit}번 기준.`;
    } else {
      text = field === "current" ? "고른 기분 단어의 원래 위치에서 시작해요. 점을 끌어 옮기시면 다음부터 반영해요."
                                 : "고른 목표 단어의 원래 위치로 가요. 목표는 직접 옮기신 만큼만 바뀌어요.";
    }
    const maxW = Math.max(0, ...Object.values(M.labels || {}).map((r) => r.W));
    card({ id: "calib_" + field, title: field === "current" ? "기분 해석" : "목표 해석", text, evidence: M.n_edit,
           confidence: dots(maxW / (maxW + C.k_label)), is_default: !top,
           series: series((p) => (p.calib && p.calib[field] ? p.calib[field].de ?? null : null)), reset_procedure: "calib:" + field });
  }

  // 여정 속도
  {
    const P = model.pace, applied = Math.abs(P.pi) >= PR.pace.apply_abs, cnt = paceCountText(model);
    const qf = P.quit && P.quit.f_med;
    const quitOn = num(qf) && qf < PR.pace.quit_guard.apply_below;
    let text = applied ? `자동(나에게 맞춤): ${P.pi > 0 ? "빠르게" : "천천히"}${cnt ? " — " + cnt : ""}` : `기본 속도로 도착해요${cnt ? " — " + cnt : ""}`;
    if (quitOn) text += ` · 보통 경로의 ${Math.round(qf * 100)}%쯤에서 멈추셔서 그 전에 목표에 닿게 해요`;
    card({ id: "pace", title: "여정 속도", text, evidence: P.votes, confidence: dots(P.W / (P.W + PR.pace.k0)), is_default: !applied && !quitOn,
           changed: !!last && differs(R3(P.pi), R3(Number(last.pi) || 0)), series: series((p) => p.pi), reset_procedure: "pace" });
  }
  // 첫 곡
  {
    const S = model.start, c = cx.start || {};
    const text = S.arm > 0 ? `첫 곡을 자주 넘기셔서(첫 곡 ${c.first_n || 0}번 중 ${c.first_rej || 0}번) 지금 기분에서 한 걸음 목표 쪽에서 시작해요.`
                           : `첫 곡은 지금 기분 그대로에서 시작해요${c.first_n ? ` (첫 곡 ${c.first_n}번 중 ${c.first_rej || 0}번 넘김)` : ""}.`;
    card({ id: "start", title: "첫 곡", text, evidence: S.n1, confidence: dots(S.n1 / (S.n1 + PR.start.min_first_songs)), is_default: S.arm === PR.start.arms[0],
           changed: !!last && differs(S.arm, Number(last.start_arm) || 0), series: series((p) => p.start_arm), reset_procedure: "start" });
  }
  // 여정 길이
  {
    const L = model.length, c = cx.length || {};
    const sug = suggestMinutes(model, L.base_minutes, rules);
    const cnt = [c.long ? `‘길었어요’ ${c.long}번` : "", c.short ? `‘짧았어요’ ${c.short}번` : ""].filter(Boolean).join(" · ");
    card({ id: "length", title: "여정 길이", text: `여정 길이: 보통 ${sug.minutes}분${cnt ? " — " + cnt : ""}`,
           evidence: (c.long || 0) + (c.short || 0), confidence: dots(L.W / (L.W + PR.length.k0)), is_default: !sug.applied,
           changed: !!last && differs(sug.applied ? R3(sug.bias_log2) : 0, R3(Number(last.minutes_bias) || 0)),
           series: series((p) => p.minutes_bias), reset_procedure: "length" });
  }
  // 도착 구간
  {
    const Hd = model.hold, p0 = PR.hold.p0_radius;
    const text = Hd.arm < p0 ? "끝 분위기가 원한 것과 달랐다는 기록이 있어 마지막 곡들을 목표에 더 가깝게 모아요."
      : Hd.arm > p0 ? "도착 뒤 같은 곡이 반복된다는 기록이 있어 목표 근처에서 더 넓게 골라요."
      : "목표에 닿은 뒤에는 목표 가까이에서 여러 곡을 골라 머물러요.";
    const ev = (Hd.arrival_w || 0) + (Hd.repetitive_w || 0);   // 가중 합 — 확신 점에만
    card({ id: "hold", title: "도착 구간", text, evidence: countOf(Hd.arrival_n) + countOf(Hd.repetitive_n),
           confidence: dots(ev / (ev + PR.hold.arrival_mismatch_min)), is_default: Hd.arm === p0,
           changed: !!last && differs(Hd.arm, Number(last.hold_arm)), series: series((p) => p.hold_arm), reset_procedure: "hold" });
  }
  // 곡 취향
  {
    const T = model.taste, t = cx.taste || {}, g = t.groups || { top: [], bottom: [] };
    const lvl = dots(T.mu / PR.taste.mu_max);
    const strength = lvl <= 2 ? "약함" : lvl === 3 ? "중간" : "강함";
    const fmt = (r) => [r.label, r.likes ? `좋아요 ${r.likes}` : "", r.completes ? `끝까지 들음 ${r.completes}` : "", r.skips ? `넘김 ${r.skips}` : "", r.pins ? `벽 ${r.pins}` : ""].filter(Boolean).join(" · ");
    const text = T.E > 0 ? `취향 반영 강도: ${strength} (기록 ${t.n_items || 0}곡)` + (g.top.length ? ` — 더 고르는 쪽: ${g.top.map((r) => r.label).join(", ")}` : "")
                         : "아직 기록이 없어 기본 순서로 골라요. 좋아요·끝까지 듣기가 쌓이면 반영해요.";
    card({ id: "taste", title: "곡 취향", text, evidence: tasteCount(model), confidence: dots(T.E / (T.E + PR.taste.k_mu)), is_default: !(T.E > 0),
           changed: !!last && differs(R3(T.mu), R3(Number(last.mu) || 0)), series: series((p) => p.mu), reset_procedure: "taste",
           detail: { top: g.top.map(fmt), bottom: g.bottom.map(fmt), strength } });
  }
  // 곡 사이 연결
  {
    const A = model.adjacency, sf = strongestAdj(model);
    let text;
    if (sf) {
      const c = cx.adjacency[sf], m = A.m[sf];
      text = m > 1 ? `곡이 바뀔 때 ${featWord(PR, sf)}${josa(featWord(PR, sf), "이", "가")} 크게 달라지면 넘기시는 편이에요(크게 바뀐 뒤 ${c.large_n}번 중 ${c.large_y}번, 비슷할 때 ${c.small_n}번 중 ${c.small_y}번) → ${featWord(PR, sf)}${josa(featWord(PR, sf), "을", "를")} ${m.toFixed(1)}배 더 신경 써서 이어요. (관찰 기반 추정)`
                   : `${featWord(PR, sf)} 변화에는 덜 민감하셔서(크게 바뀐 뒤 ${c.large_n}번 중 ${c.large_y}번 넘김) 덜 신경 써서 이어요. (관찰 기반 추정)`;
    } else {
      const pj = (cx.path_jump && cx.path_jump.located + cx.path_jump.unlocated) || 0;
      text = `곡 사이 연결은 기본값으로 이어요${A.n_trans ? ` (전환 ${A.n_trans}번 관찰)` : ""}${pj ? ` · ‘분위기가 갑자기 튀어요’ ${pj}번` : ""}.`;
    }
    card({ id: "adjacency", title: "곡 사이 연결", text, evidence: A.n_trans, confidence: dots(A.n_trans / (A.n_trans + PR.adjacency.min_transitions)),
           is_default: !sf, changed: !!last && !!last.m && FEATS.some((f) => differs(R3(A.m_applied[f]), R3(Number(last.m[f]) || 1))),
           series: series((p) => (p.m ? p.m.tempo : null)), reset_procedure: "adjacency" });
  }
  // 빼는 곡
  {
    const Gt = model.gates, vb = Gt.evidence.vocal_bother_w || 0, vn = countOf(Gt.evidence.vocal_bother_n);
    const on = Gt.soft.length > 0;
    card({ id: "gates", title: "빼는 곡", text: on ? `말이 많은 곡(랩·내레이션)은 빼고 골라요${vn > 0 ? ` — ‘가사·목소리가 거슬려요’ ${vn}번` : ""}` : "자동으로 빼는 곡은 없어요.",
           evidence: vn, confidence: dots(vb / (vb + PR.gates.soft_spoken.vocal_bother_min)), is_default: !on,
           changed: !!last && differs(Gt.soft, last.soft_gates || []), series: series((p) => (p.soft_gates || []).length), reset_procedure: "gates" });
  }
  // 다양성
  {
    const Dv = model.diversity, rep = Dv.repetitive_sessions_w || 0, repN = countOf(Dv.repetitive_sessions_n), maxCap = Number(rules.diversity.max_per_artist);
    const dflt = Dv.artist_cap === maxCap && Dv.recent_window === PR.diversity.recent_window;
    const text = `최근 ${Dv.recent_window}곡은 쉬게 하고 같은 가수는 ${Dv.artist_cap}곡까지${repN > 0 ? ` — ‘너무 자주 나와요’ ${repN}번` : ""}` +
                 (Dv.replay_ids.length ? ` · 좋아요한 곡 ${Dv.replay_ids.length}곡은 오랜만이라 다시 넣을 수 있어요` : "");
    card({ id: "diversity", title: "다양성", text, evidence: repN, confidence: dots(rep / (rep + PR.diversity.repetitive_sessions_for_cap)), is_default: dflt,
           changed: !!last && (differs(Dv.artist_cap, last.artist_cap) || differs(Dv.recent_window, last.recent_window)),
           series: series((p) => p.recent_window), reset_procedure: "diversity" });
  }
  // 새로운 발견
  {
    const T = model.taste, D = PR.taste.discovery;
    const nextIdx = num(model.source && model.source.n_sessions) ? model.source.n_sessions : 0;
    const paused = num(T.discovery.paused_until_session) && nextIdx <= T.discovery.paused_until_session;
    const eligible = T.mu >= D.min_mu && T.E >= D.min_E;
    const text = paused ? `새 가수 곡을 연속으로 넘기셔서 ${T.discovery.paused_until_session - nextIdx + 1}세션 쉬어요.`
      : eligible ? "아직 안 들어본 가수의 곡을 한 번에 한 곡씩 넣어 봐요 (긴장이 높을 때는 넣지 않아요)."
      : "기록이 더 쌓이면 아직 안 들어본 가수의 곡도 넣어 볼게요.";
    card({ id: "discovery", title: "새로운 발견", text, evidence: tasteCount(model), confidence: dots(T.E / (T.E + D.min_E)), is_default: !eligible || paused,
           reset_procedure: "discovery" });
  }
  return cards;
}
