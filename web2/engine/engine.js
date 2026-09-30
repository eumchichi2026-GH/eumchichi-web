/*
 * AZT 추천 알고리즘 v2.2 (JavaScript) — 앱 런타임용.
 *
 * 규칙(숫자)은 여기 없습니다 — rules/rules.compiled.json 에 있습니다.
 * (Python 검증기 engine.py 는 현재 저장소에 없습니다. 복구되면 이 파일과 같은 결과를 내야 합니다.)
 *
 *   1) 좌표 변환   원 V/A → 퍼센타일 좌표
 *   2) 하드 제약   게이트 / 싫어요 / 최근재생 / 아티스트 상한 / 장르
 *   3) 영역 후보   waypoint 이웃 반경 (사분면 박스 아님)
 *   4) 두 레인     기하가 어디로 갈지, 선호가 동급 중 무엇을 (2.5.0: μ>0 이면 선호도 비용에 직접 더해진다)
 *   5) 빔 탐색     경로 전체 비용 최소화
 */

/* 엔진 코드 버전. 규칙(rules_hash)은 그대로인데 엔진 동작이 바뀌는 경우를 로그에서 구분한다.
   2.2.0 (2026-09-17): iso.min_step_span 구현, 영역 풀 걸음당 1회 계산, song_count 출력.
   2.3.0 (2026-09-17): 개인화 재배선 — '들어본 곡 중 좋아요한 비율'을 가수·곡 특징 단위로 집계(aggregateAffinity),
                       선호 결합 방식 preference.combine = "mean_like_rate".
   2.4.0 (2026-09-21): (1) 스트레스 연동 최대 보폭 제약 제거 — inputs.stress·modulators.stress_step_limit·iso.max_step_jump·
                       iso.step_limit_scale·후보 제외 필터·완화 폴백. 실카탈로그 4,117곡 600 시나리오에서 발동 0.01회/세션, 제거해도 지표 동일.
                       (2) path.fit_weight 제거 — 균등 배율이라 결과 무관.
                       (3) 전환 비용(transition cost) 추가 — cost += path.jump_weight × 인접 곡 거리. λ=0.1 에서 최대 전환 거리 −13%.
                       근거: 2026-09-21 민감도 분석(파라미터 9개, one-at-a-time).
   2.5.0 (2026-09-22): 개인화 신호 4종 — (1) 완주·스킵을 표로 센다(items.completion·skipped, preference.implicit).
                       (2) 벽에 붙인 곡·가수(items.pinned)는 좋아요와 같은 무게로 세되 시간 감쇠하지 않는다.
                       (3) 가수 "A;B;C" 다중 표기를 쪼개 각 가수에 표를 준다(artistKeys). 협업곡 좋아요가 단독 가수로 넘어간다.
                       (4) 선호를 동률 깨기에서 비용 항으로 승격 — cost += preference.pref_weight(μ) × (내 중립점 − 선호 점수).
                           μ=0 이면 2.4.0 과 결과 동일(회귀 확인). μ 값은 스윕으로 정한다.
   2.5.1 (2026-09-22): 목표 도착 후 '머무름' 구간의 지그재그 제거 — (1) 그 구간(경유지 = 목표 좌표 그 자체)의 탐색 비용은
                       밴드로 뭉치지 않고 실제 거리를 그대로 쓴다(밴드는 이동 구간에서만). (2) 그리디 탐색은 먼저 뽑힌 곡이
                       가장 가깝고 뒤로 갈수록 남은 후보 중 상대적으로 먼 곡이 걸리는 구조라, 이 구간만 사후에 '먼 것→가까운
                       것'으로 재배열해 마지막 곡이 항상 가장 가깝게(=도착) 끝나도록 한다. 곡 집합은 그대로, 순서만 바뀐다.
                       preference.band 0.05→0.025 (2026-09-21 스윕 근거, μ 도입으로 '동률 폭 축소' 트레이드오프가 사라져 반영).
   2.6.0-wp (2026-09-27): web-personal 개인화 (명세 docs/personalization_spec_20260927.md §6.6).
                       inputs.personal(PersonalPolicy)을 받으면 sanitizePersonal 로 경계·고긴장 규칙을 다시 적용한 동결 사본을 쓴다.
                       (1) 개인 비용 결합 제한 — 걸음마다 pers = clamp(μ·취향여백 + 인접 전환 비용, −J, +J), 가점은 코리도어 안에서만(§3.8).
                       (2) 인접 전환 비용 adjCost(빠르기·보컬 전환·말 비중·장르) · 개인 λ.
                       (3) 머묾 반경 r(반경 안은 거리 0) + 마지막 곡 고정 진행 방향 순 재배열.
                       (4) 속도 tp·이탈 가드·시작 오프셋 — 경유지를 바꾸는 경로 모수(두 레인 I3).
                       (5) 가수 상한 키 단위(B27) · 기기 무관 최근 창(exclude_ids) · 좋아요 곡 다시 넣기 · 새 가수 발견 칸 · 소프트 게이트.
                       (6) recommendExtras — 더 들을 곡을 엔진이 고른다(경로는 바꾸지 않음).
                       inputs.pace(fast/slow)는 개인화와 무관하게 rules.personalization.pace.manual_tp 로 처리(앱 PACE_TP 이관, B20).
                       inputs.personal 이 없거나 personalization.enabled !== true 이면 출력은 2.5.1 과 같다(I0) —
                       P === null 분기는 2.5.1 식을 글자 그대로(덧셈 순서 포함) 둔다.
   2.6.0-wp (2026-09-29, 1차 수정 — change.md "web-personal"): P 모드만 바뀐다(P === null 출력은 그대로, I0/I1).
                       (1) 개인 비용 양자화 pers_bucket(0 쪽 자름) — 시드 변이가 다시 곡을 가른다(같은 곡으로 끝남·서로 다른 곡 수).
                       (2) 밀도 적응 머묾 반경 hold_min_pool(상한 hold_radius_cap) · 도착 상한(마지막 이동 곡 거리 + reversal_eps) ·
                           머묾 순서 last_fixed_turn(역행 → 꺾임 최소, 마지막 곡 고정 그대로) ·
                           머묾 묶음 hold_cluster(머묾 곡끼리 envelope.turn_min 안 — 머묾 안 90° 꺾임 0) ·
                           머묾 경로 비용 양자화 hold_path_q(머묾 걸음의 진행·λ 전환 비용도 pers_bucket 으로 — 시드가 마지막 곡을 가른다).
                       (3) [perf] 출력이 같은 속도 개선(P 모드): 호출 안 메모(선호 점수·동점 키·가수 키·걸음별 곡 값), 앞 k 개 선택,
                           prepare 캐시(입력 지문 확인), extras 정확한 조기 종료, ASCII fnv1a32 — 개인 실행 약 40배 빠름.
   2.6.0-wp (2026-09-29, 2차 수정 — change.md "web-personal"): P 모드만 바뀐다(P === null 출력은 그대로, 중립 정책 I1 도 그대로).
                       (1) 개인 비용 흔들기 pers_jitter(safety.pers_mode "perturb"): 이동 걸음은 양자화 대신 kp = clamp(취향 + 전환 + 지터×칸, −J, J) 를
                           키와 빔 경로 비용에 쓴다 — 한 특징 전환 비용이 다시 순위에 닿고(양자화는 0 으로 만들었다) 시드는 여전히 가깝게 겨루는 곡을 가른다.
                           머묾 걸음은 양자화 그대로(+ 지터로 동률 가르기). 정리 한계는 그대로(kp ∈ [−J, J]).
                       (2) 묶음 깨기 비용 hold_break(= j_hold): 도착 영역 안 · 머묾 묶음 밖 곡의 거리 비용을 실거리 대신 min(J, rCap) —
                           묶음이 모자랄 때 늘 목표에 가장 가까운 곡이 끼어 마지막 곡이 시드와 무관하게 정해지던 것을 푼다.
                       (3) 이탈 가드 곡 번호 quit_song(pace.quit_guard.basis "position"): K = quit_song — 비율 quit_frac × 이번 곡 수 대신(§4.3.4 변경).
                           quit_frac 은 옛 로그 재현용으로 그대로 받는다. 경계 bounds.quit_song. */
export const ENGINE_VERSION = "2.6.0-wp";

const R9 = (x) => Math.round(x * 1e9) / 1e9;
const R6 = (x) => Math.round(x * 1e6) / 1e6;

