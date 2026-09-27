/*
 * 격자 실행 (TOOLS · 명세 §11 B·C, §4.8.2 D7 스윕) — 신규 사용자 기본 정책 P0(= 빈 모델의 resolvePolicy)와 2.5.1 을 같은 시나리오로.
 *
 *   gridRun({ deps, shared, scenarios, mode, rules })   mode "p0"(web-personal 신규 회원) | "twin"(76e8bdf 엔진·규칙, 신규 사용자)
 *       → 압축 결과 [{ sc, m(경로 모양), ids }] — 워커에서 돌려 보내기 쉽게 엔진 결과 전체는 남기지 않는다
 *   isoSummary(runs)   B1–B5: 도착 오차 · 최대 전환 · 역행 · 꺾임 · 지그재그 · 첫 곡 거리 · 같은 곡으로 끝남 · 목표 칩당 머묾 곡 수
 *   adjSummary(runs)   C1: 인접 BPM 차 · 보컬↔연주 · 튀는 전환(2개 이상) · 서로 다른 곡 수
 *   patchRules(rules, "adjacency.scale", 1.5)   personalization 절 한 값을 바꾼 사본(스윕용)
 */
import { normScenario } from "./lib_env.mjs";
import { pathShape, adjPairs, q, rate } from "./lib_metrics.mjs";

/* 격자 단어 → 로그 라벨 모양. 칩 이름이면 chip, 아니면(자연어 추가 단어) nl 강도 2('꽤') */
function labelsOf(sc, vocab) {
  const isMood = vocab.mood_chips.some((c) => c[0] === sc.now_label), isGoal = vocab.goal_chips.some((c) => c[0] === sc.goal_label);
  return {
    current: isMood ? { mode: "chip", chip: sc.now_label } : sc.now_label ? { mode: "nl", nl: [{ label: sc.now_label, intensity: 2 }] } : { mode: "tap" },
    target: isGoal ? { mode: "chip", chip: sc.goal_label } : sc.goal_label ? { mode: "nl", nl: sc.goal_label } : { mode: "tap" },
  };
}
const compact = (sc, res) => {
  const m = pathShape(res);
  if (m) delete m.waypoints;
  return { sc, m, ids: res.sequence.map((x) => x.song_id) };
};

