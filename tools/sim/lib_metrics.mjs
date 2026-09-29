/*
 * 시뮬레이터 지표 (TOOLS · 명세 §11) — 경로 모양(B), 인접 구성(C), 쌍 부트스트랩, 전환 배수 대조 적합(F4).
 *
 * 경로 모양의 정의는 eumchichi-data `scripts/analysis/iso_path_quality.mjs`(origin/analysis/nl-path-personal)와 같다 — 비교 가능하게:
 *   역행        이동 구간에서 목표와의 거리가 앞 곡보다 0.01 넘게 멀어진 걸음
 *   방향 꺾임    연속 두 걸음(각 0.02 넘는 이동)이 90° 넘게 꺾임
 *   머묾 지그재그 머묾 구간(경유지 = 목표)이 2곡 이상일 때 마지막 곡이 가장 가깝지 않음
 *   도착 오차    마지막 곡 ↔ 목표(작업 좌표), 첫 곡 거리 = 첫 곡 ↔ 첫 경유지, 최대 전환 = 인접 곡 거리 최댓값
 * 인접 구성의 정의는 `scripts/analysis/adjacent_similarity.mjs`(origin/master)와 같다:
 *   BPM 차 = |tempo_a − tempo_b|·150, 보컬↔연주 = instrumental 이 다름, 튀는 전환 = ① BPM 차 ≥ 무작위 쌍 중앙(29.7)
 *   ② 버튼 장르 공유 없음 ③ 보컬↔연주 중 2개 이상. 서로 다른 곡 수 = 실행 전체의 경로 곡 합집합.
 */
import { u01 } from "./lib_rng.mjs";

export const SHAPE = { back_tol: 0.01, turn_min: 0.02 };                 // iso_path_quality.mjs BACK_TOL · TURN_MIN
export const ADJ = { bpm_span: 150, tempo_cut_bpm: 29.7 };                // adjacent_similarity_20260925 §2 (무작위 쌍 중앙)

const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 엔진 결과(sequence 의 trace: wp_V·wp_A·song_V·song_A — 작업 좌표) → 경로 모양 */
export function pathShape(res) {
  const s = (res && res.sequence) || [];
  if (!s.length) return null;
  const c = s.map((it) => [it.trace.song_V, it.trace.song_A]);
  const wp = s.map((it) => [it.trace.wp_V, it.trace.wp_A]);
  const t = wp.at(-1);
  let hs = s.length - 1; while (hs > 0 && d(wp[hs - 1], t) < 1e-9) hs--;   // 머묾 구간 시작
  let back = 0, moveSteps = 0, turns = 0, holdTurns = 0, len = 0;
  const turnAt = [];   // 꺾임 꼭짓점 위치(머묾 첫 곡 = 0 기준) — 진단용
  for (let i = 1; i < c.length; i++) {
    len += d(c[i], c[i - 1]);
    if (i <= hs) { moveSteps++; if (d(c[i], t) > d(c[i - 1], t) + SHAPE.back_tol) back++; }
    if (i + 1 < c.length) {
      const u = [c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]], v = [c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]];
      if (Math.hypot(...u) > SHAPE.turn_min && Math.hypot(...v) > SHAPE.turn_min && u[0] * v[0] + u[1] * v[1] < 0) { turns++; turnAt.push(i - hs); if (i >= hs) holdTurns++; }
    }
  }
  const hold = c.slice(hs);
  return {
    n: s.length, back, moveSteps, turns, holdTurns, turn_at: turnAt, len, journey: d(wp[0], t),
    hold_n: hold.length,
    holdZig: hold.length >= 2 ? d(hold.at(-1), t) > Math.min(...hold.map((p) => d(p, t))) + 1e-9 : null,
    start: d(c[0], wp[0]), arrival: d(c.at(-1), t),
    maxJump: c.length > 1 ? Math.max(...c.slice(1).map((p, i) => d(p, c[i]))) : 0,
    arrival_index: hs + 1,                         // 도착 곡 번호(1부터) = 경유지가 처음 목표와 같아지는 걸음
    hold_ids: s.slice(hs).map((it) => it.song_id), last_id: s.at(-1).song_id,
    waypoints: wp,
  };
}

/** 인접 쌍 특징 (측정 정의) */
export function adjPair(a, b) {
  const dT = typeof a.tempo === "number" && typeof b.tempo === "number" ? Math.abs(a.tempo - b.tempo) : NaN;
  const shared = (b.genres || []).some((g) => (a.genres || []).includes(g));
  const flip = typeof a.instrumental === "boolean" && typeof b.instrumental === "boolean" && a.instrumental !== b.instrumental;
  const bpm = dT * ADJ.bpm_span;
  const flags = (bpm >= ADJ.tempo_cut_bpm ? 1 : 0) + (shared ? 0 : 1) + (flip ? 1 : 0);
  return { bpm, flip, shared, d_spoken: Math.abs((a.spokenness ?? 0.5) - (b.spokenness ?? 0.5)), flags };
}
export function adjPairs(ids, byId) {
  const out = [];
  for (let i = 1; i < ids.length; i++) {
    const a = byId.get(ids[i - 1]), b = byId.get(ids[i]);
    if (a && b) out.push(adjPair(a, b));
  }
  return out;
}

