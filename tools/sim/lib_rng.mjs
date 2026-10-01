/*
 * 시뮬레이터 공통 난수 (TOOLS · 명세 §9.4 "공통 난수") — 순수 ESM, DOM·Node 모듈 없음(브라우저 데모에서도 import).
 *
 * Math.random 을 쓰지 않는다. 난수는 전부 "키 문자열 → [0,1)" 해시로 만든다:
 *   u01(key) = fmix32(fnv1a32(key)) / 2³²   (엔진 jitterOf·seededUniform 과 같은 fnv1a32 계열 + murmur3 마무리 섞기)
 * 키는 (페르소나, 반복, 세션, song_id, 목적) 으로 잡는다 — 세 팔(wp·twin·frozen)에서 같은 곡에 같은 반응이 나오게(쌍 비교 분산 감소).
 * 한 값을 여러 번 뽑아야 하면(정규분포 등) 키 뒤에 "|n1" 같은 꼬리를 붙인다 — 순서에 기대지 않으므로 호출 순서가 바뀌어도 값이 같다.
 */
const TE = new TextEncoder();

export function fnv1a32(text) {
  let h = 2166136261;
  for (const b of TE.encode(String(text))) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/* murmur3 fmix32 — 끝 글자만 다른 키(…|1, …|2)가 비슷한 값을 내지 않게 한 번 더 섞는다 */
function fmix32(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
/** 키 → (0, 1) (양 끝 제외 — log·역함수에 바로 쓸 수 있게) */
export function u01(key) {
  return (fmix32(fnv1a32(key) || 0x9e3779b9) + 0.5) / 4294967296;
}
/** 키 → 표준정규 (Box–Muller, 두 꼬리 키) */
export function normal(key, mean = 0, sd = 1) {
  const a = u01(key + "|n1"), b = u01(key + "|n2");
  return mean + sd * Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}
/** 키 → 지수분포 (평균 mean) */
export function expo(key, mean) {
  return -mean * Math.log(u01(key));
}
/** 키 → 목록에서 하나 (균등) */
export function pick(key, list) {
  return list[Math.min(list.length - 1, Math.floor(u01(key) * list.length))];
}

// ── 베타분포 역함수 — 균등 하나로 뽑아 단조 결합(같은 키 = 같은 분위)을 지킨다 ───────────
function lgamma(x) {   // Lanczos (g=7, n=9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(a, b, x) {   // Numerical Recipes 연분수
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
/** 정규화 불완전 베타 I_x(a, b) */
export function betaCdf(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** 베타 분위수 (이분법 60회 — 결정적) */
export function betaInv(u, a, b) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (betaCdf(m, a, b) < u) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}
/** 표준정규 누적분포 (erf 는 Abramowitz–Stegun 7.1.26 근사 — 절대오차 < 1.5e-7) */
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