/** personalization.<path> 를 value 로 바꾼 규칙 사본 ("personalization." 접두어는 있어도 없어도 된다) */
export function patchRules(rules, p, value) {
  const out = JSON.parse(JSON.stringify(rules));
  const keys = String(p).replace(/^personalization\./, "").split(".");
  let o = out.personalization;
  for (const k of keys.slice(0, -1)) { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
  o[keys.at(-1)] = value;
  return out;
}

export function gridRun({ deps, shared, scenarios, mode, rules = null }) {
  const R = rules || deps.rules;
  const out = [];
  if (mode === "twin") {
    const { engine, rules: bR } = deps.baseline;
    for (const raw of scenarios) {
      const sc = normScenario(raw);
      const input = raw.inputs || { now: { V: sc.now.v, A: sc.now.e }, target: { V: sc.target.v, A: sc.target.e }, stress: null, load: null, genres: [], duration_min: sc.minutes, seed: sc.seed, gates: [], user: { disliked: [], recent_played: [], global_stats: {} } };
      out.push(compact(sc, engine.recommend(shared.contract, bR, input)));
    }
    return out;
  }
  const { personal, engine } = deps;
  const model = personal.emptyModel(R);
  for (const raw of scenarios) {
    const sc = normScenario(raw);
    const labels = labelsOf(sc, deps.vocab);
    const ctx = { now: sc.now, target: sc.target, now_table: sc.now, target_table: sc.target, labels, nudged: { current: false, target: false },
                  minutes: sc.minutes, lyric: "no_preference", genres: [], pace_user: null, seed: sc.seed, global_stats: {}, disliked_now: [], session_no: 1 };
    const pol = personal.resolvePolicy(model, ctx, R);
    const base = raw.inputs || { now: { V: sc.now.v, A: sc.now.e }, target: { V: sc.target.v, A: sc.target.e }, stress: null, load: null, genres: [], duration_min: sc.minutes, seed: sc.seed, gates: [] };
    out.push(compact(sc, engine.recommend(shared.contract, R, { ...base, user: pol.user, pace: null, personal: pol.policy })));
  }
  return out;
}

export function isoSummary(runs) {
  const M = runs.filter((x) => x.m && x.m.n >= 2);
  const m = M.map((x) => x.m);
  const holds = m.filter((x) => x.holdZig !== null);
  // B5: 같은 (지금, 목표, 분) 에서 시드만 다른 세션 쌍이 같은 곡으로 끝나는 비율 (30·60분)
  const groups = new Map();
  for (const x of M) if (x.sc.minutes === 30 || x.sc.minutes === 60) {
    const k = `${x.sc.now_label}|${x.sc.goal_label}|${x.sc.minutes}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x.m.last_id);
  }
  let pairs = 0, same = 0;
  for (const ids of groups.values()) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { pairs++; if (ids[i] === ids[j]) same++; }
  const byGoal = new Map();
  for (const x of M) { if (!byGoal.has(x.sc.goal_label)) byGoal.set(x.sc.goal_label, new Set()); for (const id of x.m.hold_ids) byGoal.get(x.sc.goal_label).add(id); }
  const hd = [...byGoal.values()].map((s) => s.size);
  return {
    n: m.length,
    arr50: q(m.map((x) => x.arrival), 0.5), arr90: q(m.map((x) => x.arrival), 0.9), jump50: q(m.map((x) => x.maxJump), 0.5), jump90: q(m.map((x) => x.maxJump), 0.9),
    back: rate(m, (x) => x.back > 0), turns: rate(m, (x) => x.turns > 0), holdTurns: rate(m, (x) => x.holdTurns > 0),
    zig: holds.length ? rate(holds, (x) => x.holdZig) : 0, zigN: holds.length,
    start50: q(m.map((x) => x.start), 0.5), sameEnd: pairs ? same / pairs : NaN, holdDistinct: hd.length ? hd.reduce((a, b) => a + b, 0) / hd.length : NaN,
    holdDistinctByGoal: Object.fromEntries([...byGoal].map(([g, s]) => [g, s.size])),
  };
}

export function adjSummary(runs, byId) {
  const pairs = [], all = new Set();
  for (const r of runs) {
    for (const id of r.ids) all.add(id);
    pairs.push(...adjPairs(r.ids, byId));
  }
  return {
    n: runs.length, pairs: pairs.length,
    bpm50: q(pairs.map((p) => p.bpm), 0.5), bpm90: q(pairs.map((p) => p.bpm), 0.9),
    flip: rate(pairs, (p) => p.flip), flags2: rate(pairs, (p) => p.flags >= 2), distinct: all.size,
  };
}

/** 스윕 판정(§4.8.2): iso 봉투(B1–B5, 격자 문턱)를 지키는가 · 구성 목표(C1a–d) 몇 개 달성 */
export function envelopeOk(iso, C) {
  /* 잴 수 없는 값(표본 격자에서 시드 쌍이 없는 경우 등)은 판정에서 뺀다 — 표에는 "—" 로 보인다 */
  const le = (x, t) => !Number.isFinite(x) || x <= t, ge = (x, t) => !Number.isFinite(x) || x >= t;
  return le(iso.arr50, C.B1.med) && le(iso.arr90, C.B1.grid_p90) && le(iso.jump50, C.B2.grid_med) && le(iso.back, C.B3.back) && le(iso.turns, C.B3.turns)
    && iso.zig === 0 && le(iso.start50, C.B4.med) && le(iso.sameEnd, C.B5.same_end) && ge(iso.holdDistinct, C.B5.hold_distinct);
}
/** 봉투 기준 중 어긋난 ID 목록 (B1–B5, 격자 문턱) — 모든 조합이 봉투 밖일 때 "봉투에 가장 가까운 점"을 고르는 데 쓴다(§11: 봉투는 완화하지 않고 차이를 보고) */
export function envelopeFails(iso, C) {
  const le = (x, t) => !Number.isFinite(x) || x <= t, ge = (x, t) => !Number.isFinite(x) || x >= t;
  const out = [];
  if (!(le(iso.arr50, C.B1.med) && le(iso.arr90, C.B1.grid_p90))) out.push("B1");
  if (!le(iso.jump50, C.B2.grid_med)) out.push("B2");
  if (!(le(iso.back, C.B3.back) && le(iso.turns, C.B3.turns) && iso.zig === 0)) out.push("B3");
  if (!le(iso.start50, C.B4.med)) out.push("B4");
  if (!(le(iso.sameEnd, C.B5.same_end) && ge(iso.holdDistinct, C.B5.hold_distinct))) out.push("B5");
  return out;
}
export function compositionScore(adj, C) {
  return (adj.bpm50 <= C.C1.bpm_med && adj.bpm90 <= C.C1.bpm_p90 ? 1 : 0) + (adj.flip <= C.C1.flip ? 1 : 0) + (adj.flags2 <= C.C1.flags2 ? 1 : 0) + (adj.distinct >= C.C1.distinct ? 1 : 0);
}