// ── 통계 ────────────────────────────────────────────────
/** 분위수 — iso_path_quality.mjs q() 와 같은 정의(ceil) */
export function q(values, p) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : NaN;
}
export const mean = (v) => { const f = v.filter(Number.isFinite); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN; };
export const rate = (v, pred) => (v.length ? v.filter(pred).length / v.length : NaN);
export const sum = (v) => v.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

/**
 * 쌍 부트스트랩 (반복×세션 단위로 다시 뽑음, 기본 2,000회) — 95% 백분위 구간.
 * @param units  단위 배열 (각 단위가 합산할 값들을 가진 객체)
 * @param stat   units → 숫자 (예: 비율의 차 = Σwp_skip/Σwp_exp − Σtw_skip/Σtw_exp)
 */
export function bootstrap(units, stat, { B = 2000, seed = "boot" } = {}) {
  const est = stat(units);
  if (!units.length) return { est, lo: NaN, hi: NaN, n: 0 };
  const vals = [];
  for (let b = 0; b < B; b++) {
    const sample = new Array(units.length);
    for (let i = 0; i < units.length; i++) sample[i] = units[Math.floor(u01(`${seed}|${b}|${i}`) * units.length)];
    const v = stat(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const at = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))];
  return { est, lo: at(0.025), hi: at(0.975), n: units.length };
}

/**
 * 전환 배수 대조 적합 (F4 진단 전용 — 학습기는 engine/personal.js). 명세 §4.8.3 의 결합 곱셈 모형을 그대로 옮겼다.
 *   useQ = true  : 로그의 취향 기대 거절률 q 를 오프셋으로
 *   useQ = false : 모든 전환에 모집단 q̄ = σ(θ0) (취향 통제 없음) — "q 없이 적합하면 배수가 부푸나"
 * @param transitions NormalizedLog 의 sessions[].transitions ({ label, w, L:{tempo,vocal,spoken,genre,va}, q })
 */
export function fitAdjacency(transitions, adj, { useQ = true } = {}) {
  const F = ["tempo", "vocal", "spoken", "genre", "va"];
  const kappa = Number(adj.kappa ?? 2), iters = Number(adj.iterations ?? 20);
  const [mlo, mhi] = adj.mult_range || [0.5, 2];
  const q0 = 1 / (1 + Math.exp(-Number(adj.theta0 ?? -1.73)));
  const T = (transitions || []).filter((t) => t && (t.label === 0 || t.label === 1)).map((t) => ({
    y: t.label, w: Number(t.w ?? 1), q: useQ && Number.isFinite(Number(t.q)) ? Number(t.q) : q0,
    L: Object.fromEntries(F.map((f) => [f, t.L && t.L[f] ? 1 : 0])),
  }));
  const m = Object.fromEntries(F.map((f) => [f, 1]));
  let m0 = 1;
  const prodM = (t, skip) => F.reduce((a, g) => (g === skip || !t.L[g] ? a : a * m[g]), 1);
  for (let it = 0; it < iters; it++) {
    m0 = (T.reduce((a, t) => a + t.w * t.y, 0) + kappa) / (T.reduce((a, t) => a + t.w * t.q * prodM(t, null), 0) + kappa);
    for (const f of F) {
      const num = T.reduce((a, t) => a + (t.L[f] ? t.w * t.y : 0), 0) + kappa;
      const den = T.reduce((a, t) => a + (t.L[f] ? t.w * t.q * m0 * prodM(t, f) : 0), 0) + kappa;
      m[f] = Math.exp(Math.min(Math.log(mhi), Math.max(Math.log(mlo), Math.log(num / den))));
    }
  }
  const O = Object.fromEntries(F.map((f) => [f, T.reduce((a, t) => a + (t.L[f] ? t.w * t.y : 0), 0)]));
  const nLarge = Object.fromEntries(F.map((f) => [f, T.filter((t) => t.L[f]).length]));
  const z = Number(adj.z_apply ?? 1.28), minLarge = Number(adj.min_large ?? 8), minTrans = Number(adj.min_transitions ?? 12);
  const applied = Object.fromEntries(F.map((f) => [f, Math.abs(Math.log(m[f])) >= z / Math.sqrt(O[f] + kappa) && nLarge[f] >= minLarge && T.length >= minTrans]));
  return { m, m0, O, nLarge, n: T.length, applied };
}