function bisectLeft(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function bisectRight(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

// ── 시드 난수 (engine.py 와 비트 단위로 동일해야 함) ────
const TE = new TextEncoder();
export function fnv1a32(text) {
  let h = 2166136261;
  /* [perf] 모두 ASCII(< 0x80)면 UTF-8 바이트 = 코드 단위라 TextEncoder 없이 같은 값(시드·곡 ID 대부분). 아니면 기존 경로. */
  const str = typeof text === "string" ? text : null;
  let ascii = str !== null;
  if (ascii) for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) >= 0x80) { ascii = false; break; }
  if (ascii) {
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  for (const b of TE.encode(text)) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function xorshift32(x) {
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  return x;
}
function jitterOf(seed, songId, step) {
  if (!seed) return 0;
  return xorshift32(fnv1a32(`${seed}|${songId}|${step}`) || 0x9e3779b9) / 4294967296;
}
/* [2.6.0-wp] 시드 균등 난수 [0, 1) — jitterOf 와 같은 계열. '§' 접두어로 곡 단위 지터와 겹치지 않는다(명세 §3.7).
   시드가 없으면 0.5. 이 엔진에서 무작위는 이것(과 jitterOf)뿐이다 — 시스템 난수·현재 시각은 쓰지 않는다(I7). */
export function seededUniform(seed, ...keys) {
  if (!seed) return 0.5;
  return xorshift32(fnv1a32(`${seed}|§${keys.join("|")}`) || 0x9e3779b9) / 4294967296;
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (!n) return 0;
  const m = Math.floor(n / 2);
  return n % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function percentile(values, p) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (!n) return 0;
  return v[Math.max(0, Math.min(n - 1, Math.ceil(p * n) - 1))];
}

function ecdf(sorted, x) {
  const n = sorted.length;
  if (!n) return 0.5;
  const lo = bisectLeft(sorted, x), hi = bisectRight(sorted, x);
  return (lo + (hi - lo) / 2) / n;
}

// ── 준비 ────────────────────────────────────────────────
function prepare(catalog, rules) {
  const sv = catalog.map((s) => Number(s.V)).sort((a, b) => a - b);
  const sa = catalog.map((s) => Number(s.A)).sort((a, b) => a - b);
  const pct = rules.coordinate_space === "percentile";

  const coords = new Map();
  for (const s of catalog) {
    const v = Number(s.V), a = Number(s.A);
    coords.set(s.song_id, pct ? [ecdf(sv, v), ecdf(sa, a)] : [v, a]);
  }

  const base = {};
  for (const [ax, spec] of Object.entries(rules.baselines)) {
    if (spec && typeof spec === "object" && "stat" in spec) {
      const i = ax === "V" ? 0 : 1;
      base[ax] = median(catalog.map((s) => coords.get(s.song_id)[i]));
    }
  }

  const th = {};
  for (const g of rules.gates) {
    if (g.op === "percentile_below") {
      const vals = catalog.map((s) => Number(s[g.field])).filter((x) => !Number.isNaN(x));
      th[g.id] = percentile(vals, g.value);
    }
  }
  return { sv, sa, pct, coords, base, th };
}

/* [2.6.0-wp] 작업 좌표(퍼센타일) — prepare 의 ecdf 와 같은 값. personal.js·도구가 곡 사이 거리를 엔진과 같은 공간에서 잴 때 쓴다. */
export function workingCoords(catalog, rules) {
  return prepare(catalog, rules).coords;
}
/* [perf] prepare 결과를 (카탈로그 배열, 규칙 객체)별로 다시 쓴다 — 앱은 같은 contract·AZT_RULES 로 A·R·(A′)·extras 를 연달아 부른다.
   적중 때마다 prepare 가 읽는 모든 입력(곡 객체·song_id·V·A·백분위 게이트 필드, 규칙의 coordinate_space·baselines·gates)이
   그대로인지 O(곡 수)로 확인하고, 하나라도 다르면 새로 만든다 → 호출자가 제자리에서 고쳐도 결과는 캐시 없는 것과 같다.
   캐시한 ctx 는 엔진 안에서 읽기만 한다(workingCoords 는 호출자에게 Map 을 넘기므로 캐시를 쓰지 않는다). */
const PREP_CACHE = new WeakMap();
const prepRulesKey = (rules) => JSON.stringify([rules.coordinate_space ?? null, rules.baselines ?? null, rules.gates ?? null]);
function prepFingerprint(catalog, rules) {
  const pgs = (rules.gates || []).filter((g) => g.op === "percentile_below");
  return { songs: catalog.slice(), ids: catalog.map((s) => s.song_id), V: catalog.map((s) => s.V), A: catalog.map((s) => s.A),
           gf: pgs.map((g) => catalog.map((s) => s[g.field])), rj: prepRulesKey(rules) };
}
function prepSame(fp, catalog, rules) {
  const n = catalog.length;
  if (fp.songs.length !== n || fp.rj !== prepRulesKey(rules)) return false;
  const pgs = (rules.gates || []).filter((g) => g.op === "percentile_below");
  for (let i = 0; i < n; i++) {
    const s = catalog[i];
    if (s !== fp.songs[i] || !Object.is(s.song_id, fp.ids[i]) || !Object.is(s.V, fp.V[i]) || !Object.is(s.A, fp.A[i])) return false;
    for (let g = 0; g < pgs.length; g++) if (!Object.is(s[pgs[g].field], fp.gf[g][i])) return false;
  }
  return true;
}
function prepareCached(catalog, rules) {
  if (!Array.isArray(catalog) || !rules || typeof rules !== "object") return prepare(catalog, rules);
  let byRules = PREP_CACHE.get(catalog);
  const hit = byRules && byRules.get(rules);
  if (hit && prepSame(hit.fp, catalog, rules)) return hit.ctx;
  const ctx = prepare(catalog, rules);
  if (!byRules) { byRules = new WeakMap(); PREP_CACHE.set(catalog, byRules); }
  byRules.set(rules, { ctx, fp: prepFingerprint(catalog, rules) });
  return ctx;
}

function toCoord(ctx, p) {
  return ctx.pct ? [ecdf(ctx.sv, Number(p.V)), ecdf(ctx.sa, Number(p.A))] : [Number(p.V), Number(p.A)];
}

function quadrantOf(c, ctx, rules) {
  for (const [name, cond] of Object.entries(rules.quadrants)) {
    const okV = cond.V === "above" ? c[0] >= ctx.base.V : c[0] < ctx.base.V;
    const okA = cond.A === "above" ? c[1] >= ctx.base.A : c[1] < ctx.base.A;
    if (okV && okA) return name;
  }
  return null;
}

function dist(c1, c2, term) {
  const dv = c1[0] - c2[0], da = c1[1] - c2[1];
  return Math.sqrt(term.axes.V * dv * dv + term.axes.A * da * da);
}

// ── 게이트 / 모듈레이터 ─────────────────────────────────
function passesGate(song, g, th) {
  const val = song[g.field];
  if (g.op === "percentile_below") return val === undefined || val === null || Number(val) < th[g.id];
  if (g.op === "is_true") return Boolean(val);
  if (g.op === "is_false") return !val;
  throw new Error(`unknown gate op: ${g.op}`);
}

function applyModulators(rules, inputs) {
  /* 2.4.0: 게이트 추가형 모듈레이터만 남는다. 스트레스→걸음 상한(max_step_jump) 사슬은
     후보가 이미 경유지 반경 안에서만 나오므로 결과를 바꾸지 않아 제거했다. */
  const active = [];
  for (const m of rules.modulators || []) {
    const val = inputs[m.input];
    if (val === undefined || val === null) continue;
    if (m.applies_to === "gates" && m.when_gte !== undefined) {
      if (Number(val) >= Number(m.when_gte)) active.push(m.adds_gate);
    }
  }
  return { active };
}

// ── 선호 레인 ───────────────────────────────────────────
/* (긍정 + prior·k) / (전체 + k) — "기록이 없으면 prior 에서 출발하고, 기록이 쌓일수록 실제 비율에 가까워진다."
   prior = 0.5, k = 2 이면 (좋아요 + 1) / (전체 + 2) : 라플라스의 계승 규칙.
   k = 2 는 '가상의 관측 2건'(라플라스 규칙에서 성공 1·실패 1 에 해당)의 무게를 뜻한다. */
function shrunk(pos, neg, k, decay = 1, prior = 0.5, pin = 0) {
  /* pin = 벽에 붙인 표(2.5.0). 감쇠하지 않는 '좋음' 표로, 좋아요와 같은 무게. */
  const n = (pos + neg) * decay + pin;
  if (n <= 0) return prior;
  return (pos * decay + pin + prior * k) / (n + k);
}

/* 가수 문자열 → 키 목록 (2.5.0). DB 의 artist 는 "A;B;C" 다중 표기가 있어 세미콜론으로 쪼갠다.
   키는 앱의 artistKeyOf 와 같은 식(공백 제거·소문자)이라 "IU"/"iu" 가 같은 묶음에 든다. */
export function artistKeys(artist) {
  return String(artist || "").split(/[;]/).map((a) => a.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
}

/* ── 곡 특징 구간 ─────────────────────────────────────────
   "이 곡을 좋아했다"를 "이런 곡을 좋아한다"로 넓히려면 곡을 몇 개의 묶음으로 나눠야 한다.
   연속값(말 비중·빠르기)은 **전체 카탈로그의 3분위**로 낮음/중간/높음 — 경계는 상수가 아니라
   카탈로그에서 계산하는 통계량이라, 곡이 늘어도 세 묶음의 크기가 같게 유지된다.
   3 은 '낮음'과 '높음'을 가르면서 가운데를 둘 수 있는 가장 작은 수다(묶음이 많을수록 묶음당 기록이 희박해진다).
   참/거짓 값(연주곡 여부)은 그대로 두 묶음.
   ⚠️ 반드시 '전체 카탈로그'로 만들 것. 장르·가사 조건으로 걸러낸 풀로 만들면 조건마다 경계가 달라져
      같은 좋아요가 다른 묶음으로 들어간다. */
const BIN_NAMES = { 2: ["low", "high"], 3: ["low", "mid", "high"] };
/* 묶음 함수 본체 — makeFeatureBinner(규칙의 preference.features)와 makeExtraBinner(개인 전용 추가 특징)가 같이 쓴다.
   [2.6.0-wp] spec.zero_is_unknown 이면 0 은 '모름'이라 경계 계산에서도 빼고 묶지도 않는다(인기도 0 이 '낮음'으로 묶이지 않게, 명세 §4.7.5). */
function binnerOf(fullCatalog, specs) {
  const cuts = {};
  for (const f of specs) {
    if (f.bins === "boolean") continue;
    const vals = fullCatalog.map((s) => s[f.field])
      .filter((x) => typeof x === "number" && Number.isFinite(x) && !(f.zero_is_unknown && x === 0)).sort((a, b) => a - b);
    const nb = Number(f.bins);
    cuts[f.id] = vals.length ? Array.from({ length: nb - 1 }, (_, i) => vals[Math.min(vals.length - 1, Math.floor(vals.length * (i + 1) / nb))]) : null;
  }
  const bin = (song) => {
    const out = {};
    for (const f of specs) {
      const v = song[f.field];
      if (f.bins === "boolean") { if (typeof v === "boolean") out[f.id] = v ? "yes" : "no"; continue; }
      if (typeof v !== "number" || !Number.isFinite(v) || !cuts[f.id]) continue;   // 값을 모르면 묶지 않는다(중간으로 치지 않는다)
      if (f.zero_is_unknown && v === 0) continue;
      let i = 0; while (i < cuts[f.id].length && v >= cuts[f.id][i]) i++;
      out[f.id] = (BIN_NAMES[Number(f.bins)] || [])[i] ?? String(i);
    }
    return out;
  };
  bin.cuts = cuts;
  return bin;
}
export function makeFeatureBinner(fullCatalog, rules) {
  return binnerOf(fullCatalog, (rules.preference && rules.preference.features) || []);
}
/* [2.6.0-wp] 개인 전용 추가 특징(rules.personalization.taste.extra_features — 예: 인기도)의 묶음. 결과는 곡의 feature_bins_p 에 넣는다.
   preference.features·feature_bins 와 섞지 않으므로 기본 경로(P 없음)는 그대로다. */
export function makeExtraBinner(fullCatalog, specs) {
  return binnerOf(fullCatalog, Array.isArray(specs) ? specs : []);
}

/* ── 들은 곡·좋아요 → 가수·특징별 '좋아요 비율' 집계 ─────────
   items: 사용자가 **실제로 들어본 곡**(좋아요를 누를 수 있었던 곡) 한 곡당 하나.
     { song_id?, liked: bool, disliked?: bool, reason?: 싫어요 이유 코드|null,
       completion?: 0~1 완주율, skipped?: bool, pinned?: bool(벽에 붙임),
       vote?: { pos, neg, pin } (2.6.0-wp 청취 표 — 있으면 이 표를 그대로 쓴다),
       artist?, genres?: [], feature_bins?: {id: bin}, feature_bins_p?: {id: bin}, days?: 경과일 }
   각 가수·특징 묶음마다 "들어본 곡 N개 중 좋아요한 곡 M개" 를 센다 (pos = M, neg = N − M).

   [2.5.0] 한 곡이 주는 표 (rules.preference.implicit):
     벽에 붙임(pinned)              → pin += pinned_weight (감쇠 없음, '내 평균'에는 안 셈)
     좋아요                          → pos 1
     싫어요                          → neg 1 (범위는 dislike_scope)
     일찍 넘김(skipped)              → neg skip_weight
     끝까지 들음(completion ≥ completion_min), 좋아요 없음 → pos completion_weight, neg 1 − completion_weight
     들었지만 아무 반응 없음         → neg 1 (2.4.0 과 같음)
   완주·스킵 값을 안 주면(옛 앱) 2.4.0 과 똑같이 센다.
   [2.6.0-wp] vote 가 있는 항목은 위 판단보다 먼저 그 표를 쓴다 — 9/20 합의 청취 표(명세 §3.2)는 personal.js 가 계산해 넘긴다.

   왜 '좋아요 수'가 아니라 '들은 것 중 비율'인가 —
     좋아요만 세면 흔한 묶음이 무조건 이긴다. 카탈로그의 90% 가 보컬곡이면 좋아요의 90% 도 보컬곡이라
     "보컬곡을 좋아한다"는 결론이 나오는데, 이건 취향이 아니라 기저율이다. 들은 곡 수로 나누면 사라진다.

   싫어요는 그 이유가 정한다 (rules.preference.dislike_scope):
     취향(not_my_taste·이유 없음) → 모든 묶음에서 '좋아하지 않음' 1건
     가사·목소리(vocal_bother)    → 말 비중·연주곡 여부에서만 1건, 나머지 묶음에서는 세지 않음
     경로·기분·반복               → 어느 묶음에서도 세지 않음 (그 곡의 가수·특징 탓이 아니다)
   opts (2.6.0-wp, 없으면 2.5.1 과 같음):
     scope_add          이유별 범위 덧붙임 — 예 { arrival_mismatch: [], length: [] } (규칙 기본 절은 그대로, B1)
     extra_feature_ids  feature_bins_p 의 이 특징들에도 표를 준다(개인 전용 추가 특징)
   반환: { like_base:{pos,neg}, song_likes, artist_affinity, genre_affinity, feature_affinity } */
export function aggregateAffinity(items, rules, opts = undefined) {
  const baseScope = (rules.preference && rules.preference.dislike_scope) || {};
  const scopeMap = opts && opts.scope_add ? { ...baseScope, ...opts.scope_add } : baseScope;
  const featIds = ((rules.preference && rules.preference.features) || []).map((f) => f.id);
  const extraIds = (opts && Array.isArray(opts.extra_feature_ids)) ? opts.extra_feature_ids : [];
  const imp = (rules.preference && rules.preference.implicit) || {};
  const CW = Number(imp.completion_weight ?? 0.5), CMIN = Number(imp.completion_min ?? 0.8);
  const SW = Number(imp.skip_weight ?? 1), PW = Number(imp.pinned_weight ?? 1);
  const out = { like_base: { pos: 0, neg: 0 }, song_likes: {}, artist_affinity: {}, genre_affinity: {}, feature_affinity: {} };
  const vote = (table, key, v, days) => {
    const r = table[key] || (table[key] = { pos: 0, neg: 0, pin: 0, _d: 0 });
    r.pos += v.pos; r.neg += v.neg; r.pin += v.pin;
    r._d += (v.pos + v.neg) * (Number(days) || 0);   // 감쇠용 경과일은 감쇠 대상 표에만
  };
  const ALL = ["base", "song", "artist", "genre", "features"];
  for (const it of items || []) {
    const liked = !!it.liked && !it.disliked;
    let scope = ALL;
    if (it.disliked) {
      const key = it.reason && it.reason in scopeMap ? it.reason : "_no_reason";
      const sc = scopeMap[key] || [];
      /* 취향 전체를 가리키는 싫어요만 '내 평균'과 '이 곡' 에도 센다 */
      scope = sc.includes("artist") && sc.includes("features") ? ALL : sc;
    }
    /* 이 곡이 주는 표 */
    let v;
    if (it.vote) v = { pos: +it.vote.pos || 0, neg: +it.vote.neg || 0, pin: +it.vote.pin || 0 };
    else if (it.pinned) v = { pos: 0, neg: 0, pin: PW };
    else if (liked) v = { pos: 1, neg: 0, pin: 0 };
    else if (it.disliked) v = { pos: 0, neg: 1, pin: 0 };
    else if (it.skipped) v = { pos: 0, neg: SW, pin: 0 };
    else if (Number(it.completion) >= CMIN) v = { pos: CW, neg: 1 - CW, pin: 0 };
    else v = { pos: 0, neg: 1, pin: 0 };
    const has = (x) => scope.includes(x);
    if (has("base") && !it.pinned) { out.like_base.pos += v.pos; out.like_base.neg += v.neg; }
    if (has("song") && it.song_id) vote(out.song_likes, it.song_id, v, it.days);
    if (has("artist") && it.artist) for (const k of artistKeys(it.artist)) vote(out.artist_affinity, k, v, it.days);
    if (has("genre")) for (const g of it.genres || []) vote(out.genre_affinity, g, v, it.days);
    for (const id of featIds) {
      const b = it.feature_bins && it.feature_bins[id];
      if (b !== undefined && (has("features") || has(id))) vote(out.feature_affinity, id + ":" + b, v, it.days);
    }
    for (const id of extraIds) {   // [2.6.0-wp] 개인 전용 추가 특징 — opts 가 없으면 빈 목록이라 2.5.1 과 같다
      const b = it.feature_bins_p && it.feature_bins_p[id];
      if (b !== undefined && (has("features") || has(id))) vote(out.feature_affinity, id + ":" + b, v, it.days);
    }
  }
  for (const table of [out.song_likes, out.artist_affinity, out.genre_affinity, out.feature_affinity])
    for (const r of Object.values(table)) { r.last_days = (r.pos + r.neg) ? r._d / (r.pos + r.neg) : 0; delete r._d; }
  return out;
}

const PREF_LABELS = { song: "이 곡", artist: "가수", genre: "장르" };

/* 내 평균 좋아요 비율 — 기록이 없는 묶음의 출발점. (좋아요 + 1) / (들은 곡 + 2). */
function likeBaseRate(user) {
  const b = (user && user.like_base) || {};
  const n = (b.pos || 0) + (b.neg || 0);
  return n > 0 ? ((b.pos || 0) + 1) / (n + 2) : null;
}

/* 선호 점수와 그 근거를 함께 돌려준다. { score, neutral(이 사용자의 중립점), basis:[{id, score}] }
   [2.6.0-wp] extraSpecs(개인 전용 추가 특징 spec 목록)가 있으면 곡의 feature_bins_p 묶음도 같은 방식으로 평균에 넣는다(P 모드에서만). */
/* [perf] 한 번의 recommend/recommendExtras 안에서 prefDetail(곡) 은 (곡, 규칙, 사용자, extraSpecs) 의 순수 함수다 —
   걸음·빔 상태마다 다시 계산하지 않고 곡 객체를 키로 한 번만 계산한다(memo 는 호출마다 새로 만든다 → 호출 사이 공유 없음). */
function prefDetail(song, rules, user, extraSpecs = null, memo = null) {
  if (!memo) return prefDetailRaw(song, rules, user, extraSpecs);
  let v = memo.get(song);
  if (v === undefined) { v = prefDetailRaw(song, rules, user, extraSpecs); memo.set(song, v); }
  return v;
}
/* 벽에 붙인 표가 있는가 — 내 평균(like_base)이 없을 때만 필요하다(그때만 계산: 표 전체를 훑는 비용). */
function hasPinsOf(user) {
  return Object.values(user.artist_affinity || {}).some((r) => r.pin > 0) || Object.values(user.song_likes || {}).some((r) => r.pin > 0);
}
function prefDetailRaw(song, rules, user, extraSpecs = null) {
  const p = rules.preference;
  if (!p || !user) return { score: 0.5, neutral: 0.5, basis: [] };
  const pk = p.shrinkage.personal_k, gk = p.shrinkage.global_k;
  const hl = p.decay.half_life_days;
  const decayOf = (rec) => (hl ? Math.pow(0.5, Number(rec.last_days || 0) / hl) : 1);
  const gs = (user.global_stats || {})[song.song_id];
  const globalScore = gs && ((gs.pos || 0) + (gs.neg || 0)) > 0 ? shrunk(gs.pos || 0, gs.neg || 0, gk) : null;

  if (p.combine === "mean_like_rate") {
    /* 선호 점수 = 이 곡이 속한 묶음들(이 곡·가수·장르·각 특징)의 '내 좋아요 비율' 단순 평균.
       묶음 점수 = (그 묶음에서 좋아요한 곡 + 2·p0) / (그 묶음에서 들어본 곡 + 2),  p0 = 내 평균 좋아요 비율.
       기록이 없는 묶음은 p0 — "모르면 내 평균". 묶음 사이에 가중치를 두지 않는다: 어느 것이 더 중요한지
       정할 근거가 없고 사람마다 다를 수 있기 때문이다.
       들어본 곡이 하나도 없을 때만(콜드스타트) 전체 사용자 통계를 쓴다. 내 기록이 생기면 남의 평균은 쓰지 않는다. */
    /* [2.5.0] 들어본 곡이 없어도 벽에 붙인 게 있으면 개인화한다 — 중립점은 0.5. */
    const p0 = likeBaseRate(user) ?? (hasPinsOf(user) ? 0.5 : null);
    if (p0 === null) return { score: globalScore ?? 0.5, neutral: 0.5, basis: [] };
    const basis = [];
    const sc = (rec) => shrunk(rec.pos || 0, rec.neg || 0, pk, decayOf(rec), p0, rec.pin || 0);
    const rate = (id, rec) => { basis.push({ id, score: rec ? sc(rec) : p0 }); };
    rate("song", (user.song_likes || {})[song.song_id]);
    if (song.artist) {   // "A;B;C" 는 가수별 점수 중 가장 높은 것 (장르와 같은 방식)
      const aa = user.artist_affinity || {};
      const recs = artistKeys(song.artist).map((k) => aa[k]).filter(Boolean);
      rate("artist", recs.length ? recs.reduce((a, b) => (sc(b) > sc(a) ? b : a)) : null);
    }
    if ((song.genres || []).length) {
      const ga = user.genre_affinity || {};
      const recs = song.genres.map((g) => ga[g]).filter(Boolean);
      rate("genre", recs.length ? recs.reduce((a, b) => (sc(b) > sc(a) ? b : a)) : null);
    }
    const fa = user.feature_affinity || {};
    for (const f of p.features || []) {
      const b = song.feature_bins && song.feature_bins[f.id];
      if (b !== undefined) rate(f.id, fa[f.id + ":" + b]);
    }
    for (const f of extraSpecs || []) {   // [2.6.0-wp] 개인 전용 추가 특징(feature_bins_p)
      const b = song.feature_bins_p && song.feature_bins_p[f.id];
      if (b !== undefined) rate(f.id, fa[f.id + ":" + b]);
    }
    return { score: basis.reduce((a, x) => a + x.score, 0) / basis.length, neutral: p0, basis };
  }

  /* 이전 방식(가중합) — 비교 실험용. preference.combine 을 "weighted" 로 두면 이 경로. */
  const w = p.weights;
  const sf = (user.song_feedback || {})[song.song_id];
  const af = (user.artist_affinity || {})[song.artist];
  const ga = user.genre_affinity || {};
  const hits = (song.genres || []).filter((g) => g in ga).map((g) => shrunk(ga[g].pos || 0, ga[g].neg || 0, pk, decayOf(ga[g])));
  const personal = sf ? shrunk(sf.pos || 0, sf.neg || 0, pk, decayOf(sf)) : 0.5;
  const artist = af ? shrunk(af.pos || 0, af.neg || 0, pk, decayOf(af)) : 0.5;
  const genre = hits.length ? Math.max(...hits) : 0.5;
  return { score: w.personal_feedback * personal + w.liked_artist * artist + w.liked_genre * genre + w.global_feedback * (globalScore ?? 0.5),
           neutral: 0.5, basis: [] };
}

function tiebreakKeys(song, rules) {
  const keys = [];
  for (const tb of rules.ranking.tiebreakers) {
    if (tb.type === "ordinal_map") {
      const i = tb.order.indexOf(song[tb.field]);
      keys.push(i === -1 ? tb.order.length : i);
    } else if (tb.type === "numeric") {
      const v = Number(song[tb.field] || 0);
      keys.push(tb.direction === "desc" ? -v : v);
    }
  }
  return keys;
}

function cmpKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === "string" || typeof y === "string") return String(x) < String(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/* [perf] cmpKeys([h, j, ...a.tk, a.sid], [h', j', ...b.tk, b.sid]) 와 같은 값을 배열 없이 — 앞 두 키(숫자)는 호출자가 비교한다.
   tk 는 같은 규칙에서 길이가 같다(tiebreakKeys 는 규칙의 동점 키마다 하나). 숫자끼리는 cmpKeys 처럼 !== 이면 x < y ? -1 : 1 (NaN 포함 같은 값). */
function cmpTail(a, b) {
  const ta = a.tk, tb = b.tk;
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    if (x === y) continue;
    if (typeof x === "string" || typeof y === "string") return String(x) < String(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  if (a.sid === b.sid) return 0;
  return a.sid < b.sid ? -1 : 1;   // sid 는 String(song_id)
}
const cmpNum = (x, y) => (x === y ? 0 : x < y ? -1 : 1);   // cmpKeys 의 숫자 한 자리와 같은 규칙

// ── 개인 정책 (2.6.0-wp) ────────────────────────────────
/* 정책을 받으면 모르는 키를 버리고, rules.personalization.bounds 로 자르고, 고긴장 안전 집합(I5)을 다시 적용한 동결 사본을 만든다.
   빠진 필드는 **중립값**(2.5.1 과 같은 동작)으로 채운다 — 일부만 채운 정책도 나머지 절차는 2.5.1 그대로다.
   rules.personalization.enabled !== true 이거나 p 가 없으면 null → I0 경로(2.5.1 과 같은 출력).
   env = { duration_min, pace } — 고긴장 속도 하한(at_def)과 '천천히'를 누른 세션의 이탈 가드 끄기에 쓴다.
   고긴장은 정책의 stress·high_stress 로만 판단한다(엔진의 inputs.stress 는 읽지 않는다 — 스트레스·부하 분리 유지). */
const HOLD_ORDERS = ["fit", "last_fixed_progress", "last_fixed_turn", "last_fixed_smooth"];
const ADJ_FEATURES = ["tempo", "vocal", "spoken", "genre"];
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
export function sanitizePersonal(p, rules, env = {}) {
  const Z = rules && rules.personalization;
  if (!Z || Z.enabled !== true || !p || typeof p !== "object" || Array.isArray(p)) return null;
  const B = Z.bounds || {}, S = Z.safety || {}, HS = S.high_stress || {};
  const ZA = Z.adjacency || {};
  const band = Number(rules.preference.band);
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const rng = (x, r, dflt) => (num(x) === null ? dflt : clamp(x, Number(r[0]), Number(r[1])));
  const ids = (a, max) => {   // 문자열 곡 ID 만, 중복 없이, 앞(최신)에서부터 max 개
    const seen = new Set(), out = [];
    for (const x of Array.isArray(a) ? a : []) {
      if (typeof x !== "string" || seen.has(x)) continue;
      seen.add(x); out.push(x);
      if (out.length >= max) break;
    }
    return out;
  };
  const dur = env.duration_min ?? 30;
  const atDef = transitionAt(rules, dur);

  /* 고긴장(명세 §3.5, I5) — stressOf(지금 좌표) ≥ safety.high_stress_min */
  const stress = num(p.stress) === null ? null : clamp(Math.round(p.stress), Number(B.stress[0]), Number(B.stress[1]));
  const high = p.high_stress === true || (stress !== null && stress >= Number(S.high_stress_min));
  const noFaster = high && HS.faster_pace_allowed !== true;

  /* 속도 — 자동 tp 는 고긴장이면 표 값보다 빠를 수 없다. 이탈 가드는 '천천히'를 직접 눌렀거나 고긴장이면 끈다(§4.3.4). */
  let tp = num(p.tp) === null ? null : clamp(p.tp, Number(B.tp[0]), Number(B.tp[1]));
  if (noFaster && tp !== null) tp = Math.max(tp, atDef);
  const qg = (Z.pace && Z.pace.quit_guard) || {};
  let quit = num(p.quit_frac) === null ? null : clamp(p.quit_frac, Number(B.quit_frac[0]), Number(B.quit_frac[1]));
  /* [2026-09-29 2차] 이탈 가드 곡 번호(quit_song) — "보통 K 번째 곡쯤에서 멈춘다"의 K 를 곡 번호로(비율 quit_frac 대신, §4.3.4 변경). 정수, 경계 bounds.quit_song */
  let quitSong = num(p.quit_song) === null || !Array.isArray(B.quit_song) ? null : Math.round(clamp(p.quit_song, Number(B.quit_song[0]), Number(B.quit_song[1])));
  if (qg.enabled !== true || noFaster || env.pace === "slow") { quit = null; quitSong = null; }

  /* 시작 오프셋·머묾 반경 — 고긴장 상한 */
  let start = rng(p.start_offset, B.start_offset, 0);
  if (high) start = Math.min(start, Number(HS.start_offset_max));
  let hold = rng(p.hold_radius, B.hold_radius, 0);
  if (high) hold = Math.min(hold, Number(HS.hold_radius_max));
  /* [2026-09-29] 밀도 적응 반경의 상한 — 학습값이 아니라 규칙 값(팔 최댓값, 고긴장이면 I5 상한) */
  const holdCap = high ? Math.min(Number(B.hold_radius[1]), Number(HS.hold_radius_max)) : Number(B.hold_radius[1]);

  /* 인접 전환 비용 — 절대 비용(밴드 × 기본 가중 × scale × 배수). 고긴장이면 배수 ≥ adj_mult_min(더 엄격하게만). */
  const wLo = Number(B.adj_w_bands_each[0]) * band, wHi = Number(B.adj_w_bands_each[1]) * band;
  const adjIn = p.adj_w && typeof p.adj_w === "object" ? p.adj_w : {};
  const adj_w = {};
  for (const f of ADJ_FEATURES) {
    let w = num(adjIn[f]) === null ? 0 : clamp(adjIn[f], wLo, wHi);
    if (high) w = Math.min(wHi, Math.max(w, band * Number((ZA.base_weights_bands || {})[f] || 0) * Number(ZA.scale) * Number(HS.adj_mult_min)));
    adj_w[f] = w;
  }
  const jw = Number(rules.path.jump_weight || 0);
  let lambda = rng(p.lambda, [Math.min(Number(ZA.lambda_range[0]), jw), Number(B.lambda_max)], jw);
  if (high) lambda = Math.min(Number(B.lambda_max), Math.max(lambda, jw * Number(HS.adj_mult_min)));

  const muMax = Math.max(Number(Z.taste.mu_max), Number(rules.preference.pref_weight || 0));
  const gateIds = new Set((rules.gates || []).map((g) => g.id));
  const maxCap = Number(rules.diversity.max_per_artist);
  const tf = Array.isArray(p.taste_features)
    ? p.taste_features.filter((f) => f && typeof f === "object" && typeof f.id === "string" && typeof f.field === "string"
        && (f.bins === "boolean" || f.bins === 2 || f.bins === 3))
      .slice(0, Number(B.taste_features_max))
      .map((f) => ({ id: f.id, field: f.field, bins: f.bins, label: typeof f.label === "string" ? f.label : f.id, zero_is_unknown: f.zero_is_unknown === true }))
    : [];
  const u = num(p.discovery_u);

  return deepFreeze({
    v: 1,
    schema: Z.schema ?? null,
    digest: typeof p.digest === "string" ? p.digest : null,
    model_digest: typeof p.model_digest === "string" ? p.model_digest : null,
    stress,
    high_stress: high,
    tp,
    quit_frac: quit,
    quit_song: quitSong,
    start_offset: start,
    start_min_journey: rng(p.start_min_journey, B.start_min_journey, Number(Z.start.min_journey)),
    hold_radius: hold,
    hold_min_songs: Math.round(rng(p.hold_min_songs, B.hold_min_songs, Number(Z.hold.min_songs))),
    hold_order: HOLD_ORDERS.includes(p.hold_order) ? p.hold_order : "fit",
    hold_min_pool: num(p.hold_min_pool) === null ? 0 : Math.round(clamp(p.hold_min_pool, Number(B.hold_min_pool[0]), Number(B.hold_min_pool[1]))),
    hold_radius_cap: holdCap,
    hold_cluster: p.hold_cluster === true,
    hold_path_q: p.hold_path_q === true,
    hold_break: num(p.hold_break) === null ? null : clamp(p.hold_break, Number(B.j_hold[0]), Number(B.j_hold[1])),
    pers_jitter: num(p.pers_jitter) === null ? null : clamp(p.pers_jitter, Number(B.pers_jitter_bands[0]) * band, Number(B.pers_jitter_bands[1]) * band),
    pers_bucket: num(p.pers_bucket) === null ? null : clamp(p.pers_bucket, Number(B.pers_bucket_bands[0]) * band, Number(B.pers_bucket_bands[1]) * band),
    corridor_bands: num(p.corridor_bands) === null ? null : clamp(p.corridor_bands, Number(B.corridor_bands[0]), Number(B.corridor_bands[1])),
    j_move: num(p.j_move) === null ? null : clamp(p.j_move, Number(B.j_move_bands[0]) * band, Number(B.j_move_bands[1]) * band),
    j_hold: num(p.j_hold) === null ? null : clamp(p.j_hold, Number(B.j_hold[0]), Number(B.j_hold[1])),
    mu: rng(p.mu, [0, muMax], Number(rules.preference.pref_weight || 0)),
    taste_features: tf.length ? tf : null,
    adj_w,
    bpm_scale: rng(p.bpm_scale, B.bpm_scale, Number(ZA.bpm_scale)),
    spoken_scale: rng(p.spoken_scale, B.spoken_scale, Number(ZA.spoken_scale)),
    half_double_fold: typeof p.half_double_fold === "boolean" ? p.half_double_fold : ZA.half_double_fold === true,
    /* 빠르기 태그 → BPM 환산은 학습값이 아니라 규칙 값이다(정책에 무엇이 오든 규칙에서 채운다). */
    bpm_offset: Number(ZA.bpm_offset),
    bpm_per_tag: Number(ZA.bpm_per_tag),
    lambda,
    discovery_u: high && HS.discovery !== true ? null : (u !== null && u >= 0 && u < 1 ? u : null),
    soft_gates: [...new Set(Array.isArray(p.soft_gates) ? p.soft_gates.filter((g) => gateIds.has(g)) : [])],
    soft_min_pool: Math.round(rng(p.soft_min_pool, B.soft_min_pool, Number(Z.gates.soft_min_pool))),
    artist_cap: Math.max(1, Math.round(rng(p.artist_cap, [1, maxCap], maxCap))),   // 상한 0 은 곡이 없다는 뜻이라 구조적 하한 1
    artist_cap_by_key: p.artist_cap_by_key === true,
    exclude_ids: Array.isArray(p.exclude_ids) ? ids(p.exclude_ids, Number(B.exclude_ids_max)) : null,
    replay_ids: ids(p.replay_ids, Number(B.replay_ids_max)),
    replay_max: Math.round(rng(p.replay_max, B.replay_max, 0)),
  });
}

/* [2.6.0-wp] 인접 두 곡의 쌍 특징 x_f ∈ [0, 1] (명세 §4.8.1). 값을 모르면 0.
   tempo  = min(1, |BPM 차| / bpm_scale), BPM = bpm_offset + bpm_per_tag × 빠르기 태그(측정 지표와 같은 정의).
            half_double_fold 면 반/배 박자(|2a−b|, |a−2b|)도 같은 빠르기로 본다.
   vocal  = 둘 다 연주곡 여부를 알고 서로 다르면 1
   spoken = min(1, |말 비중 차| / spoken_scale)
   genre  = 둘 다 버튼 장르가 있고 하나도 겹치지 않으면 1
   bpm_diff = 쓰인 BPM 차(정수) | null */
/* BPM 환산의 기본값 — rules.personalization.adjacency.bpm_offset·bpm_per_tag 와 같은 값(앱 songTempo01 의 역변환).
   sanitizePersonal 을 거친 정책은 규칙 값을 들고 오므로 이 값은 쓰이지 않는다. personal.js 가 학습용(큰 변화 표시 L_if)으로
   정규화 전 정책을 넘겨도 빠르기 특징이 조용히 0 이 되지 않게 두는 대비값이다. */
const BPM_MAP_FALLBACK = { offset: 50, per_tag: 150 };
export function adjFeatures(a, b, P) {
  const out = { tempo: 0, vocal: 0, spoken: 0, genre: 0, bpm_diff: null };
  if (!a || !b) return out;
  const Q = P || {};
  const fin = (x) => typeof x === "number" && Number.isFinite(x);
  if (fin(a.tempo) && fin(b.tempo) && fin(Q.bpm_scale) && Q.bpm_scale > 0) {
    const off = fin(Q.bpm_offset) ? Q.bpm_offset : BPM_MAP_FALLBACK.offset;
    const per = fin(Q.bpm_per_tag) ? Q.bpm_per_tag : BPM_MAP_FALLBACK.per_tag;
    const ba = off + per * a.tempo, bb = off + per * b.tempo;
    let d = Math.abs(ba - bb);
    if (Q.half_double_fold === true) d = Math.min(d, Math.abs(2 * ba - bb), Math.abs(ba - 2 * bb));
    out.tempo = R9(Math.min(1, d / Q.bpm_scale));
    out.bpm_diff = Math.round(d);
  }
  if (typeof a.instrumental === "boolean" && typeof b.instrumental === "boolean" && a.instrumental !== b.instrumental) out.vocal = 1;
  if (fin(a.spokenness) && fin(b.spokenness) && fin(Q.spoken_scale) && Q.spoken_scale > 0)
    out.spoken = R9(Math.min(1, Math.abs(a.spokenness - b.spokenness) / Q.spoken_scale));
  const ga = Array.isArray(a.genres) ? a.genres : [], gb = Array.isArray(b.genres) ? b.genres : [];
  if (ga.length && gb.length && !ga.some((g) => gb.includes(g))) out.genre = 1;
  return out;
}
function adjCostOf(x, P) {
  const w = (P && P.adj_w) || {};
  let c = 0;
  for (const f of ADJ_FEATURES) c += (Number(w[f]) || 0) * x[f];
  return R9(c);
}
/* [2.6.0-wp] 인접 전환 비용 = Σ_f adj_w[f] · x_f(a, b) — λ 와 같은 '전환 비용'이지 적합도가 아니다(원칙 9). 항상 ≥ 0. */
export function adjCost(a, b, P) {
  return adjCostOf(adjFeatures(a, b, P), P);
}

/* [2.6.0-wp] §3.8 개인 비용의 결합 제한 — 걸음 하나·후보 하나.
   x = { distCost, fit, bandIdx, bestBand, arrival, rEff, taste(= μ·pmarg, 발견 칸이면 0), adj }
   가점(pers < 0)은 코리도어 안에서만: 이동 = 최선 밴드 + corridor_bands 이내, 머묾 = 반경 rEff 이내. 감점은 어디서나.
   J(이동 j_move · 머묾 j_hold)로 양쪽을 자른다. 중립 정책(corridor·J = null)은 자르지 않아 2.5.1 과 같은 부동소수가 나온다.
   정리(이동): J ≤ 1.5·band, corridor_bands = 1 이면 bandIdx ≥ bestBand + 2 인 후보의 key 는 최선 밴드 모든 후보의 key 보다 크다.
   시험(엔진 단위 시험 10만 조합)을 위해 export 한다. */
/* 0 쪽 양자화 — |v| 는 줄기만 하고 부호는 그대로, 칸 폭 b 의 정수배(개인 비용 pers_bucket 과 같은 식) */
function qTrunc(v, b) { const q = Math.trunc(R9(v / b)); return q === 0 ? 0 : R9(b * q); }
export function personalKey(x, P) {
  const bonusOK = P.corridor_bands == null ? true
    : x.arrival ? x.fit <= x.rEff : x.bandIdx <= x.bestBand + P.corridor_bands;
  let pers = x.taste + x.adj;
  if (!bonusOK && pers < 0) pers = 0;
  const raw = pers;   // 자르기 전(흔들기용)
  const J = x.arrival ? P.j_hold : P.j_move;
  pers = J == null ? pers : R9(Math.max(-J, Math.min(J, pers)));
  /* [2026-09-29] 개인 비용 양자화(pers_bucket) — 칸 폭보다 작은 개인 비용 차이는 동률로 둔다. 연속값이면 동률이 생기지 않아
     시드 변이(jitter)가 첫 곡 뒤로 한 번도 쓰이지 않는다(같은 곡으로 끝남 92.8%, 서로 다른 곡 480). 걸음 순위 키와 빔 경로 비용이 이 값을 같이 쓴다.
     0 쪽으로 자르므로(trunc) |pers| 는 줄기만 한다 — 코리도어 밖(pers ≥ 0)은 ≥ 0, [−J, J] 안 그대로 → §3.8 두 정리가 그대로 성립.
     중립 정책(pers_bucket = null)은 자르지 않는다(I1). */
  /* [2026-09-29] 개인 비용 흔들기(pers_jitter, safety.pers_mode = "perturb"): 이동 걸음은 양자화하지 않고 시드 지터 x.pj ∈ [0, pers_jitter)
     (지터 0~1 × 칸 폭)를 자르기 전 값에 더해 자른 kp = clamp(taste + adj + x.pj, −J, J) 를 키와 빔 경로 비용에 쓴다 —
     칸 폭보다 작은 비용 차이는 시드가 뒤집을 수 있고 큰 차이는 확률적으로 지킨다. 양자화(0 쪽 자름)는 한 특징 전환 비용(0.15–0.2 band < 칸 0.25 band)을
     통째로 0 으로 만들어 전환 개인화(배수 < 1.67)가 순위에 닿지 못했다. −J 에 닿은(포화한) 취향 곡들은 흔들어도 −J 로 동률 → 선호 버킷(더 좋아하는 곡)이 먼저 가른다.
     머묾 걸음은 곡 집합 고르기라 양자화를 그대로 두고 흔들기로 동률을 가른다. 돌려주는 pj = kp − pers(≥ 0, 실제로 더해진 몫), pers(기록·설명용)에는 넣지 않는다.
     정리: kp ∈ [−J, J] 라 이동 key(최선 밴드) ≤ bestBand·band + J < (bestBand+2)·band, 머묾 key(도착한 곡) ≤ j_hold < 가장 작은 비영 팔 — 흔들기가 없을 때와 같은 한계. */
  if (P.pers_bucket > 0 && (!(P.pers_jitter > 0) || x.arrival)) pers = qTrunc(pers, P.pers_bucket);
  let pj = 0, kp = pers;
  if (P.pers_jitter > 0 && x.pj > 0) {
    kp = x.arrival && P.pers_bucket > 0 ? R9(pers + x.pj) : R9(raw + x.pj);   // 머묾은 양자화한 값에(칸 동률을 가른다), 이동은 자르기 전 값에
    if (!bonusOK && kp < 0) kp = 0;
    if (J != null) kp = R9(Math.max(-J, Math.min(J, kp)));
    pj = R9(kp - pers);
  }
  return { pers, bonusOK, pj, key: pj > 0 ? R9(x.distCost + kp) : R9(x.distCost + pers) };
}

/* P 모드 후보 허용: 가수 상한(키 단위면 참여 가수 중 한 명이라도 상한에 닿으면 제외, B27) · 다시 넣기 한도. */
function personalAllows(s, state, PR, cap) {
  const P = PR.P;
  if (P.artist_cap_by_key) {
    const ks = PR.keysOf ? PR.keysOf(s) : artistKeys(s.artist);
    if (PR.cappedOf && ks.length) {
      /* [perf] 빔 상태의 keyCount 는 만든 뒤 바뀌지 않는다 — 상한에 닿은 키 집합을 상태마다 한 번 만든다.
         자기 속성 키에 같은 비교((v || 0) >= cap)를 쓰고, 자기 속성이 아닌 키(프로토타입 값)는 원래 식에서도 늘 거짓이라 결과가 같다. */
      const capped = PR.cappedOf(state, cap);
      if (capped.size && ks.some((k) => capped.has(k))) return false;
    } else if (ks.length ? ks.some((k) => (state.keyCount[k] || 0) >= cap) : (state.artistCount[s.artist] || 0) >= cap) return false;
  } else if ((state.artistCount[s.artist] || 0) >= cap) return false;
  if (PR.replay.has(s.song_id) && state.replays >= P.replay_max) return false;
  return true;
}
function keyCountAfter(kc, s, keysOf = null) {
  const out = { ...kc };
  for (const k of new Set(keysOf ? keysOf(s) : artistKeys(s.artist))) out[k] = (out[k] || 0) + 1;
  return out;
}

// ── 후보 생성 ───────────────────────────────────────────
function eligibleUniverse(catalog, rules, ctx, inputs, gates, P = null) {
  const user = inputs.user || {};
  const disliked = new Set(user.disliked || []);
  /* [2.6.0-wp] P 모드: 기기 무관 최근 창(exclude_ids). 중립 정책의 null 이면 기존 목록. 다시 넣을 좋아요 곡은 창에서 뺀다. */
  const recent = new Set(rules.diversity.exclude_recent_played ? (P && P.exclude_ids ? P.exclude_ids : user.recent_played || []) : []);
  if (P) for (const id of P.replay_ids) recent.delete(id);

  const uni = [];
  let blocked = 0;
  for (const s of catalog) {
    if (disliked.has(s.song_id) || recent.has(s.song_id)) { blocked++; continue; }
    if (!gates.every((g) => passesGate(s, g, ctx.th))) { blocked++; continue; }
    uni.push(s);
  }

  const want = new Set(inputs.genres || []);
  let genreApplied = false;
  if (want.size && rules.genre_policy?.mode === "hard_if_sufficient") {
    const sub = uni.filter((s) => (s.genres || []).some((g) => want.has(g)));
    if (sub.length >= inputs._n_songs) return { uni: sub, blocked, genreApplied: true };
  }
  return { uni, blocked, genreApplied };
}

function regionPool(universe, ctx, wp, term, rules) {
  const r = rules.selection.region;
  let radius = Number(r.radius);
  const minPool = Number(r.min_pool);
  let pool = [];
  for (let i = 0; i <= Number(r.max_grow); i++) {
    pool = universe.filter((s) => dist(ctx.coords.get(s.song_id), wp, term) <= radius);
    if (pool.length >= minPool) return pool;
    radius *= Number(r.grow_factor);
  }
  return pool.length ? pool : universe;
}

/* [2.6.0-wp] 소프트 게이트(§4.9): 통과한 곡만 남기되, 걸러서 soft_min_pool 미만이 되면 그 걸음(또는 더 들을 곡)은 게이트 없이 쓴다. */
function softFilter(pool, softGates, ctx, minPool) {
  if (!softGates.length) return { pool, relaxed: false };
  const f = pool.filter((s) => softGates.every((g) => passesGate(s, g, ctx.th)));
  if (f.length === pool.length || f.length >= minPool) return { pool: f, relaxed: false };
  return { pool, relaxed: true };
}

// ── ISO ─────────────────────────────────────────────────
export function songCount(rules, durationMin) {
  const c = rules.iso.song_count;
  return Math.max(c.min, Math.min(c.max, Math.floor(durationMin / c.per_minutes)));
}
export function transitionAt(rules, durationMin) {
  for (const row of rules.iso.transition_point) if (durationMin <= row.up_to) return Number(row.at);
  return Number(rules.iso.transition_point.at(-1).at);
}
/* 경유 곡 수 = max(min, min(시간 기준, floor(여정거리 / min_step_span) + 1))
   지금·목표가 가까운데 곡을 많이 끼우면 한 걸음이 preference.band 보다 잘게 쪼개져
   순위가 곡을 구분하지 못하고, 경로가 좁은 덩어리 안을 맴돈다(rules 의 min_step_span_evidence).
   여정거리는 band 와 같은 작업 좌표계(coordinate_space)에서 잰다 — band 가 그 좌표계의 폭이기 때문.
   (2.6.0-wp: recommend·recommendExtras 가 같이 쓰도록 함수로 뺐다. 식·계산 순서는 2.5.1 그대로.) */
function songPlan(rules, term, nowC, tgtC, dur) {
  const byTime = songCount(rules, dur);
  const journey = R9(dist(nowC, tgtC, term));
  const span = Number(rules.iso.min_step_span || 0);
  const byJourney = span > 0 ? Math.floor(journey / span) + 1 : byTime;
  const n = Math.max(Number(rules.iso.song_count.min), Math.min(byTime, byJourney));
  return { n, journey, songCountOut: { by_time: byTime, by_journey: byJourney, effective: n, journey: R6(journey) } };
}
/* [2.6.0-wp] 전환점(도착 시점) tp 결정 — 명세 §4.3.3 우선순위.
   inputs.pace(사용자가 누른 속도 버튼)가 있으면 personalization.pace.manual_tp — 개인화 스위치와 무관(선언이 이긴다, I4).
   없고 P 가 있으면 P.tp(null 이면 규칙 표) → 이탈 가드 상한(quit_frac) → n ≤ small_n_max 퇴화 방지 → 고긴장 하한(at_def).
   퇴화 방지는 개인화가 tp 를 바꾼 경우에만 건다(규칙 표 값은 2.5.1 그대로 — 중립 정책 항등, I1).
   둘 다 없으면 transitionAt(rules, dur) — 2.5.1 식 그대로. */
function arrivalAt(rules, dur, n, pace, P) {
  const Z = rules.personalization || {};
  const manual = (Z.pace && Z.pace.manual_tp) || {};
  if (typeof pace === "string" && Object.prototype.hasOwnProperty.call(manual, pace)) return Number(manual[pace]);
  const atDef = transitionAt(rules, dur);
  if (!P) return atDef;
  let at = P.tp != null ? P.tp : atDef;
  let personalized = P.tp != null;
  if ((P.quit_song != null || P.quit_frac != null) && n > 1) {
    /* 이탈 가드(§4.3.4): 보통 K 번째 곡쯤에서 멈추면 K 번째 곡 전에 도착 — 도착 곡 번호 ceil(tp·(n−1)) + 1 ≤ K.
       [2026-09-29 2차] 곡 번호 quit_song 이 있으면 K = quit_song(비율 × 이번 곡 수가 아니라) — K ≥ n 이면 상한 1(걸지 않음과 같음). */
    const K = Math.max(Number(Z.pace.quit_guard.min_arrival_song), P.quit_song != null ? P.quit_song : Math.floor(P.quit_frac * n));
    const cap = Math.max(Number(Z.bounds.tp[0]), (K - 1) / (n - 1));
    if (at > cap) { at = cap; personalized = true; }
  }
  if (personalized && n <= Number(Z.pace.small_n_max)) at = Math.max(at, Number(Z.pace.small_n_min_tp));
  if (P.high_stress && Z.safety.high_stress.faster_pace_allowed !== true) at = Math.max(at, atDef);
  return at;
}
/* [2.5.1] arrival: 그 걸음이 '이동'인지 '도착 후 머무름'인지. raw(양자화 전 t)가 1 이상이면 머무름 —
   그 경유지는 전부 목표 좌표 그 자체라, 밴드로 뭉치면 실제로 더 가까운 곡을 놔두고 먼 곡을 고르는 지그재그가 생긴다. */
function waypoints(nowC, tgtC, n, at) {
  const pts = [], arrival = [];
  for (let k = 0; k < n; k++) {
    const raw = n === 1 ? 1 : at > 0 ? (k / (n - 1)) / at : 1;
    const t = Math.min(1, raw);
    arrival.push(raw >= 1);
    pts.push([nowC[0] + (tgtC[0] - nowC[0]) * t, nowC[1] + (tgtC[1] - nowC[1]) * t]);
  }
  return { pts, arrival };
}

// ── 탐색 ────────────────────────────────────────────────
function stepCandidates(pool, state, ctx, wp, tgtC, term, rules, inputs, band, nExpand,
                       stepI = 0, seed = null, pbucket = 0, mu = 0, arrival = false, PR = null, discStep = false, M = null) {
  /* pool = 이 걸음의 영역 후보. 같은 걸음의 빔 상태들은 경유지가 같아 영역 풀도 같으므로
     recommend() 가 걸음당 1회만 계산해 넘긴다 (결과 동일, 속도만 개선).
     [2.6.0-wp] PR = { P, replay, aa, rEff } — P 모드에서만. null 이면 2.5.1 과 같은 계산. */
  const P = PR ? PR.P : null;
  const cap = P ? P.artist_cap : Number(rules.diversity.max_per_artist);
  /* [2026-09-29] 도착 상한: 머묾 걸음에서 "도착한 곡"으로 치는 반경은 이미 도착한 거리(마지막 이동 곡의 목표 거리 arriveD) + reversal_eps 를
     넘지 않는다 — 그보다 먼 곡을 머묾 첫 곡으로 두면 §11 B3 의 역행(목표에서 reversal_eps 넘게 멀어짐)이다. 새 숫자 없음(봉투 값 그대로). */
  const rCap = P ? (arrival && state.arriveD != null ? Math.min(PR.rEff, R9(state.arriveD + PR.revEps)) : PR.rEff) : 0;
  /* [2026-09-29] 머묾 묶음(hold_cluster): 머묾 곡끼리는 서로 safety.envelope.turn_min 안이어야 "도착한 곡"(거리 0·가점 허용)이다 —
     §11 B3 의 90° 꺾임은 두 걸음이 모두 turn_min 을 넘을 때만 세므로, 머묾 곡 집합의 지름이 turn_min 이하면 어떤 순서로 놓아도
     머묾 안(머묾 첫 곡 꼭짓점 포함)에는 꺾임이 생기지 않는다. 묶음 밖 곡은 반경 밖 곡처럼 실거리 비용(곡이 모자랄 때만 쓰임). 새 숫자 없음. */
  const holdC = P && arrival && P.hold_cluster && state.holdC && state.holdC.length ? state.holdC : null;
  const inCluster = (c) => !holdC || holdC.every((h) => dist(c, h, term) <= PR.turnMin);
  /* [2026-09-29] 묶음 깨기 비용(hold_break = j_hold): 도착 영역(fit ≤ rCap) 안이지만 머묾 묶음 밖인 곡의 거리 비용을 실거리 대신 일정한 값으로 —
     실거리면 묶음이 모자랄 때마다 목표에 가장 가까운 곡이 늘 끼어 들어 마지막 곡(최소 fit)이 시드와 무관하게 정해졌다(푹 쉬고 싶어요 92%).
     일정하면 묶음 깨기 후보끼리 동률이라 시드가 고른다. 값은 min(머묾 결합 제한 J(j_hold), rCap) — 도착한 곡(거리 0)보다 비싸고,
     반경 밖 곡(실거리 > rCap)보다는 늘 싸다(이전 실거리 비용과 같은 순서). 새 숫자 없음. 없으면(null) 이전 동작(실거리). */
  const breakCost = (fit, rE) => (arrival && P && P.hold_break > 0 && rE < 0 && fit <= rCap ? Math.min(P.hold_break, rCap) : null);

  let cands = [];
  for (const s of pool) {
    if (state.used.includes(s.song_id)) continue;
    if (!P) { if ((state.artistCount[s.artist] || 0) >= cap) continue; }
    else if (!personalAllows(s, state, PR, cap)) continue;
    cands.push(s);
  }
  const relaxed = false;   // 걸음 상한이 없어졌으므로 항상 false. trace 호환용으로 한 버전 유지 후 제거 예정.
  if (!cands.length) return { cands: [], bandSize: 0, relaxed };

  /* [perf] M(recommend 가 호출마다 만드는 메모)이 있으면: 걸음마다 같은 값(곡 좌표·경유지 거리·목표 거리·밴드·선호·지터·동점 키)은
     걸음당 곡마다 한 번(M.stepBase) — 상태마다 다른 것은 진행(prog)·전환(jump)뿐. dist(state.prev, tgtC) 도 상태마다 한 번.
     식과 계산 순서는 아래 원래 식과 같다(같은 부동소수). M 이 없으면 원래 코드 그대로. */
  let scored;
  if (M) {
    const prevT = state.prev ? dist(state.prev, tgtC, term) : 0;
    const SB = M.stepBase;
    scored = cands.map((s) => {
      let b = SB.get(s);
      if (b === undefined) {
        const c = ctx.coords.get(s.song_id);
        const fit = R9(dist(c, wp, term));
        const pd = prefDetail(s, rules, inputs.user, P ? P.taste_features : null, M.pref);
        const pref = pd.score;
        const bandIdx = band > 0 ? Math.floor(fit / band) : 0;
        b = { c, fit, dT: dist(c, tgtC, term), pref, pmarg: R9((pd.neutral ?? 0.5) - pref), basis: pd.basis, neutral: pd.neutral,
              band: bandIdx, distCost: arrival ? fit : bandIdx * band,
              pbucket: pbucket > 0 ? Math.floor(R9(pref) / pbucket) : 0, jitter: R9(jitterOf(seed, s.song_id, stepI)),
              tk: M.tbOf(s), sid: String(s.song_id) };
        SB.set(s, b);
      }
      /* 머묾 걸음의 거리 비용은 빔 상태의 도착 상한(rCap)·머묾 묶음에 달려 있어 상태마다 — 아래 원래 식과 같다 */
      const rE = arrival && P && !inCluster(b.c) ? -1 : rCap;   // 묶음 밖이면 도착 반경이 비어 있는 것과 같다(fit ≥ 0 > −1)
      const distCost = arrival && P && b.fit <= rE ? 0 : breakCost(b.fit, rE) ?? b.distCost;
      return {
        song: s, fit: b.fit,
        prog: state.prev ? R9(Math.max(0, b.dT - prevT)) : 0,
        jump: state.prev ? R9(dist(b.c, state.prev, term)) : 0,
        pref: b.pref, pmarg: b.pmarg, basis: b.basis, neutral: b.neutral,
        band: b.band, distCost, pbucket: b.pbucket, jitter: b.jitter, tk: b.tk, sid: b.sid, gk0: R9(distCost), rE,
      };
    });
  }
  else scored = cands.map((s) => {
    const c = ctx.coords.get(s.song_id);
    const fit = R9(dist(c, wp, term));
    const prog = state.prev
      ? R9(Math.max(0, dist(c, tgtC, term) - dist(state.prev, tgtC, term)))
      : 0;
    const jump = state.prev ? R9(dist(c, state.prev, term)) : 0;   // 인접 곡 전환 거리 (transition cost 대상)
    const pd = prefDetail(s, rules, inputs.user, P ? P.taste_features : null);
    const pref = pd.score;
    const pmarg = R9((pd.neutral ?? 0.5) - pref);   // 내 중립점 − 선호. 좋아하는 곡일수록 음수 → 비용 감소 (2.5.0 μ 항)
    const bandIdx = band > 0 ? Math.floor(fit / band) : 0;
    /* [2.5.1] 머무름 구간(arrival)은 밴드로 뭉치지 않고 실제 거리(fit)를 그대로 비용에 쓴다 — 가까운 곡부터 순서대로 나오게.
       [2.6.0-wp] P 모드: 머묾 반경 rEff 안은 거리 0 — 목표 근처 곡들 사이에서는 취향·전환·시드가 고른다(같은 곡으로 끝남 100% 해소, B28).
       [2026-09-29] 반경은 도착 상한 rCap(≤ rEff)까지, 머묾 묶음(hold_cluster) 밖이면 없음. */
    const rE = arrival && P && !inCluster(c) ? -1 : rCap;
    const distCost = arrival ? (P && fit <= rE ? 0 : breakCost(fit, rE) ?? fit) : bandIdx * band;
    return {
      song: s, fit, prog, jump, pref, pmarg, basis: pd.basis, neutral: pd.neutral,
      band: bandIdx, distCost, rE,
      pbucket: pbucket > 0 ? Math.floor(R9(pref) / pbucket) : 0,
      jitter: R9(jitterOf(seed, s.song_id, stepI)),
    };
  });

  const bestBand = Math.min(...scored.map((x) => x.band));
  const bandSize = scored.filter((x) => x.band === bestBand).length;

  /* [2.6.0-wp] P 모드 개인 비용(§3.8). bestBand 를 먼저 구한 뒤(코리도어 판정) 걸음별 기하 최선곡 p_geo_best 를 기록하고,
     발견 칸이면 코리도어 안의 새 가수 곡으로 좁힌 뒤 그 걸음의 취향 항을 0 으로 둔다(없으면 평소대로). */
  let geo = null, disc = false;
  if (P) {
    for (const x of scored) {
      x.adj_x = state.prevSong ? adjFeatures(state.prevSong, x.song, P) : null;
      x.adj = x.adj_x ? adjCostOf(x.adj_x, P) : 0;
      x.taste = P.mu * x.pmarg;
      x.pj0 = P.pers_jitter > 0 ? R9(P.pers_jitter * x.jitter) : 0;   // [2026-09-29] 개인 비용 흔들기(personalKey 주석) — 원래 폭, x.pj 는 실제로 더해진 몫
      const r = personalKey({ distCost: x.distCost, fit: x.fit, bandIdx: x.band, bestBand, arrival, rEff: x.rE, taste: x.taste, adj: x.adj, pj: x.pj0 }, P);
      x.pers = r.pers; x.bonusOK = r.bonusOK; x.key = r.key; x.pj = r.pj;   // = Object.assign(x, r)
    }
    if (M) {
      /* [perf] = scored.reduce((a, b) => (cmpKeys(geoKey(b), geoKey(a)) < 0 ? b : a)) — 배열을 만들지 않는 같은 비교 */
      const geoCmp = (a, b) => cmpNum(a.gk0, b.gk0) || cmpNum(a.jitter, b.jitter) || cmpTail(a, b);
      geo = scored[0];
      for (let i = 1; i < scored.length; i++) if (geoCmp(scored[i], geo) < 0) geo = scored[i];
    } else {
      const geoKey = (x) => [R9(x.distCost), x.jitter, ...tiebreakKeys(x.song, rules), String(x.song.song_id)];
      geo = scored.reduce((a, b) => (cmpKeys(geoKey(b), geoKey(a)) < 0 ? b : a));
    }
    if (discStep) {
      const isNew = (s) => { const ks = PR.keysOf ? PR.keysOf(s) : artistKeys(s.artist); return ks.length > 0 && ks.every((k) => !Object.prototype.hasOwnProperty.call(PR.aa, k)); };
      const pick = scored.filter((x) => x.bonusOK && isNew(x.song));
      if (pick.length) {
        disc = true;
        scored = pick.map((x) => ({ ...x, taste: 0,
          ...personalKey({ distCost: x.distCost, fit: x.fit, bandIdx: x.band, bestBand, arrival, rEff: x.rE, taste: 0, adj: x.adj, pj: x.pj0 }, P) }));
      }
    }
  }

  // 우선순위: 기하 밴드(+μ 선호 비용) > 선호 버킷 > 시드 변이 > 결정론적 동점처리
  // [2.5.0] μ>0 이면 후보 확장 단계에서도 선호가 밴드와 함께 계산된다 — 그래야 좋아하는 곡이 한 밴드 밖에 있어도 빔에 들어올 수 있다.
  //         μ=0 이면 키가 밴드 값 그대로라 2.4.0 과 동일.
  // [2.6.0-wp] P 모드는 결합 제한을 거친 개인 비용 pers(취향 + 전환)를 더한다.
  const key = P ? (x) => x.key : (x) => R9(x.distCost + mu * x.pmarg);   // P 모드: personalKey 가 만든 키(= R9(distCost + pers) 또는 흔들기의 R9(distCost + kp))   // [2.5.1] 이동 구간은 밴드값, 머무름 구간은 실거리
  if (M) {
    /* [perf] 같은 비교 키를 비교마다 새로 만들지 않고 후보마다 한 번 — 비교 함수의 값이 같으므로 정렬 결과도 같다 */
    let nan = false;
    for (const x of scored) {
      x._k0 = key(x); x._k1 = -x.pbucket;
      if (x._k0 !== x._k0 || x._k1 !== x._k1 || x.jitter !== x.jitter) nan = true;
      for (const v of x.tk) if (v !== v) nan = true;
    }
    /* = cmpKeys([key(a), -a.pbucket, a.jitter, ...tk, sid], [...b]) */
    const skCmp = (a, b) => cmpNum(a._k0, b._k0) || cmpNum(a._k1, b._k1) || cmpNum(a.jitter, b.jitter) || cmpTail(a, b);
    /* 필요한 것은 앞 nExpand 개뿐 — 키에 NaN 이 없으면 cmpKeys 는 전순서라, 안정 정렬(V8 TimSort)의 앞 k 개 =
       (키, 원래 순서) 로 뽑은 k 개. NaN 이 있으면(비교가 일관되지 않음) 원래대로 전체 정렬. */
    if (nan || scored.length <= nExpand) scored.sort(skCmp);
    else {
      const top = [];
      for (const x of scored) {
        if (top.length === nExpand && skCmp(x, top[nExpand - 1]) >= 0) continue;
        let lo = 0, hi = top.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (skCmp(top[m], x) <= 0) lo = m + 1; else hi = m; }
        top.splice(lo, 0, x);
        if (top.length > nExpand) top.pop();
      }
      scored = top;
    }
  } else
  scored.sort((a, b) =>
    cmpKeys([key(a), -a.pbucket, a.jitter, ...tiebreakKeys(a.song, rules), String(a.song.song_id)],
            [key(b), -b.pbucket, b.jitter, ...tiebreakKeys(b.song, rules), String(b.song.song_id)]));

  const top = scored.slice(0, nExpand);
  if (P) top.forEach((x, i) => { x.rank = i; });
  return { cands: top, bandSize, relaxed, geo, disc };
}

/* [2.6.0-wp] 걸음별 선택 이유(p_chosen_by) — 기하 최선곡(p_geo_best) 대비 무엇이 순위를 바꿨나. 설명·진단 전용(학습에 쓰지 않음). */
function chosenByOf(c, geo, disc, PR) {
  if (c.song.song_id === geo.song.song_id) return "geometry";
  if (disc) return "discovery";
  if (PR.replay.has(c.song.song_id)) return "replay";
  if (c.rank > 0) return "beam";   // 걸음 안 1등이 아닌데 경로 전체 비용(진행·λ·뒤 걸음)으로 뽑힘
  const tAdv = geo.taste - c.taste, aAdv = geo.adj - c.adj;
  if (aAdv > 0 && aAdv >= tAdv) return "transition";
  if (tAdv > 0) return "taste";
  return c.pbucket > geo.pbucket ? "taste" : "beam";
}

/* [2.6.0-wp] 머묾 구간 재배열(§4.6.1). 곡 집합은 그대로, 순서만 바꾼다.
   fit                  2.5.1 그대로 — 먼 것 → 가까운 것(중립 정책)
   last_fixed_progress  fit 이 가장 작은 곡을 마지막에 고정(지그재그 0% 구조 보장), 나머지는 진행 방향 투영
                        along = (c − 지금)·(목표 − 지금) 오름차순(같으면 fit 내림, 그다음 song_id)
   last_fixed_turn      [2026-09-29] 곡 집합·마지막 고정은 last_fixed_progress 와 같고, 나머지가 smooth_max_tail − 1 곡 이하이면
                        (1) 머묾 첫 곡이 앞(마지막 이동) 곡보다 목표에서 safety.envelope.reversal_eps 넘게 먼 역행(§11 B3),
                        (2) 앞 두 곡부터 이어 붙인 90° 꺾임 수(두 걸음 모두 safety.envelope.turn_min 초과 — §11 B3 과 같은 정의)를
                        사전식으로 최소화하는 순열(같으면 진행 방향 순). 넘으면 진행 방향 순.
   last_fixed_smooth    (P2) 나머지가 hold.smooth_max_tail − 1 곡 이하이면 Σ(adjCost + λ·jump) 최소 순열(동점은 진행 방향 순) */
function orderHold(tail, P, ctx, nowC, tgtC, term, before, rules, before2 = null) {
  if (P.hold_order !== "last_fixed_progress" && P.hold_order !== "last_fixed_smooth" && P.hold_order !== "last_fixed_turn")
    return tail.slice().sort((a, b) => b.fit - a.fit);
  const dir = [tgtC[0] - nowC[0], tgtC[1] - nowC[1]];
  const alongOf = (pk) => { const c = ctx.coords.get(pk.song.song_id); return R9((c[0] - nowC[0]) * dir[0] + (c[1] - nowC[1]) * dir[1]); };
  const cmpId = (a, b) => cmpKeys([String(a.song.song_id)], [String(b.song.song_id)]);
  let li = 0;
  for (let i = 1; i < tail.length; i++) if (tail[i].fit < tail[li].fit || (tail[i].fit === tail[li].fit && cmpId(tail[i], tail[li]) < 0)) li = i;
  const last = tail[li];
  const rest = tail.filter((_, i) => i !== li).map((pk) => ({ pk, along: alongOf(pk) }))
    .sort((a, b) => a.along - b.along || b.pk.fit - a.pk.fit || cmpId(a.pk, b.pk)).map((x) => x.pk);
  const maxTail = Number(((rules.personalization || {}).hold || {}).smooth_max_tail || 0);
  if (P.hold_order === "last_fixed_turn" && rest.length > 1 && rest.length <= maxTail - 1) {
    const env = ((rules.personalization || {}).safety || {}).envelope || {};
    const tm = Number(env.turn_min), eps = Number(env.reversal_eps);
    const C = (pk) => ctx.coords.get(pk.song.song_id);
    const turnsOf = (seq) => {
      let t = 0;
      for (let i = 1; i + 1 < seq.length; i++) {
        const a = C(seq[i - 1]), b = C(seq[i]), c = C(seq[i + 1]);
        const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
        if (dist(a, b, term) > tm && dist(b, c, term) > tm && u[0] * v[0] + u[1] * v[1] < 0) t++;
      }
      return t;
    };
    const pre = [before2, before].filter(Boolean);
    const dB = before ? dist(C(before), tgtC, term) : null;
    const backOf = (seq) => (dB !== null && seq.length && dist(C(seq[0]), tgtC, term) > dB + eps ? 1 : 0);
    const score = (seq) => [backOf(seq), turnsOf([...pre, ...seq])];   // 사전식: 역행 먼저, 그다음 꺾임
    const lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    let best = rest, bestS = score([...rest, last]);
    const perm = (acc, left) => {   // 진행 방향 순의 사전식 순서로 훑어 첫 최소를 남긴다(동점은 진행 방향 순)
      if (bestS[0] === 0 && bestS[1] === 0) return;
      if (!left.length) { const s = score([...acc, last]); if (lt(s, bestS)) { best = acc; bestS = s; } return; }
      for (let i = 0; i < left.length; i++) perm([...acc, left[i]], [...left.slice(0, i), ...left.slice(i + 1)]);
    };
    perm([], rest);
    return [...best, last];
  }
  if (P.hold_order === "last_fixed_smooth" && rest.length > 1 && rest.length <= maxTail - 1) {
    const costOf = (seq) => {
      let c = 0;
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1], b = seq[i];
        c += adjCost(a.song, b.song, P) + P.lambda * R9(dist(ctx.coords.get(a.song.song_id), ctx.coords.get(b.song.song_id), term));
      }
      return R9(c);
    };
    let best = rest, bestCost = costOf([...(before ? [before] : []), ...rest, last]);
    const perm = (pre, left) => {   // 진행 방향 순의 사전식 순서로 훑어 첫 최소를 남긴다(동점은 진행 방향 순)
      if (!left.length) {
        const c = costOf([...(before ? [before] : []), ...pre, last]);
        if (c < bestCost) { best = pre; bestCost = c; }
        return;
      }
      for (let i = 0; i < left.length; i++) perm([...pre, left[i]], [...left.slice(0, i), ...left.slice(i + 1)]);
    };
    perm([], rest);
    return [...best, last];
  }
  return [...rest, last];
}

export function renderExplanations(rules, trace) {
  const msgs = [];
  for (const e of rules.explanations || []) {
    if (e.when && trace[e.when.trace_key] !== e.when.equals) continue;
    let t = e.template;
    for (const b of e.binds) t = t.split(`{${b}}`).join(String(trace[b]));
    msgs.push(t);
  }
  return msgs;
}

/* [2.6.0-wp] 곡별 P 모드 trace(p_*) — 명세 §6.8. */
function adjXOut(x) {
  return x ? { tempo: R6(x.tempo), vocal: R6(x.vocal), spoken: R6(x.spoken), genre: R6(x.genre) } : { tempo: 0, vocal: 0, spoken: 0, genre: 0 };
}
function smoothBasis(pk, rules) {
  if (pk.chosenBy !== "transition" || !pk.adj_x || !pk.geo.adj_x) return null;
  const ZA = (rules.personalization || {}).adjacency || {};
  const dx = Number(ZA.smooth_min_dx), labels = ZA.feature_labels || {};
  const fs = ADJ_FEATURES.filter((f) => pk.geo.adj_x[f] - pk.adj_x[f] >= dx);
  return fs.length ? fs.map((f) => labels[f] || f).join("·") : null;
}
function personalTrace(pk, rules) {
  const basis = smoothBasis(pk, rules);
  return {
    p_phase: pk.phase,
    p_pmarg: R6(pk.pmarg),
    p_pers: R6(pk.pers),
    p_adj: R6(pk.adj),
    p_adj_x: adjXOut(pk.adj_x),
    p_bpm_diff: pk.adj_x ? pk.adj_x.bpm_diff : null,
    p_geo_best: pk.geo.song.song_id,
    p_chosen_by: pk.chosenBy,
    p_corridor: pk.corridor,
    p_smooth: basis !== null,
    p_smooth_basis: basis,
    p_discovery: pk.discovery,
    p_replay: pk.replay,
    p_soft_relaxed: pk.softRelaxed,
    p_extra: false,
  };
}

export function recommend(catalog, rules, inputsIn) {
  const term = rules.ranking.terms[0];
  const ctx = prepareCached(catalog, rules);

  const dur = inputsIn.duration_min ?? 30;
  /* [2.6.0-wp] 개인 정책. 없거나 personalization.enabled !== true 이면 null → 아래 모든 P 분기가 2.5.1 식 그대로(I0). */
  const P = sanitizePersonal(inputsIn.personal, rules, { duration_min: dur, pace: inputsIn.pace });
  const nowC = toCoord(ctx, inputsIn.now), tgtC = toCoord(ctx, inputsIn.target);

  const { n, journey, songCountOut } = songPlan(rules, term, nowC, tgtC, dur);
  const inputs = { ...inputsIn, _n_songs: n };

  const { active } = applyModulators(rules, inputs);
  const gateIds = new Set([...active, ...(inputs.gates || [])]);
  const gates = rules.gates.filter((g) => gateIds.has(g.id));
  const { uni: universe, blocked, genreApplied } = eligibleUniverse(catalog, rules, ctx, inputs, gates, P);

  /* [2.6.0-wp] 경로 모수(경유지를 바꾸는 것 — 두 레인 I3): 전환점 tp(속도·이탈 가드), 시작 오프셋 s(§4.4).
     곡 수·진행 페널티·머묾 정렬은 계속 nowC 기준. */
  const at = arrivalAt(rules, dur, n, inputsIn.pace, P);
  const s0 = P && P.start_offset > 0 && journey >= P.start_min_journey ? P.start_offset : 0;
  const startC = s0 > 0 ? [nowC[0] + (tgtC[0] - nowC[0]) * s0, nowC[1] + (tgtC[1] - nowC[1]) * s0] : nowC;
  let rEff = P && n >= P.hold_min_songs ? P.hold_radius : 0;
  /* [2026-09-29] 밀도 적응 머묾 반경(§4.6.1 변경 20260929): 반경 안 후보(게이트·싫어요·최근 창을 거친 뒤)가 hold_min_pool 곡 미만이면
     그 순번째로 가까운 후보까지 넓힌다 — 상한 hold_radius_cap(팔 최댓값, 고긴장이면 I5 의 0.035). 목표 칩 좌표 근처가 성긴 칩
     (잠들고 싶어요 — 0.035 안 0곡)에서 반경이 이름뿐이라 같은 곡으로 끝나던 것을 줄인다. 정책이 hold_min_pool 을 주지 않으면(0) 그대로. */
  if (P && rEff > 0 && P.hold_min_pool > 0 && universe.length) {
    const ds = universe.map((s) => R9(dist(ctx.coords.get(s.song_id), tgtC, term))).sort((a, b) => a - b);
    const dm = ds[Math.min(ds.length, P.hold_min_pool) - 1];
    if (dm > rEff) rEff = Math.min(Math.max(rEff, P.hold_radius_cap), dm);
  }
  const personalOut = (best, discStep) => ({
    digest: P.digest,
    discovery_step: best && discStep >= 0 && best.picks[discStep] && best.picks[discStep].discovery ? discStep + 1 : null,
    soft_relaxed_steps: best ? best.picks.filter((pk) => pk.softRelaxed).length : 0,
    tp_used: R6(at),
    start_offset_used: s0,
    hold_radius_used: rEff,
  });

  const baseOut = {};
  for (const [k, v] of Object.entries(ctx.base)) baseOut[k] = R6(v);
  if (!universe.length) {
    return { rules_version: rules.rules_version, rules_hash: rules.rules_hash, engine_version: ENGINE_VERSION,
             baselines: baseOut, song_count: songCountOut, sequence: [], ...(P ? { personal: personalOut(null, -1) } : {}) };
  }

  const { pts: wps, arrival: arrivalMask } = waypoints(startC, tgtC, n, at);

  const band = Number(rules.preference.band);
  const varc = rules.variation || {};
  const seed = varc.enabled ? inputs[varc.seed_input || "seed"] ?? null : null;
  const pbucket = varc.enabled ? Number(varc.pref_bucket || 0) : 0;
  const pw = Number(rules.path.progress_weight);
  const jw = P ? P.lambda : Number(rules.path.jump_weight || 0);   // 전환 비용 λ (2.4.0) · [2.6.0-wp] 개인 λ(§4.8.5)
  const mu = P ? P.mu : Number(rules.preference.pref_weight || 0);   // 선호 비용 μ (2.5.0). 0 이면 동률 깨기만 (2.4.0 동일) · [2.6.0-wp] 개인 μ(§4.7.3)
  const strategy = rules.search.strategy;
  const beamW = strategy === "beam" ? Number(rules.search.beam_width) : 1;
  const nExpand = strategy === "beam" ? Number(rules.search.expand_per_step) : 1;

  /* [2.6.0-wp] P 모드 실행 문맥. 새 가수 발견 칸(§4.7.4): 이동 걸음 수 n_move ≥ min_moving_steps 이면
     걸음 1 + floor(u·(n_move − 1)) (0부터 센 걸음 — 첫 곡·머묾 제외). */
  let discStep = -1, PR = null;
  if (P) {
    const nMove = arrivalMask.filter((a) => !a).length;
    const minMove = Number(rules.personalization.taste.discovery.min_moving_steps);
    if (P.discovery_u != null && nMove >= minMove) discStep = 1 + Math.floor(P.discovery_u * (nMove - 1));
    PR = { P, replay: new Set(P.replay_ids), aa: (inputs.user && inputs.user.artist_affinity) || {}, rEff,
           revEps: Number(rules.personalization.safety.envelope.reversal_eps),
           turnMin: Number(rules.personalization.safety.envelope.turn_min),
           softGates: rules.gates.filter((g) => P.soft_gates.includes(g.id)) };
  }

  /* [perf] 호출 안 메모 — 곡마다 변하지 않는 값(선호 점수·동점 키·가수 키)과 걸음마다 같은 값(stepBase). 호출마다 새로 만든다(호출 사이 공유 없음).
     P 모드에서만 쓴다 — P === null 분기(I0)는 2.5.1 코드를 글자 그대로 둔다(명세 §1 구현 규칙). */
  const M = P ? { pref: new Map(), tb: new Map(), keys: new Map(), stepBase: null } : null;
  if (M) {
    M.tbOf = (s) => { let v = M.tb.get(s); if (v === undefined) { v = tiebreakKeys(s, rules); M.tb.set(s, v); } return v; };
    PR.keysOf = (s) => { let v = M.keys.get(s); if (v === undefined) { v = artistKeys(s.artist); M.keys.set(s, v); } return v; };
    const CAPPED = new WeakMap();   // 빔 상태 → 상한에 닿은 가수 키 (recommend 의 상태 객체는 keyCount 를 다시 대입하지 않는다)
    PR.cappedOf = (st, cap) => {
      let v = CAPPED.get(st);
      if (v === undefined) { v = new Set(Object.keys(st.keyCount).filter((k) => (st.keyCount[k] || 0) >= cap)); CAPPED.set(st, v); }
      return v;
    };
  }
  let beam = [{ used: [], artistCount: {}, prev: null, cost: 0, prefSum: 0, pbSum: 0, jitSum: 0, picks: [],
                prevSong: null, keyCount: {}, replays: 0, arriveD: null, holdC: [] }];   // [2.6.0-wp] prevSong·keyCount·replays·arriveD·holdC 는 P 모드용(출력 무관)

  for (let wi = 0; wi < wps.length; wi++) {
    const wp = wps[wi];
    const next = [];
    const stepPool = regionPool(universe, ctx, wp, term, rules);   // 걸음당 1회
    const soft = PR ? softFilter(stepPool, PR.softGates, ctx, P.soft_min_pool) : { pool: stepPool, relaxed: false };
    const isArrival = arrivalMask[wi];
    if (M) M.stepBase = new Map();
    for (const st of beam) {
      const { cands, bandSize, relaxed, geo, disc } = stepCandidates(soft.pool, st, ctx, wp, tgtC, term, rules, inputs, band, nExpand, wi, seed, pbucket, mu, isArrival,
                                                                     PR, wi === discStep, M);
      for (const c of cands) {
        const s = c.song;
        const ac = { ...st.artistCount };
        ac[s.artist] = (ac[s.artist] || 0) + 1;
        const pick = { song: s, fit: c.fit, pref: c.pref, basis: c.basis, neutral: c.neutral, bandSize, wp, pool: universe.length, relaxed, pbucket: c.pbucket, jitter: c.jitter };
        if (P) Object.assign(pick, {
          phase: isArrival ? "hold" : "move", pmarg: c.pmarg, pers: c.pers, adj: c.adj, adj_x: c.adj_x, corridor: c.bonusOK,
          geo, chosenBy: chosenByOf(c, geo, disc, PR), discovery: disc, replay: PR.replay.has(s.song_id), softRelaxed: soft.relaxed,
        });
        next.push({
          used: [...st.used, s.song_id],
          artistCount: ac,
          prev: ctx.coords.get(s.song_id),
          /* [2.6.0-wp] 결합 제한을 거친 개인 비용. [2026-09-29] 머묾 걸음은 진행·λ 전환 비용도 pers_bucket 으로 0 쪽 양자화(hold_path_q) —
             도착 영역 안의 작은 기하 차이(한 칸 미만)는 동률로 두어 시드가 머묾 곡·마지막 곡을 가른다(§11 B5). 머묾 묶음(hold_cluster)이
             머묾 걸음을 turn_min 이하로 묶으므로 꺾임은 늘지 않는다. */
          cost: P ? (P.hold_path_q && isArrival && P.pers_bucket > 0 ? st.cost + c.distCost + qTrunc(pw * c.prog + jw * c.jump, P.pers_bucket) + c.pers + c.pj
                     : c.pj > 0 ? st.cost + c.distCost + pw * c.prog + jw * c.jump + c.pers + c.pj
                                : st.cost + c.distCost + pw * c.prog + jw * c.jump + c.pers)   // 덧셈 순서는 이전 식 그대로(중립 정책 I1)
                  : st.cost + c.distCost + pw * c.prog + jw * c.jump + mu * c.pmarg,   // [2.5.1] distCost: 이동=밴드값, 머무름=실거리
          prefSum: st.prefSum + c.pref,
          pbSum: st.pbSum + c.pbucket,
          jitSum: st.jitSum + c.jitter,
          prevSong: s,
          /* [2026-09-29] 도착 상한용 — 마지막 이동 곡의 목표 거리(머묾 걸음은 그대로 물려받는다) */
          arriveD: P && !isArrival ? R9(dist(ctx.coords.get(s.song_id), tgtC, term)) : st.arriveD,
          /* [2026-09-29] 머묾 묶음용 — 이 상태가 고른 머묾 곡 좌표 */
          holdC: P && isArrival && P.hold_cluster ? [...st.holdC, ctx.coords.get(s.song_id)] : st.holdC,
          keyCount: P ? keyCountAfter(st.keyCount, s, PR.keysOf) : st.keyCount,
          replays: P && PR.replay.has(s.song_id) ? st.replays + 1 : st.replays,
          picks: [...st.picks, pick],
        });
      }
    }
    if (!next.length) break;
    next.sort((a, b) => cmpKeys([R9(a.cost), -a.pbSum, R9(a.jitSum), ...a.used],
                                [R9(b.cost), -b.pbSum, R9(b.jitSum), ...b.used]));
    beam = next.slice(0, beamW);
  }

  const best = beam[0];
  /* [2.5.1] 검색은 매 걸음 그 순간 최선을 그리디로 고르므로, 도착 후 머무름 구간(경유지가 전부 목표 그 자체)에서는
     먼저 뽑힌 곡이 가장 가깝고 뒤로 갈수록 남은 후보 중 상대적으로 먼 곡이 걸려 '마지막이 오히려 더 멀어지는' 지그재그가 생긴다.
     그래서 이 구간만 사후에 '먼 것 → 가까운 것' 순으로 다시 배열해 마지막 곡이 항상 가장 가깝게(=도착) 끝나도록 한다.
     어떤 곡을 쓸지는 그대로 두고 순서만 바꾼다 — 검색이 고른 곡 집합은 바뀌지 않는다.
     [2.6.0-wp] P 모드는 정책의 hold_order 로 재배열한다(orderHold — 중립 "fit" 은 이 정렬 그대로). */
  let picks = best.picks;
  if (picks.length > 1) {
    const lastWp = picks.at(-1).wp;
    let start = picks.length;
    while (start > 0 && picks[start - 1].wp[0] === lastWp[0] && picks[start - 1].wp[1] === lastWp[1]) start--;
    if (picks.length - start > 1) {
      const tail = P ? orderHold(picks.slice(start), P, ctx, nowC, tgtC, term, start > 0 ? picks[start - 1] : null, rules, start > 1 ? picks[start - 2] : null)
                     : picks.slice(start).slice().sort((a, b) => b.fit - a.fit);
      picks = [...picks.slice(0, start), ...tail];
    }
  }
  const featLabel = Object.fromEntries([...((rules.preference && rules.preference.features) || []), ...((P && P.taste_features) || [])]
    .map((f) => [f.id, f.label || f.id]));
  const out = picks.map((pk, i) => {
    const s = pk.song;
    const c = ctx.coords.get(s.song_id);
    const trace = {
      step_index: i + 1,
      step_total: best.picks.length,
      wp_V: R6(pk.wp[0]),
      wp_A: R6(pk.wp[1]),
      va_distance: R6(pk.fit),
      quadrant: quadrantOf(c, ctx, rules),
      gates_passed: gates.map((g) => g.id).sort(),
      gates_failed: blocked,
      band_size: pk.bandSize,
      pref_score: R6(pk.pref),
      /* 선호 점수가 어떤 기록에서 나왔는지 — 화면 설명과 사후 분석용.
         '닮았다'고 말하는 기준은 순위가 실제로 구분하는 폭(variation.pref_bucket)과 같다:
         이 사용자의 중립점(내 평균 좋아요 비율)보다 한 버킷 이상 높을 때만. 그보다 작은 차이는 순위를 바꾸지 못하므로 설명으로도 내세우지 않는다.
         pref_basis 에는 그만큼 높았던 항목만 적는다(예: "말 비중" — 세 특징을 전부 나열하지 않는다). */
      ...(() => {
        const pb = pbucket > 0 ? pbucket : 0.05;
        const neutral = pk.neutral ?? 0.5;
        const above = (v) => Math.floor(R9(v) / pb) > Math.floor(R9(neutral) / pb);
        const pos = (pk.basis || []).filter((x) => above(x.score)).map((x) => PREF_LABELS[x.id] || featLabel[x.id] || x.id);
        const match = above(pk.pref) && pos.length > 0;
        return { pref_basis: match ? pos.join("·") : null, pref_match: match };
      })(),
      chosen_by: pk.bandSize > 1 ? "preference" : "geometry",
      tiebreak_used: null,
      path_cost: R6(best.cost),
      coord_space: rules.coordinate_space ?? null,
      strategy,
      pool_size: pk.pool,
      step_relaxed: pk.relaxed,
      seed: seed ?? null,
      pref_bucket: pk.pbucket,
      jitter: R6(pk.jitter),
      artist: s.artist ?? null,
      /* wp_V/wp_A 는 작업 좌표계(coord_space)의 값이다. song_V/song_A 를 원좌표로만
         남기면 로그에서 두 점의 거리를 다시 계산할 때 좌표계가 섞여 틀린 값이 나온다
         (percentile 사용 시 0.280 vs 실제 0.126). wp_* 와 같은 공간의 값을 함께 남긴다.
         raw 좌표계에서는 두 쌍의 값이 동일하므로 기존 분석과 호환된다. */
      song_V: R6(c[0]),            // 작업 좌표계 — wp_V 와 짝
      song_A: R6(c[1]),            // 작업 좌표계 — wp_A 와 짝
      song_V_raw: Number(s.V),     // 원좌표 (카탈로그 값)
      song_A_raw: Number(s.A),
      va_source: s.va_source ?? null,
      rules_hash: rules.rules_hash,
      ...(P ? personalTrace(pk, rules) : {}),   // [2.6.0-wp] P 모드에서만 p_* 키
    };
    return { song_id: s.song_id, trace, explanations: renderExplanations(rules, trace) };
  });

  return {
    rules_version: rules.rules_version,
    rules_hash: rules.rules_hash,
    engine_version: ENGINE_VERSION,
    baselines: baseOut,
    song_count: songCountOut,
    genre_restricted: genreApplied,
    relaxed_steps: best.picks.filter((p) => p.relaxed).length,
    sequence: out,
    ...(P ? { personal: personalOut(best, discStep) } : {}),
  };
}

/* ── 더 들을 곡 (2.6.0-wp, 명세 §4.11·§6.7) ─────────────────
   경로 뒤를 채우는 곡을 엔진이 고른다 — 앱이 원좌표 거리순으로 채우던 것(가사 게이트 누락 B21, 취향·상한·시드·전환 무시 B22)을 대체.
   inputs 는 recommend 에 준 최종 입력 그대로, result 는 그 결과. **result.sequence(경로)는 절대 바꾸지 않는다.**
   1) 후보 = 경로와 같은 게이트(가사 게이트 포함)·싫어요·exclude_ids·장르 정책 + 소프트 게이트(걸음 폴백과 같은 규칙) − 경로 곡
   2) 가수 상한은 경로에서 쓴 카운트에 이어서 센다(키 단위면 키로)
   3) 탐욕 1폭: 경유지 = 목표, distCost = fit ≤ R_x ? 0 : fit (R_x = max(유효 머묾 반경, extras.radius)),
      pers = §3.8 머묾 규칙(J = j_hold, 가점은 fit ≤ R_x 에서만), 앞 곡 = 직전에 고른 곡(첫 곡은 경로 마지막 곡)
   4) 곡 길이 = duration_ms/1000(없으면 default_duration_s), 최소 min_duration_s. 경로+더 들을 곡 합이 target_sec 에 닿거나
      max_songs 곡이면 멈춘다. target_sec 을 안 주면 감상 시간 × 60 × fill_ratio.
   반환 { extras: [{ song_id, trace, explanations }], total_sec(경로 + 더 들을 곡 초), soft_relaxed }.
   inputs.personal 이 없으면(익명·개인화 끔) { extras: [], total_sec: 0 } — 앱의 옛 경로를 쓴다. */
export function recommendExtras(catalog, rules, inputsIn, result, opts = {}) {
  const dur = inputsIn.duration_min ?? 30;
  const P = sanitizePersonal(inputsIn.personal, rules, { duration_min: dur, pace: inputsIn.pace });
  if (!P || !result || !Array.isArray(result.sequence)) return { extras: [], total_sec: 0, soft_relaxed: false };
  const X = rules.personalization.extras || {};
  const term = rules.ranking.terms[0];
  const ctx = prepareCached(catalog, rules);
  const nowC = toCoord(ctx, inputsIn.now), tgtC = toCoord(ctx, inputsIn.target);
  const { n } = songPlan(rules, term, nowC, tgtC, dur);
  const inputs = { ...inputsIn, _n_songs: n };
  const { active } = applyModulators(rules, inputs);
  const gateIds = new Set([...active, ...(inputs.gates || [])]);
  const gates = rules.gates.filter((g) => gateIds.has(g.id));
  const { uni } = eligibleUniverse(catalog, rules, ctx, inputs, gates, P);

  const byId = new Map(catalog.map((s) => [s.song_id, s]));
  const pathIds = result.sequence.map((r) => r.song_id);
  const used = new Set(pathIds);
  const soft = softFilter(uni.filter((s) => !used.has(s.song_id)), rules.gates.filter((g) => P.soft_gates.includes(g.id)), ctx, P.soft_min_pool);

  const PR = { P, replay: new Set(P.replay_ids), aa: {}, rEff: 0 };
  const keyMemo = new Map();
  PR.keysOf = (s) => { let v = keyMemo.get(s); if (v === undefined) { v = artistKeys(s.artist); keyMemo.set(s, v); } return v; };
  const cap = P.artist_cap;
  const state = { artistCount: {}, keyCount: {}, replays: 0 };
  for (const id of pathIds) {
    const s = byId.get(id);
    if (!s) continue;
    state.artistCount[s.artist] = (state.artistCount[s.artist] || 0) + 1;
    state.keyCount = keyCountAfter(state.keyCount, s);
    if (PR.replay.has(id)) state.replays++;
  }
  const lenOf = (s) => {
    const ms = Number(s && s.duration_ms);
    return Math.max(Number(X.min_duration_s), Number.isFinite(ms) && ms > 0 ? ms / 1000 : Number(X.default_duration_s));
  };
  let total = pathIds.reduce((a, id) => a + lenOf(byId.get(id)), 0);
  const tsec = (opts || {}).target_sec;
  const target = tsec !== null && tsec !== undefined && Number.isFinite(Number(tsec)) ? Number(tsec) : dur * 60 * Number(X.fill_ratio);
  const maxN = Number(X.max_songs);

  const rEff = n >= P.hold_min_songs ? P.hold_radius : 0;
  const Rx = Math.max(rEff, Number(X.radius));
  const varc = rules.variation || {};
  const seed = varc.enabled ? inputs[varc.seed_input || "seed"] ?? null : null;
  /* 곡마다 변하지 않는 값은 한 번만 — [perf] 선호·동점 키는 처음 평가할 때(lazy), 후보는 fit 오름차순(안정 정렬)으로 훑는다 */
  const pre = soft.pool.map((s) => {
    const c = ctx.coords.get(s.song_id);
    const fit = R9(dist(c, tgtC, term));
    return { song: s, c, fit, pmarg: undefined, distCost: fit <= Rx ? 0 : fit, tk: undefined };
  }).sort((a, b) => a.fit - b.fit);
  const prune = P.corridor_bands != null;   // 코리도어가 없으면(중립 정책) 밖의 곡도 가점을 받을 수 있어 끝까지 훑는다
  const lazy = (x) => {
    if (x.pmarg === undefined) {
      const pd = prefDetail(x.song, rules, inputs.user, P.taste_features);
      x.pmarg = R9((pd.neutral ?? 0.5) - pd.score);
      x.tk = tiebreakKeys(x.song, rules);
    }
    return x;
  };

  const extras = [];
  let prevSong = pathIds.length ? byId.get(pathIds.at(-1)) || null : null;
  const n0 = pathIds.length;
  for (let j = 0; total < target && extras.length < maxN; j++) {
    let best = null, bestKey = null;
    for (const x of pre) {
      /* [perf] 정확한 조기 종료: fit > Rx 인 곡은 distCost = fit 이고 가점이 막혀(bonusOK = false) pers ≥ 0 → key ≥ R9(fit).
         fit 오름차순이므로 R9(fit) 가 지금 최선 키보다 크면 뒤의 모든 곡은 첫 키에서 진다(cmpKeys 는 첫 키가 크면 곧바로 1). */
      if (prune && best && x.distCost > 0 && R9(x.fit) > bestKey[0]) break;
      if (used.has(x.song.song_id) || !personalAllows(x.song, state, PR, cap)) continue;
      lazy(x);
      const ax = prevSong ? adjFeatures(prevSong, x.song, P) : null;
      const adj = ax ? adjCostOf(ax, P) : 0;
      const taste = P.mu * x.pmarg;
      const r = personalKey({ distCost: x.distCost, fit: x.fit, arrival: true, rEff: Rx, taste, adj }, P);
      const jit = R9(jitterOf(seed, x.song.song_id, n0 + j));
      const k = [r.key, jit, ...x.tk, String(x.song.song_id)];
      if (!best || cmpKeys(k, bestKey) < 0) { best = { x, ax, adj, pers: r.pers, jit }; bestKey = k; }
    }
    if (!best) break;
    const s = best.x.song;
    used.add(s.song_id);
    state.artistCount[s.artist] = (state.artistCount[s.artist] || 0) + 1;
    state.keyCount = keyCountAfter(state.keyCount, s);
    if (PR.replay.has(s.song_id)) state.replays++;
    total += lenOf(s);
    prevSong = s;
    const trace = {
      phase: "extra",
      step_index: n0 + j + 1,
      va_distance: R6(best.x.fit),
      p_phase: "extra",
      p_extra: true,
      p_pmarg: R6(best.x.pmarg),
      p_pers: R6(best.pers),
      p_adj: R6(best.adj),
      p_adj_x: adjXOut(best.ax),
      p_bpm_diff: best.ax ? best.ax.bpm_diff : null,
      p_replay: PR.replay.has(s.song_id),
      jitter: R6(best.jit),
      artist: s.artist ?? null,
      song_V: R6(best.x.c[0]),
      song_A: R6(best.x.c[1]),
      song_V_raw: Number(s.V),
      song_A_raw: Number(s.A),
      va_source: s.va_source ?? null,
      rules_hash: rules.rules_hash,
    };
    /* 걸음 문구(step_move)는 경로 전용이라 조건(when)이 있는 설명만 붙인다 — "목표 분위기를 이어 가는 곡이에요." 등 */
    extras.push({ song_id: s.song_id, trace, explanations: renderExplanations({ explanations: (rules.explanations || []).filter((e) => e.when) }, trace) });
  }
  return { extras, total_sec: R6(total), soft_relaxed: soft.relaxed };
}
