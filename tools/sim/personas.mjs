/*
 * 합성 사용자(페르소나)와 행동 모형의 숫자 — 명세 §9.4. **시뮬레이터의 숫자는 이 파일 한 곳에만 둔다.**
 * 순수 ESM(Node·브라우저 모두 import) — 데모 모드의 "가상 청취 1회"가 behavior.mjs 와 함께 이 파일을 읽는다.
 *
 * 여기 적힌 값은 "숨은 참값"이다. 개인화 코드(engine/personal.js)는 이 값을 절대 보지 못하고, 로그(RawFacts)만 본다.
 * 모든 결과 수치는 "합성 사용자" 기준이다 — 실제 효과는 로그가 쌓인 뒤 5단계(재생 평가)에서 잰다.
 *
 * 표기:
 *   taste    곡 취향 u(song) 의 효과 합. genre: 버튼 장르별(곡이 가진 장르마다 더함), artist: 가수 키별(가장 큰 것 하나),
 *            instrumental: { yes, no }, feature: { "spokenness:high": w } (카탈로그 3분위 묶음)
 *   beta     전환 민감도 β_f — 넘김 로짓에 β_f·x_f(앞 곡, 곡) 를 더한다 (x_f 정의는 명세 §4.8.1, BEHAVIOR 의 척도)
 *   pi_star  원하는 여정 속도 π* ∈ [−1, 1] (+ 빠르게)
 *   calib    단어별 좌표 참값 δ* = [dv, de] — 실제 상태 s_0 = 표(단어) + δ*
 */
import { u01, pick } from "./lib_rng.mjs";

/** 세션 일정 (§9.4) */
export const SIM = {
  sessions: 10,                 // 반복마다 세션 수
  reps: 5,                      // 기본 반복 수 (모수 회복 시험은 10)
  gap_days_mean: 1.5,           // 세션 간격 ~ Exp(평균 1.5일), 시드 고정
  min_gap_h: 2,                 // [보충] 간격 하한 — 앞 세션(최대 약 1시간)과 겹치지 않게
  start_utc: [2026, 9, 1, 12, 0, 0],   // 첫 세션 시각(UTC, 월은 0부터) = 2026-10-01 21:00 KST — 결정적 기준점
  minutes_default: 30,          // 감상 시간 기본 (P9 도 30분으로 시작)
  habit_prob: 0.7,              // 습관 단어를 고를 확률 (아니면 칩 전체에서 무작위)
  seed_fmt: "wp-{persona}:{rep}:{k}",   // 엔진 시드 — 세 팔 공통
  uid_fmt: "sim-{persona}-r{rep}",
  legacy_sessions_p13: 10,      // P13: fix-web 형식 세션을 먼저 이만큼
  demo_end_utc: [2026, 8, 27, 12, 0, 0],   // 데모 프로필은 마지막 세션이 2026-09-27 21:00 KST 에 끝나게 옮긴다 — 10/3 시연 때 기록이 "과거"가 되도록
};

/** 행동 모형 (§9.4 "행동 모형"). [spec] = 명세 값, [보충] = 명세가 정하지 않아 이 파일에서 정한 값(보고서에 적음) */
export const BEHAVIOR = {
  // 실제 상태 이동: s_k = s_{k−1} + state_step·(곡 원좌표 − s_{k−1})  [spec]
  state_step: 0.35,
  state_min_completion: 0.30,   // [보충] 조기 넘김(c < 0.30) 곡은 상태를 움직이지 않는다
  // 조기 넘김 확률 σ(logit0 + u_coef·u + T_k + 반복항) + 첫곡항  [spec]
  skip_logit0: -2.2,
  skip_u_coef: -1.0,
  // 전환 손실 T_k = Σ β_f·x_f + va_w·max(0, 작업좌표 전환 − va_free)/va_scale  [spec]
  va_w: 1.0, va_free: 0.10, va_scale: 0.10,
  // x_f 척도 — 명세 §4.8.1 과 같은 정의(페르소나가 '느끼는' 차이). BPM = 50 + 150·tempo
  bpm_base: 50, bpm_span: 150, bpm_scale: 60, spoken_scale: 0.5,
  // 넘기지 않으면 완주율 ~ u > 0 ? Beta(6, 1.5) : Beta(2, 2)  [spec]
  beta_pos: [6, 1.5], beta_neg: [2, 2],
  complete_at: 0.95,            // [보충] 뽑은 완주율이 이 이상이면 곡 끝까지(cause complete, c = 1)
  skip_c: [0.03, 0.25],         // [보충] 조기 넘김 때 들은 비율 ~ U(0.03, 0.25)
  // 좋아요·싫어요  [spec]
  like_u: 0.8, like_c: 0.7, like_p: 0.5,
  dislike_taste_u: -1.2, dislike_taste_p: 0.3,
  dislike_jump_T: 1.2, dislike_jump_p: 0.2,
  // 「듣고 난 뒤」  [spec]
  post_p: 0.6,
  U_dist_w: -2.5, U_dist_scale: 0.1, U_jump_T: 1.0, U_jump_w: -0.5, U_pace_w: -1.0, U_rep_w: -0.5,
  change_a: 1.5, change_b: 0.6, change_sd: 0.6,
  code_p: 0.7,                  // 조건을 넘은 이유 코드마다 선택할 확률(출처 user)
  ai_code_p: 0.1,               // 세션 10% 는 AI 가 무작위 코드 하나를 더함(출처 ai)
  mood_mismatch_dist: 0.20,     // [보충] 첫 곡(원좌표)이 실제 지금 상태에서 이만큼 넘게 멀면 mood_mismatch 조건
  arrival_mismatch_dist: 0.12,  // [보충] 마지막으로 들은 곡이 실제 목표에서 이만큼 넘게 멀면 arrival_mismatch 조건
  // 속도  [spec]
  pace_answer_p: 0.7,           // 속도 답 한 줄(늘 보임)에 답할 확률 — 카드 제출(post_p)과 독립 [보충: 독립으로 해석]
  pace_answer_tol: 0.25,        // |π* − π_used| 가 이보다 크면 방향 답, 아니면 "ok"
  pace_button_min: 0.7,         // |π*| ≥ 이 값이면
  pace_button_p: 0.2,           //   세션마다 이 확률로 속도 버튼을 직접 누름
  p0_ok_p: 0.8,                 // P0: 속도 답 80% "ok", 나머지 무작위(faster/slower)
  // 좌표 끌기  [spec]
  nudge_tol: 0.05, nudge_p: 0.5, nudge_sd: 0.02,
  arrow_step: 0.05,             // fix-web 쌍둥이는 끌기가 없고 화살표(0.05 칸)만 — [보충] 같은 조건에서 칸 단위로 옮김
  point_clamp: [0.04, 0.96],
  // 청취 사실  (앱과 같은 문턱: HEARD_MIN_SECONDS 10, 노출 3초, 미리듣기 30초)
  heard_min_s: 10, exposure_min_s: 3, preview_s: 30,
  post_delay_s: 30,             // 마지막 곡 뒤 「듣고 난 뒤」 응답까지
};

/* 습관 단어 3개는 이 파일에서 정한 값(명세는 "습관 단어 3개"만 정함). 칩 이름은 index.html MOOD_CHIPS 와 같아야 한다.
   고긴장 칩(불안·짜증·답답·걱정, stress 3)은 P7(명세가 「불안해요」를 지정)·P8 에만 습관으로 준다 — 고긴장 안전 집합(I5)이
   속도·발견·반경을 따로 묶기 때문에 다른 학습기 시험이 섞이지 않게. 나머지 30% 무작위 칩에서는 누구나 고긴장이 나올 수 있다. */
export const PERSONAS = [
  { id: "P0", name: "신규·무취향(대조)", control: true,
    habit_words: ["그냥 그래요", "지쳤어요", "나른해요"], taste: {}, beta: {}, pi_star: 0, pace_answer_mode: "p0", nudge: false },
  { id: "P1", name: "재즈·빠르게",
    habit_words: ["지쳤어요", "그냥 그래요", "나른해요"], taste: { genre: { "재즈": 1.5, "K-pop": -0.5 } }, beta: {}, pi_star: 0.8,
    favored: { kind: "genre", value: "재즈", base_rate: 0.07 } },
  { id: "P2", name: "연주곡·천천히·보컬 전환 민감",
    habit_words: ["지쳤어요", "우울해요", "편안해요"], taste: { instrumental: { yes: 1.5 } }, beta: { vocal: 1.5 }, pi_star: -0.7,
    favored: { kind: "instrumental", value: true, base_rate: 0.17 } },
  { id: "P3", name: "K-발라드·가사 거슬림",
    habit_words: ["우울해요", "지쳤어요", "그냥 그래요"], taste: { genre: { "발라드": 1.2 }, feature: { "spokenness:high": -1.5 } }, beta: {}, pi_star: 0,
    spoken_bother_p: 0.5,       // 말 비중 '높음' 곡을 넘기면 50% 로 싫어요 + vocal_bother
    favored: { kind: "genre", value: "발라드", base_rate: 0.46 } },
  { id: "P4", name: "반복 싫음",
    habit_words: ["그냥 그래요", "설레요", "편안해요"], taste: {}, beta: { genre: 0.8 }, pi_star: 0,
    repeat: { sessions: 3, logit: 1.5, code_p: 0.7 } },   // 최근 3세션에 들은 곡이면 넘김 로짓 +1.5, 넘기면 70% too_repetitive
  { id: "P5", name: "벽 아이유",
    habit_words: ["설레요", "편안해요", "그냥 그래요"], taste: { artist: { "아이유": 1.5 } }, beta: {}, pi_star: 0,
    wall: { artist: "아이유", songs: 5 },               // 벽에 붙인 아이유 곡 5개 + 벽 가수 아이유 (온보딩)
    replay_complete: true,                             // 다시 넣은 좋아요·벽 곡은 끝까지 들음
    favored: { kind: "artist", value: "아이유", base_rate: 0.01 } },
  { id: "P6", name: "빠르기 민감",
    habit_words: ["그냥 그래요", "신나요", "나른해요"], taste: {}, beta: { tempo: 1.5 }, pi_star: 0 },
  { id: "P7", name: "좌표 보정자",
    habit_words: ["불안해요"],                         // 「불안해요」 가 습관 단어(70%)
    taste: {}, beta: {}, pi_star: 0,
    calib: { current: { "불안해요": [-0.05, 0.08] }, target: { "차분해지고 싶어요": [0.04, 0] } } },
  { id: "P8", name: "고긴장·빠르게",
    mood_words_only: ["불안해요", "짜증나요", "답답해요", "걱정돼요"], taste: {}, beta: {}, pi_star: 0.8, high_stress: true },
  { id: "P9", name: "조기 이탈·짧게",
    habit_words: ["지쳤어요", "그냥 그래요", "나른해요"], taste: {}, beta: {}, pi_star: 0,
    quit: { after_path: 5, p: 0.8 },                   // 경로 5곡째 뒤 80% 재생 멈춤
    length: { over_min: 20, p: 0.6, dir: "long", preferred_min: 20 } },   // 20분 넘는 세션이면 60% length + "길었어요"
  { id: "P10", name: "첫 곡 거부",
    habit_words: ["우울해요", "지쳤어요", "나른해요"], taste: {}, beta: {}, pi_star: 0,
    first_reject: { dist: 0.05, add_p: 0.4 } },        // 첫 곡이 보고한 지금 좌표에서 0.05 이내면 넘김 확률 +0.4
  { id: "P11", name: "잡음(대조)", control: true,
    habit_words: ["그냥 그래요", "신나요", "우울해요"], taste: {}, beta: {}, pi_star: 0, noise: true, nudge: false,
    random_taste: { n_genres: 2, abs: 0.5 } },         // 반복마다 장르 2개에 ±0.5 (약한 무작위 취향)
  { id: "P12", name: "미리듣기(모바일)",
    habit_words: ["그냥 그래요", "편안해요", "설레요"], taste: { genre: { "인디": 0.6 } }, beta: {}, pi_star: 0, preview: true },
  { id: "P13", name: "옛 기록만",
    habit_words: ["지쳤어요", "우울해요", "그냥 그래요"], taste: { genre: { "록·메탈": 1.0 } }, beta: {}, pi_star: 0, legacy_first: true },
];

/* 내부 대조(보고서 D11 전용, 14명에 들지 않음): P12 와 같은 행동을 전체 재생으로 — 미리듣기 반값 확인 */
export const INTERNAL = {
  P12F: { ...PERSONAS.find((p) => p.id === "P12"), id: "P12F", rng_id: "P12", name: "미리듣기 대조(전체 재생)", preview: false, internal: true },
};

export const PERSONA_IDS = PERSONAS.map((p) => p.id);
export function personaById(id) {
  return PERSONAS.find((p) => p.id === id) || INTERNAL[id] || null;
}

/* 버튼 장르 13종 (index.html FAVORITE_GENRES 와 같은 목록) — P11 무작위 취향용 */
export const BUTTON_GENRES = ["K-pop", "J-pop", "발라드", "힙합·랩", "R&B·소울", "인디", "록·메탈", "팝", "일렉트로닉", "재즈", "클래식", "OST", "휴식·앰비언트"];

/**
 * 반복(rep)별로 확정한 페르소나 — P11 의 약한 무작위 취향처럼 반복마다 달라지는 참값을 채운다. 결정적.
 * @returns 같은 모양의 새 객체(원본은 바꾸지 않음)
 */
export function materializePersona(p, rep) {
  const out = JSON.parse(JSON.stringify(p));
  if (p.random_taste) {
    const genre = {};
    const pool = [...BUTTON_GENRES];
    for (let i = 0; i < p.random_taste.n_genres; i++) {
      const g = pick(`${p.id}:${rep}:taste:g${i}`, pool);
      pool.splice(pool.indexOf(g), 1);
      genre[g] = (u01(`${p.id}:${rep}:taste:s${i}`) < 0.5 ? -1 : 1) * p.random_taste.abs;
    }
    out.taste = { ...(out.taste || {}), genre };
  }
  out.rep = rep;
  return out;
}

/** 세션 k(1부터)의 시작 시각(epoch ms). 간격 ~ Exp(평균 gap_days_mean), 반복마다 다른 난수. */
export function sessionTimes(personaId, rep, n) {
  const [y, mo, d, h, mi, s] = SIM.start_utc;
  let t = Date.UTC(y, mo, d, h, mi, s);
  const out = [];
  for (let k = 1; k <= n; k++) {
    if (k > 1) {
      const u = u01(`${personaId}:${rep}:gap:${k}`);
      t += Math.max(SIM.min_gap_h * 3600000, Math.round(-SIM.gap_days_mean * Math.log(u) * 86400000));
    }
    out.push(t);
  }
  return out;
}

export const fmt = (tpl, o) => tpl.replace(/\{(\w+)\}/g, (_, k) => String(o[k]));
