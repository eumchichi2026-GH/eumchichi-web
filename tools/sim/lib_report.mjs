/*
 * 수용 기준 계산과 보고서 (TOOLS · 명세 §11) — run.mjs 가 모은 세션 기록으로 B–H 를 계산하고 markdown 을 만든다.
 * **모든 수치는 합성 사용자 기준**이다(§9.4) — 표 머리와 본문에 그렇게 적는다.
 *
 * 기록(R)의 세션 번호 ks = 평가용 1..10 (P13 은 앞의 fix-web 형식 10세션을 빼고 센다). "N세션 안에" 는
 * "세션 N 까지의 기록으로 만든 모델", 즉 세션 2..N+1 을 시작할 때의 모델·정책 또는 마지막 세션 뒤 모델(F 기록)로 읽는다.
 */
import { q, mean, rate, sum, bootstrap } from "./lib_metrics.mjs";

export const CRIT = {   // §11 문턱 (명세 값 그대로 — 바꾸려면 change.md 에 사유)
  B1: { med: 0.025, p90: 0.040, grid_p90: 0.036 }, B2: { p90: 0.25, over_twin: 0.02, grid_med: 0.155 },
  B3: { back: 0.015, turns: 0.12, zig: 0 }, B4: { med: 0.022 }, B5: { same_end: 0.35, hold_distinct: 12 }, B8: { fallback: 0.05 },
  C1: { bpm_med: 24, bpm_p90: 68, flip: 0.07, flags2: 0.28, distinct: 600 },
  D1: { pi: 0.35, within: 5, reps: 0.8 }, D2: { err: 0.04, reps: 0.8 }, D3: { m: 1.3, reps: 0.6, bpm_ratio: 0.8 }, D4: { ratio: 0.5 },
  D5: { mult: 1.5, add: 0.10, add_p5: 0.05 }, D6: { within: 5, reps: 0.8, spoken: 0.05 }, D7: { within: 6, window: 120, after: 5 },
  D8: { rate: 0.5 }, D9: { rate: 0.8, within: 6, minutes: 25 }, D10: { reps: 0.5, ratio: 0.8 }, D11: { half: [0.4, 0.6] },
  E1: { ratio: 0.85 }, E2: { ratio: 1.2 }, E3: { add: 0.03 }, E4: { add: 0.15 }, E5: { ratio: 0.9 }, E6: { wp: 0.9, twin: 0.95 }, E7: { abs: 0.03, ci_lo: -0.10 },
  F1: { pi: 0.3, calib: 0.02, m: [0.8, 1.25], rate: 0.8 }, F3: { shift: 0.03 },
  G: { r: 0.035, s: 0.075 },
  H1: { runs: 100 }, H4: { rate: 0.9 }, H5: { model_ms: 50, policy_ms: 5, run_ms: 150, total_ms: 400 },
};
const E_PERSONAS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];

/** 명세 §11 기준 ID 전부 (A–I 판정 대상 + J 수동) — run.mjs 가 표에 없는 ID 를 "측정 안 됨"·불합격으로 채운다. how = 어디서 재나 */
export const SPEC_IDS = [
  ...[["A1", "I0: personal 없음 — 1,224 + 660 + 탐침 격자에서 2.6.0-wp vs 2.5.1", "100% 일치"], ["A2", "inputs.pace fast/slow vs 옛 규칙 사본 경로", "100%"],
      ["A3", "I1: neutralPolicy — 곡 순서·2.5.1 trace 키", "100%"], ["A4", "aggregateAffinity 2인자, 무작위 항목 집합 200", "100%"]]
    .map(([id, title, target]) => ({ id, group: "A", title, target, how: "external.mjs → regress.mjs --grid all --check all" })),
  { id: "A5", group: "A", title: "P13(옛 기록만) 모델 빌드", target: "오류 0 · n_sessions_legacy > 0 · 취향 표 생성", how: "run.mjs --personas P13" },
  ...[["B1", "도착 오차 중앙 / 90%"], ["B2", "세션 최대 전환 거리 90%"], ["B3", "역행 / 꺾임 / 머묾 지그재그"], ["B4", "첫 곡↔지금 거리 중앙 (s = 0)"],
      ["B6", "경로 모수가 P0 와 같은 정책의 경유지 동일"], ["B8", "안전 폴백 발생 세션"]]
    .map(([id, title]) => ({ id, group: "B", title: `[페르소나 · wp] ${title}`, target: "§11 B", how: "run.mjs --arms wp,twin" })),
  ...[["B1g", "도착 오차 중앙 / 90%"], ["B2g", "최대 전환 거리 중앙"], ["B3g", "역행 / 꺾임 / 지그재그"], ["B4g", "첫 곡↔지금 거리 중앙"],
      ["B5g", "같은 곡으로 끝남 / 목표 칩당 머묾 곡"], ["B6g", "P0 정책 경유지 = 2.5.1 경유지"]]
    .map(([id, title]) => ({ id, group: "B", title: `[iso1224 · P0] ${title}`, target: "§11 B", how: "run.mjs --grid" })),
  { id: "B7", group: "B", title: "§3.8 정리 위반(단위 시험 10만 조합)", target: "0", how: "external.mjs → node --test engine/test/*.test.mjs" },
  ...["C1a", "C1b", "C1c", "C1d"].map((id) => ({ id, group: "C", title: `[adj660 · P0] ${id}`, target: "§11 C", how: "run.mjs --grid" })),
  ...["D1", "D2", "D3", "D4", "D5·P1", "D5·P2", "D5·P3", "D5·P5", "D6", "D7", "D8", "D9", "D10", "D11"].map((id) => ({ id, group: "D", title: id, target: "§11 D", how: "run.mjs --personas all" })),
  ...["E1", "E2", "E3", "E4", "E5", "E6", "E7"].map((id) => ({ id, group: "E", title: id, target: "§11 E", how: "run.mjs --arms wp,twin,frozen" })),
  ...["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, group: "F", title: id, target: "§11 F", how: "run.mjs --personas all" })),
  { id: "G", group: "G", title: "P8 고긴장", target: "100%", how: "run.mjs --personas P8" },
  { id: "H1", group: "H", title: "같은 입력 100회", target: "100% 동일", how: "run.mjs (--h1-runs)" },
  { id: "H2", group: "H", title: "Node vs 브라우저 픽스처 20개", target: "100% 동일", how: "external.mjs --browser" },
  { id: "H3", group: "H", title: "replay.mjs 재현", target: "100%", how: "external.mjs (H3)" },
  { id: "H4", group: "H", title: "설명 충실도", target: "≥ 90%", how: "run.mjs" },
  { id: "H5", group: "H", title: "성능", target: "≤ 50 · ≤ 5 · ≤ 150 · ≤ 400 ms", how: "run.mjs (--h5) / bench_h5.mjs" },
  ...[["I·collections", "새 컬렉션 이름 0"], ["I·fs-writes", "Firestore 쓰기가 모두 fsWrite 안"], ["I·song-stats", "song_stats 키 ⊆ 기존 7개"],
      ["I·determinism", "engine/*.js 에 Math.random·Date.now 0"], ["I·rules-hash", "rules_hash 일치"], ["I·trace-keys", "trace_keys ⊇ 엔진 p_* 키"],
      ["I·sw-version", "sw.js VERSION ≠ azt-v9"], ["I·personalization", "personalization 절이 §10 키를 모두 가짐"],
      ["I·writes", "로컬 서버 기본 실행·데모 모드 Firestore 쓰기 호출 0"]]
    .map(([id, title]) => ({ id, group: "I", title, target: "✓", how: id === "I·writes" ? "external.mjs --browser (개발 페이지 카운터)" : "external.mjs → check.mjs" })),
  { id: "J", group: "J", title: "앱 수동 점검", target: "모두 확인", how: "수동(배포 전)" },
];

const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "—");
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—");
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const mark = (p) => (p === true ? "✅" : p === false ? "❌" : "—");
const ci = (b, f = f3) => (b && Number.isFinite(b.lo) ? `[${f(b.lo)}, ${f(b.hi)}]` : "—");

/* 판정 — 자료가 없으면(NaN) 합격도 불합격도 아닌 null(표에 "—") */
const fin = (x) => Number.isFinite(x);
const GE = (x, t) => (fin(x) && fin(t) ? x >= t : null);
const LE = (x, t) => (fin(x) && fin(t) ? x <= t : null);
const ALL = (...xs) => (xs.some((x) => x === false) ? false : xs.some((x) => x === null || x === undefined) ? null : true);
/** 적용 배수가 "1 이거나 [0.8, 1.25]" */
const multOk = (ms) => !ms || !ms.m_applied || Object.values(ms.m_applied).every((m) => m === 1 || (m >= CRIT.F1.m[0] && m <= CRIT.F1.m[1]));

export function evaluate(R, F, extra, rules) {
  const ok = R.filter((r) => !r.error && r.ks != null);
  const arm = (a) => ok.filter((r) => r.arm === a);
  const P = (id, a, lo = 1, hi = 10) => ok.filter((r) => r.persona === id && r.arm === a && r.ks >= lo && r.ks <= hi);
  const reps = (id, a) => [...new Set(ok.filter((r) => r.persona === id && r.arm === a).map((r) => r.rep))];
  const res = [];
  const add = (id, group, title, target, value, pass, note = "") => res.push({ id, group, title, target, value, pass, note });
  const wp = arm("wp").filter((r) => r.persona !== "P12F"), tw = arm("twin").filter((r) => r.persona !== "P12F");
  const personasRun = [...new Set(ok.map((r) => r.persona))];
  const has = (id, a) => P(id, a).length > 0;

  // ── A5 ──
  if (has("P13", "wp")) {
    const first = P("P13", "wp", 1, 1);
    const errs = R.filter((r) => r.persona === "P13" && r.error).length;
    const legacyOk = first.length && first.every((r) => r.model && Number(r.model.n_legacy) > 0);
    const votesOk = first.length && first.every((r) => r.model && (Number(r.model.vote_sum) > 0 || Number(r.model.E) > 0));
    add("A5", "A", "P13(옛 기록만) 모델 빌드", "오류 0 · n_sessions_legacy > 0 · 취향 표 생성",
      `오류 ${errs} · legacy 세션 ${first.map((r) => r.model && r.model.n_legacy).join("/")} · 표 합 ${first.map((r) => f2(r.model && r.model.vote_sum)).join("/")}`,
      errs === 0 && !!legacyOk && !!votesOk);
  }

  // ── B (페르소나 · wp 팔 · 세션 1–10) ──
  if (wp.length) {
    const sh = wp.map((r) => r.shape).filter(Boolean);
    const arr = sh.map((s) => s.arrival), mj = sh.map((s) => s.maxJump), twMj = tw.map((r) => r.shape && r.shape.maxJump).filter(Number.isFinite);
    add("B1", "B", "도착 오차 중앙 / 90%", `≤ ${CRIT.B1.med} / ≤ ${CRIT.B1.p90}`, `${f3(q(arr, 0.5))} / ${f3(q(arr, 0.9))}`, ALL(LE(q(arr, 0.5), CRIT.B1.med), LE(q(arr, 0.9), CRIT.B1.p90)));
    const twP90 = q(twMj, 0.9);
    add("B2", "B", "세션 최대 전환 거리 90%", `≤ ${CRIT.B2.p90} 이고 ≤ twin 90% + ${CRIT.B2.over_twin}`, `${f3(q(mj, 0.9))} (twin ${f3(twP90)})`,
      ALL(LE(q(mj, 0.9), CRIT.B2.p90), twMj.length ? LE(q(mj, 0.9), twP90 + CRIT.B2.over_twin) : true));
    const zig = sh.filter((s) => s.holdZig !== null);
    add("B3", "B", "역행 세션 / 90° 꺾임 세션 / 머묾 지그재그", `≤ 1.5% / ≤ 12% / 0%`,
      `${pct(rate(sh, (s) => s.back > 0))} / ${pct(rate(sh, (s) => s.turns > 0))} / ${pct(rate(zig, (s) => s.holdZig))} (${zig.length}세션)`,
      ALL(LE(rate(sh, (s) => s.back > 0), CRIT.B3.back), LE(rate(sh, (s) => s.turns > 0), CRIT.B3.turns), zig.filter((s) => s.holdZig).length === 0));
    const s0 = wp.filter((r) => r.shape && (!r.policy || !(r.policy.start_offset > 0)));
    add("B4", "B", "첫 곡↔지금 거리 중앙 (s = 0 세션)", `≤ ${CRIT.B4.med}`, `${f3(q(s0.map((r) => r.shape.start), 0.5))} (${s0.length}세션)`, LE(q(s0.map((r) => r.shape.start), 0.5), CRIT.B4.med));
    const b6 = wp.filter((r) => r.wp_same_as_ref !== null);
    add("B6", "B", "경로 모수가 P0 와 같은 정책의 경유지 동일", "100%", `${pct(rate(b6, (r) => r.wp_same_as_ref))} (${b6.length}세션)`, b6.length ? b6.every((r) => r.wp_same_as_ref) : null);
    {
      /* B8 = 모든 페르소나 · wp 팔 · 세션 1–10 에서 safetyCheck 가 위반을 내 A 를 버린(A′ 또는 R) 세션 비율 (세션당 추천 1회) */
      const fb = wp.filter((r) => !!r.fallback);
      const byP = {}, byV = {};
      for (const r of fb) { byP[r.persona] = (byP[r.persona] || 0) + 1; for (const v of r.safety_violations || []) byV[v] = (byV[v] || 0) + 1; }
      const pp = wp.filter((r) => r.path_personalized === true), np = wp.filter((r) => r.path_personalized === false);
      /* 위반 값 — 레인 "song" 이고 R_path 가 있으면 A 대 R_path, "path" 면 R_path 대 R, 레인 없음(옛 한 기준)이면 A 대 R */
      const det = fb.filter((r) => r.safety_detail).map((r) => {
        const d = r.safety_detail, lane = d.lane || null;
        const x = lane === "path" ? d.Rp || {} : d.A || {}, y = lane === "song" && d.Rp ? d.Rp : d.R || {};
        const xn = lane === "path" ? "Rp" : "A", yn = lane === "song" && d.Rp ? "Rp" : "R";
        return (r.safety_violations || []).map((v0) => { const v = String(v0).replace(/^path_/, "");
          return `${v0 !== v ? "경로 " : ""}${v === "reversal" ? `역행 ${xn} ${x.reversals}>${yn} ${y.reversals}` : v === "max_jump" ? `최대 전환 ${xn} ${f3(x.max_jump)} vs ${yn} ${f3(y.max_jump)}` : v === "arrival" ? `도착 ${xn} ${f3(x.arrival)} vs ${yn} ${f3(y.arrival)}` : v}`; }).join("·");
      });
      const byLane = {}, byK = {};
      for (const r of fb) { const l = r.safety_lane || (r.safety_rp ? "?" : "한 기준"); byLane[l] = (byLane[l] || 0) + 1; byK[r.ks] = (byK[r.ks] || 0) + 1; }
      const rpRun = wp.filter((r) => r.safety_rp).length, rpRescued = wp.filter((r) => r.safety_rp && !r.fallback).length;
      const nK = (k) => wp.filter((r) => r.ks === k).length;
      add("B8", "B", "안전 폴백 발생 세션 (모든 페르소나 · wp · 세션 1–10)", `≤ ${pct(CRIT.B8.fallback)}`,
        `${pct(rate(wp, (r) => !!r.fallback))} = ${fb.length}/${wp.length}세션 (geometry ${wp.filter((r) => r.fallback === "geometry").length} · p0 ${wp.filter((r) => r.fallback === "p0").length})`,
        LE(rate(wp, (r) => !!r.fallback), CRIT.B8.fallback),
        `세션당 추천 1회 → 폴백률 = 폴백 세션/세션 · 세션 번호별 ${Array.from({ length: 10 }, (_, i) => i + 1).map((k) => `${k}:${byK[k] || 0}/${nK(k)}`).join(" ")} · `
        + `A 가 R 에 대해 위반이라 R_path 를 돌린 세션 ${rpRun}(그중 두 레인 판정으로 A 를 지킨 세션 ${rpRescued}) · 폴백 레인 ${Object.entries(byLane).map(([k, v]) => `${k} ${v}`).join(" · ") || "없음"} · `
        + `페르소나별 ${Object.entries(byP).map(([k, v]) => `${k} ${v}`).join(" · ") || "없음"} · 위반 ${Object.entries(byV).map(([k, v]) => `${k} ${v}`).join(" · ") || "없음"} · `
        + `경로 모수(tp·s·이탈 가드·r)를 P0 에서 바꾼 세션의 폴백 ${pct(rate(pp, (r) => !!r.fallback))}(${pp.filter((r) => r.fallback).length}/${pp.length}) vs 안 바꾼 세션 ${pct(rate(np, (r) => !!r.fallback))}(${np.filter((r) => r.fallback).length}/${np.length})`
        + (det.length ? ` · 위반 값(A>R) ${det.slice(0, 8).join(" / ")}${det.length > 8 ? " …" : ""}` : "")
        + (extra.h5 && !extra.h5.error ? ` · 진단(판정 밖): ${extra.h5.history.persona} ${extra.h5.history.sessions}세션 학습 모델로 iso1224 표본 ${extra.h5.contexts}입력 → 폴백 ${extra.h5.fallbacks}/${extra.h5.contexts}${Object.keys(extra.h5.violations).length ? ` (${Object.entries(extra.h5.violations).map(([k, v]) => `${k} ${v}`).join(" · ")})` : ""}${extra.h5.rp_runs != null ? ` · R_path 실행 ${extra.h5.rp_runs}` : ""}` : "")
        + (extra.h5 && extra.h5.demo && extra.h5.demo.total ? ` · 진단(판정 밖): 앱 데모 프로필(demo/personas, 합성 10세션) × 같은 ${extra.h5.demo.contexts}입력 → 폴백 ${extra.h5.demo.total.fallback}/${extra.h5.demo.total.n} (${pct(extra.h5.demo.total.fallback / extra.h5.demo.total.n)}) — ${extra.h5.demo.personas.filter((r) => r.fallback).map((r) => `${r.id} ${r.fallback}/${r.n} ${Object.entries(r.violations).map(([k, v]) => `${k}×${v}`).join("+")}`).join(" · ") || "폴백 없음"}` : ""));
    }
  }

  // ── 격자 (P0 정책 · 신규 사용자) ──
  const G = extra.grid || {};
  if (G.iso) {
    const g = G.iso.p0, t = G.iso.twin;
    add("B1g", "B", "[iso1224 · P0] 도착 오차 중앙 / 90%", `≤ ${CRIT.B1.med} / ≤ ${CRIT.B1.grid_p90}`, `${f3(g.arr50)} / ${f3(g.arr90)} (2.5.1 ${f3(t.arr50)} / ${f3(t.arr90)})`, ALL(LE(g.arr50, CRIT.B1.med), LE(g.arr90, CRIT.B1.grid_p90)));
    add("B2g", "B", "[iso1224 · P0] 최대 전환 거리 중앙", `≤ ${CRIT.B2.grid_med}`, `${f3(g.jump50)} (2.5.1 ${f3(t.jump50)})`, LE(g.jump50, CRIT.B2.grid_med));
    add("B3g", "B", "[iso1224 · P0] 역행 / 꺾임 / 지그재그", "≤ 1.5% / ≤ 12% / 0%", `${pct(g.back)} / ${pct(g.turns)} / ${pct(g.zig)} (2.5.1 ${pct(t.back)} / ${pct(t.turns)} / ${pct(t.zig)})`,
      ALL(LE(g.back, CRIT.B3.back), LE(g.turns, CRIT.B3.turns), g.zig === 0));
    add("B4g", "B", "[iso1224 · P0] 첫 곡↔지금 거리 중앙", `≤ ${CRIT.B4.med}`, `${f3(g.start50)} (2.5.1 ${f3(t.start50)})`, LE(g.start50, CRIT.B4.med));
    if (G.iso.b6) add("B6g", "B", "[iso1224 · P0] 경로 모수가 P0(= 표 tp · s 0)인 정책의 경유지 = 2.5.1 경유지", "100%",
      `${pct(G.iso.b6.n ? G.iso.b6.same / G.iso.b6.n : NaN)} (${G.iso.b6.same}/${G.iso.b6.n})`, G.iso.b6.n ? G.iso.b6.same === G.iso.b6.n : null,
      "같은 시나리오(지금·목표·분·시드)의 경유지(작업 좌표) 목록을 문자열로 비교");
    add("B5g", "B", "[iso1224 · P0] 시드만 다른 두 세션이 같은 곡으로 끝남(30·60분) / 목표 칩당 서로 다른 머묾 곡", `≤ 35% / ≥ 12곡`,
      `${pct(g.sameEnd)} / ${f1(g.holdDistinct)}곡 (2.5.1 ${pct(t.sameEnd)} / ${f1(t.holdDistinct)}곡)`, ALL(LE(g.sameEnd, CRIT.B5.same_end), GE(g.holdDistinct, CRIT.B5.hold_distinct)));
  }
  if (G.adj) {
    const g = G.adj.p0, t = G.adj.twin;
    add("C1a", "C", "[adj660 · P0] 인접 BPM 차 중앙 / 90%", `≤ ${CRIT.C1.bpm_med} / ≤ ${CRIT.C1.bpm_p90}`, `${f1(g.bpm50)} / ${f1(g.bpm90)} (2.5.1 ${f1(t.bpm50)} / ${f1(t.bpm90)})`, ALL(LE(g.bpm50, CRIT.C1.bpm_med), LE(g.bpm90, CRIT.C1.bpm_p90)));
    add("C1b", "C", "[adj660 · P0] 보컬↔연주 전환", `≤ ${pct(CRIT.C1.flip)}`, `${pct(g.flip)} (2.5.1 ${pct(t.flip)})`, LE(g.flip, CRIT.C1.flip));
    add("C1c", "C", "[adj660 · P0] 2개 이상 어긋난 전환", `≤ ${pct(CRIT.C1.flags2)}`, `${pct(g.flags2)} (2.5.1 ${pct(t.flags2)})`, LE(g.flags2, CRIT.C1.flags2));
    add("C1d", "C", "[adj660 · P0] 서로 다른 곡 수", `≥ ${CRIT.C1.distinct}`, `${g.distinct} (2.5.1 ${t.distinct})`, GE(g.distinct, CRIT.C1.distinct));
  }

  // ── D ──
  const repRate = (id, a, pred) => { const rs = reps(id, a); return rs.length ? rs.filter((rep) => pred(ok.filter((r) => r.persona === id && r.arm === a && r.rep === rep), rep)).length / rs.length : NaN; };
  const finalOf = (id, rep) => F.find((f) => f.persona === id && f.rep === rep && f.arm === "wp");
  const within = (rows, n) => rows.filter((r) => r.ks >= 2 && r.ks <= n + 1);   // 세션 n 까지의 기록으로 만든 모델 = 세션 2..n+1 시작 때
  if (has("P1", "wp") || has("P2", "wp")) {
    const r1 = repRate("P1", "wp", (rows) => within(rows, CRIT.D1.within).some((r) => r.model && r.model.pi >= CRIT.D1.pi));
    const r2 = repRate("P2", "wp", (rows) => within(rows, CRIT.D1.within).some((r) => r.model && r.model.pi <= -CRIT.D1.pi));
    add("D1", "D", "P1 / P2 속도: 5세션 안에 π ≥ 0.35 / π ≤ −0.35 인 반복", "≥ 80% / ≥ 80%", `${pct(r1)} / ${pct(r2)}`,
      ALL(has("P1", "wp") ? GE(r1, CRIT.D1.reps) : true, has("P2", "wp") ? GE(r2, CRIT.D1.reps) : true));
  }
  if (has("P7", "wp")) {
    const errs = reps("P7", "wp").map((rep) => { const f = finalOf("P7", rep); return f ? f.p7 : null; }).filter(Boolean);
    const okRate = errs.length ? errs.filter((e) => e.err_current <= CRIT.D2.err && e.err_target <= CRIT.D2.err).length / errs.length : NaN;
    add("D2", "D", "P7 좌표: 10세션 뒤 |δ̂ − δ*| ≤ 0.04 (지금·목표 각각)", "반복 ≥ 80%",
      `${pct(okRate)} · 지금 오차 중앙 ${f3(q(errs.map((e) => e.err_current), 0.5))} · 목표 ${f3(q(errs.map((e) => e.err_target), 0.5))}`, GE(okRate, CRIT.D2.reps),
      `반복별 δ̂(불안해요) ${errs.map((e) => `(${f3(e.hat_current[0])}, ${f3(e.hat_current[1])})`).join(" ")} · 참값 (−0.05, +0.08). 목표 δ* (+0.04, 0) 은 0.05 끌기 문턱보다 작아 끌기가 일어나지 않는다`);
  }
  if (has("P6", "wp")) {
    const r6 = repRate("P6", "wp", (rows, rep) => rows.some((r) => r.ks >= 2 && r.model && r.model.m_applied.tempo >= CRIT.D3.m) || ((finalOf("P6", rep) || {}).model || { m_applied: {} }).m_applied.tempo >= CRIT.D3.m);
    const bw = P("P6", "wp", 6, 10).flatMap((r) => r.pairs.bpm), bt = P("P6", "twin", 6, 10).flatMap((r) => r.pairs.bpm);
    const ratio = q(bw, 0.5) / q(bt, 0.5);
    add("D3", "D", "P6 빠르기: 10세션 안에 m_tempo ≥ 1.3 적용 반복 · 6~10세션 BPM 차 중앙 ≤ 0.8 × twin", "≥ 60% · ≤ 0.8",
      `${pct(r6)} · ${f1(q(bw, 0.5))} vs twin ${f1(q(bt, 0.5))} (×${f2(ratio)})`, ALL(GE(r6, CRIT.D3.reps), LE(ratio, CRIT.D3.bpm_ratio)),
      (() => { const fm = reps("P6", "wp").map((rep) => (finalOf("P6", rep) || {}).model).filter(Boolean);
               return `마지막 모델 m_tempo(적용 전) ${fm.map((m) => f2(m.m_raw && m.m_raw.tempo)).join("/")} · 큰 빠르기 변화 쌍 ${fm.map((m) => (m.n_large || {}).tempo ?? "—").join("/")}(적용에 ≥ 8) · 전환 ${fm.map((m) => m.n_trans ?? "—").join("/")}(≥ 12)`; })());
  }
  if (has("P2", "wp")) {
    const fw = sum(P("P2", "wp", 6, 10).map((r) => r.pairs.flips)) / sum(P("P2", "wp", 6, 10).map((r) => r.pairs.n));
    const ft = sum(P("P2", "twin", 6, 10).map((r) => r.pairs.flips)) / sum(P("P2", "twin", 6, 10).map((r) => r.pairs.n));
    add("D4", "D", "P2 보컬↔연주 전환율(6~10세션)", "≤ 0.5 × twin", `${pct(fw)} vs twin ${pct(ft)}`, LE(fw, CRIT.D4.ratio * ft));
  }
  for (const id of ["P1", "P2", "P3", "P5"]) if (has(id, "wp")) {
    const fr = (a) => sum(P(id, a, 6, 10).map((r) => r.fav_path)) / sum(P(id, a, 6, 10).map((r) => r.n_path));
    const w = fr("wp"), t = fr("twin");
    const need = id === "P5" ? t + CRIT.D5.add_p5 : Math.max(CRIT.D5.mult * t, t + CRIT.D5.add);
    add(`D5·${id}`, "D", `${id} 좋아하는 묶음 비율(6~10세션)`, id === "P5" ? "≥ twin + 5%p" : "≥ max(1.5 × twin, twin + 10%p)", `${pct(w)} vs twin ${pct(t)} (필요 ${pct(need)})`,
      GE(w, need));
  }
  if (has("P3", "wp")) {
    const on = (r) => r.policy && r.policy.soft_gates.includes("exclude_spoken");
    const r3 = repRate("P3", "wp", (rows) => within(rows, CRIT.D6.within).some(on));
    const after = P("P3", "wp").filter(on);
    const hi = sum(after.map((r) => r.spoken_high_path)) / sum(after.map((r) => r.n_path));
    const gt = sum(after.map((r) => r.spoken_gate_path)) / sum(after.map((r) => r.n_path));
    add("D6", "D", "P3 게이트: 5세션 안에 켜짐 · 켜진 뒤 말 비중 '높음' 곡", "반복 ≥ 80% · ≤ 5%",
      `${pct(r3)} · '높음' 묶음 ${pct(hi)} (게이트 문턱 상위 20% ${pct(gt)}, ${after.length}세션)`, ALL(GE(r3, CRIT.D6.reps), after.length ? LE(hi, CRIT.D6.spoken) : true),
      `'높음' = 카탈로그 3분위 묶음(상위 1/3). 게이트 exclude_spoken 은 상위 20% 만 뺀다. 1~5세션 경로의 '높음' 곡 평균 ${f2(mean(P("P3", "wp", 1, 5).map((r) => r.spoken_high_path)))}곡/세션 · 마지막 모델 vocal_bother 가중 ${reps("P3", "wp").map((rep) => f1(((finalOf("P3", rep) || {}).model || {}).vocal_bother_w)).join("/")}(켜짐 ≥ ${(() => { const g = rules.personalization && rules.personalization.gates && rules.personalization.gates.soft_spoken; return g && g.vocal_bother_min != null ? g.vocal_bother_min : "?"; })()}, 규칙 gates.soft_spoken.vocal_bother_min) · 켜진 반복의 첫 켜짐 세션 ${reps("P3", "wp").map((rep) => { const r = P("P3", "wp").filter((x) => x.rep === rep).find(on); return r ? r.ks : "—"; }).join("/")}`);
  }
  if (has("P4", "wp")) {
    const win = (r) => (r.model && r.model.recent_window >= CRIT.D7.window) || (r.policy && r.policy.exclude_n > 60);
    const rWin = repRate("P4", "wp", (rows) => within(rows, CRIT.D7.within).some(win));
    const rRep = repRate("P4", "wp", (rows) => { const i = rows.findIndex(win); return i < 0 ? false : rows.slice(i, i + CRIT.D7.after).every((r) => r.repeats_path === 0); });
    const rHold = repRate("P4", "wp", (rows, rep) => rows.some((r) => r.policy && r.policy.hold_radius > 0.035 + 1e-9) || (((finalOf("P4", rep) || {}).model || {}).hold_arm > 0.035 + 1e-9));
    /* 자극(최근 3세션에 들은 곡의 재등장)이 한 번도 없으면 학습기를 시험할 수 없다 — 판정 불가로 둔다 */
    const stim = sum(P("P4", "wp").map((r) => r.repeats_path)), stimT = sum(P("P4", "twin").map((r) => r.repeats_path));
    const codesRep = P("P4", "wp").filter((r) => r.codes && r.codes.too_repetitive).length;
    add("D7", "D", "P4 반복: 6세션 안에 창 120 · 켜진 뒤 5세션 반복 0 · r 한 칸 이상 넓어짐", "반복마다", `창 ${pct(rWin)} · 반복 0 ${pct(rRep)} · r 넓힘 ${pct(rHold)}`,
      stim === 0 && codesRep === 0 ? false : ALL(GE(rWin, 0.8), GE(rRep, 0.8), GE(rHold, 0.8)),
      `반복 = 최근 3세션에 재생된 곡이 경로에 다시 나옴. 합격은 세 조건 모두 반복 80% 이상으로 읽음. 재등장 자극 wp ${stim}곡 · twin ${stimT}곡 · too_repetitive 코드 세션 ${codesRep}`
      + (stim === 0 && codesRep === 0 ? " — 최근 창 60(노출 기준, twin 은 로컬 60)이 이미 재등장을 막아 P4 가 불만을 낼 기회가 없었다: 학습기가 한 번도 시험되지 않음 → 측정 안 됨(불합격 처리)" : ""));
  }
  if (has("P5", "wp")) {
    const elig = P("P5", "wp", 6, 10).filter((r) => r.policy && r.policy.replay_n > 0);
    const rr = rate(elig, (r) => r.replay_rows > 0);
    add("D8", "D", "P5 다시 넣기: 6~10세션 자격 세션 중 다시 넣기", "≥ 50%", `${pct(rr)} (자격 ${elig.length}세션)`, GE(rr, CRIT.D8.rate),
      `자격 = 정책 replay_ids 가 비어 있지 않은 세션. 뽑힌 세션 ${elig.filter((r) => r.replay_rows > 0).length} — 엔진은 다시 넣기를 허용만 하고 억지로 넣지 않는다(μ·코리도어가 정함, §4.10.3)`);
  }
  if (has("P9", "wp")) {
    const s = P("P9", "wp", 6, 10).filter((r) => r.shape);
    const ra = rate(s, (r) => r.shape.arrival_index <= 5);
    const rm = repRate("P9", "wp", (rows) => within(rows, CRIT.D9.within).some((r) => Number(r.minutes) <= CRIT.D9.minutes));
    add("D9", "D", "P9 이탈·길이: 6~10세션 도착 곡 ≤ 이탈 지점(5) · 6세션 안에 제안 시간 ≤ 25분", "≥ 80% · 반복 ≥ 80%", `${pct(ra)} · ${pct(rm)}`, ALL(GE(ra, CRIT.D9.rate), GE(rm, CRIT.D9.rate)));
  }
  if (has("P10", "wp")) {
    const rs = repRate("P10", "wp", (rows, rep) => rows.some((r) => r.policy && r.policy.start_offset > 0) || (((finalOf("P10", rep) || {}).model || {}).start_arm > 0));
    const fs = (a) => rate(P("P10", a, 6, 10).filter((r) => r.first_skip !== null), (r) => r.first_skip);
    add("D10", "D", "P10 시작점: 10세션 안에 s > 0 반복 · 6~10세션 첫 곡 조기 넘김", "≥ 50% · ≤ 0.8 × twin", `${pct(rs)} · ${pct(fs("wp"))} vs twin ${pct(fs("twin"))}`,
      ALL(GE(rs, CRIT.D10.reps), LE(fs("wp"), CRIT.D10.ratio * fs("twin"))),
      (() => { const fm = reps("P10", "wp").map((rep) => (finalOf("P10", rep) || {}).model).filter(Boolean);
               return `마지막 모델 비율 SR₁/SR_rest ${fm.map((m) => f2(m.start_ratio)).join("/")}(올림 ≥ 1.8) · 첫 곡 수 ${fm.map((m) => m.start_n1 ?? "—").join("/")}(≥ 5) · mood_mismatch 확인 ${fm.map((m) => f1(m.start_up)).join("/")}(≥ 1) · 세션 mood_mismatch 코드 ${P("P10", "wp").filter((r) => r.codes && r.codes.mood_mismatch).length}회`; })());
  }
  if (has("P12", "wp")) {
    const mis = P("P12", "wp").filter((r) => r.policy && r.policy.soft_gates.length).length;
    const vp = reps("P12", "wp").map((rep) => ((finalOf("P12", rep) || {}).model || {}).vote_sum);
    const vf = reps("P12F", "wp").map((rep) => ((finalOf("P12F", rep) || {}).model || {}).vote_sum);
    const ratio = sum(vp) / sum(vf);
    add("D11", "D", "P12 미리듣기: 소프트 게이트 오작동 · 취향 표 크기(전체 재생 대비)", "0 · 절반", `${mis}세션 · ×${f2(ratio)} (미리듣기 ${f2(sum(vp))} / 전체 재생 ${f2(sum(vf))})`,
      ALL(mis === 0, GE(ratio, CRIT.D11.half[0]), LE(ratio, CRIT.D11.half[1])), "전체 재생 대조 = 내부 페르소나 P12F(같은 행동·같은 난수, 곡 전체 길이)");
  }

  // ── E (P1–P10 합산, 6~10세션, 쌍 비교) ──
  const units = [];
  for (const id of E_PERSONAS) for (const r of P(id, "wp", 6, 10)) {
    const t = ok.find((x) => x.arm === "twin" && x.persona === id && x.rep === r.rep && x.ks === r.ks);
    const f = ok.find((x) => x.arm === "frozen" && x.persona === id && x.rep === r.rep && x.ks === r.ks);
    if (t) units.push({ w: r, t, f });
  }
  if (units.length) {
    const R2 = (u, side, num, den) => sum(u.map((x) => (x[side] ? x[side][num] : 0))) / sum(u.map((x) => (x[side] ? x[side][den] : 0)));
    const compSum = (u, side) => sum(u.map((x) => sum(x[side].comp_path))) / sum(u.map((x) => x[side].comp_path.length));
    const skipD = bootstrap(units, (u) => R2(u, "w", "skip_path", "exp_path") - R2(u, "t", "skip_path", "exp_path"), { seed: "E1" });
    const likeD = bootstrap(units, (u) => R2(u, "w", "like_path", "exp_path") - R2(u, "t", "like_path", "exp_path"), { seed: "E2" });
    const compD = bootstrap(units, (u) => compSum(u, "w") - compSum(u, "t"), { seed: "E3" });
    const chD = bootstrap(units, (u) => mean(u.map((x) => x.w.E_change)) - mean(u.map((x) => x.t.E_change)), { seed: "E4" });
    const sw = R2(units, "w", "skip_path", "exp_path"), st = R2(units, "t", "skip_path", "exp_path");
    const lw = R2(units, "w", "like_path", "exp_path"), lt = R2(units, "t", "like_path", "exp_path");
    add("E1", "E", "경로 곡 조기 넘김률", "wp ≤ 0.85 × twin, 차이 95% 구간 < 0", `${pct(sw)} vs ${pct(st)} (×${f2(sw / st)}) · 차이 ${f3(skipD.est)} ${ci(skipD)}`, ALL(LE(sw, CRIT.E1.ratio * st), fin(skipD.hi) ? skipD.hi < 0 : null));
    add("E2", "E", "좋아요율", "wp ≥ 1.2 × twin, 구간 > 0", `${pct(lw)} vs ${pct(lt)} (×${f2(lw / lt)}) · 차이 ${f3(likeD.est)} ${ci(likeD)}`, ALL(GE(lw, CRIT.E2.ratio * lt), fin(likeD.lo) ? likeD.lo > 0 : null));
    add("E3", "E", "평균 완주율", "wp ≥ twin + 0.03", `${f3(compSum(units, "w"))} vs ${f3(compSum(units, "t"))} · 차이 ${f3(compD.est)} ${ci(compD)}`, GE(compD.est, CRIT.E3.add));
    add("E4", "E", "잠재 청취 후 변화 E[change]", "wp ≥ twin + 0.15, 구간 > 0", `${f3(mean(units.map((x) => x.w.E_change)))} vs ${f3(mean(units.map((x) => x.t.E_change)))} · 차이 ${f3(chD.est)} ${ci(chD)}`,
      ALL(GE(chD.est, CRIT.E4.add), fin(chD.lo) ? chD.lo > 0 : null));
    const uf = units.filter((x) => x.f);
    if (uf.length) {
      const sf = R2(uf, "f", "skip_path", "exp_path"), swf = R2(uf, "w", "skip_path", "exp_path");
      add("E5", "E", "학습 몫: 조기 넘김 wp vs frozen", "wp ≤ 0.9 × frozen", `${pct(swf)} vs ${pct(sf)} (×${f2(swf / sf)})`, LE(swf, CRIT.E5.ratio * sf));
    }
    const early = (a, lo, hi) => { const rows = E_PERSONAS.flatMap((id) => P(id, a, lo, hi)); return sum(rows.map((r) => r.skip_path)) / sum(rows.map((r) => r.exp_path)); };
    const w6 = early("wp", 6, 10), w12 = early("wp", 1, 2), t6 = early("twin", 6, 10), t12 = early("twin", 1, 2);
    add("E6", "E", "세션에 따른 개선: wp 넘김(6~10)/(1~2) · twin 같은 비율", "wp ≤ 0.9 · twin ≥ 0.95", `wp ×${f2(w6 / w12)} (${pct(w12)}→${pct(w6)}) · twin ×${f2(t6 / t12)} (${pct(t12)}→${pct(t6)})`,
      ALL(LE(w6 / w12, CRIT.E6.wp), GE(t6 / t12, CRIT.E6.twin)));
  }
  {
    const cu = [];
    for (const id of ["P0", "P11"]) for (const r of P(id, "wp", 6, 10)) {
      const t = ok.find((x) => x.arm === "twin" && x.persona === id && x.rep === r.rep && x.ks === r.ks);
      if (t) cu.push({ w: r, t });
    }
    if (cu.length) {
      const R2 = (u, side, num, den) => sum(u.map((x) => x[side][num])) / sum(u.map((x) => x[side][den]));
      const dl = R2(cu, "w", "like_path", "exp_path") - R2(cu, "t", "like_path", "exp_path");
      const ds = R2(cu, "w", "skip_path", "exp_path") - R2(cu, "t", "skip_path", "exp_path");
      const ch = bootstrap(cu, (u) => mean(u.map((x) => x.w.E_change)) - mean(u.map((x) => x.t.E_change)), { seed: "E7" });
      add("E7", "E", "대조군(P0·P11): 좋아요·넘김 차이 · E[change] 차이 구간 하한", "|Δ| ≤ 0.03 또는 wp 가 나음 · ≥ −0.10",
        `Δ좋아요 ${f3(dl)} · Δ넘김 ${f3(ds)} · ΔE[change] ${f3(ch.est)} ${ci(ch)}`, 
        ALL(fin(dl) ? Math.abs(dl) <= CRIT.E7.abs || dl > 0 : null, fin(ds) ? Math.abs(ds) <= CRIT.E7.abs || ds < 0 : null, GE(ch.lo, CRIT.E7.ci_lo)));
    }
  }

  // ── F ──
  const capRule = Number(rules.diversity && rules.diversity.max_per_artist) || 2;
  const neutralSession = (r) => {
    const m = r.model || {}, p = r.policy || {};
    const cal = [r.calib_applied && r.calib_applied.current, r.calib_applied && r.calib_applied.target].every((c) => !c || (Math.abs(c.dv || 0) <= CRIT.F1.calib && Math.abs(c.de || 0) <= CRIT.F1.calib));
    return Math.abs(Number(m.pi || 0)) <= CRIT.F1.pi && cal && multOk(m) && !(p.start_offset > 0) && !(p.soft_gates || []).length
      && (r.ref_policy == null || p.hold_radius === r.ref_policy.hold_radius) && (m.recent_window == null || m.recent_window <= 60) && (p.artist_cap == null || p.artist_cap === capRule);
  };
  if (has("P0", "wp") || has("P11", "wp")) {
    const rows = [...P("P0", "wp", 6, 10), ...P("P11", "wp", 6, 10)];
    const why = { "π": 0, "δ": 0, "배수": 0, "s": 0, "게이트": 0, "r": 0, "창": 0, "상한": 0 };
    for (const r of rows) {
      const m = r.model || {}, p = r.policy || {};
      if (Math.abs(Number(m.pi || 0)) > CRIT.F1.pi) why["π"]++;
      if (![r.calib_applied && r.calib_applied.current, r.calib_applied && r.calib_applied.target].every((c) => !c || (Math.abs(c.dv || 0) <= CRIT.F1.calib && Math.abs(c.de || 0) <= CRIT.F1.calib))) why["δ"]++;
      if (!multOk(m)) why["배수"]++;
      if (p.start_offset > 0) why.s++;
      if ((p.soft_gates || []).length) why["게이트"]++;
      if (r.ref_policy && p.hold_radius !== r.ref_policy.hold_radius) why.r++;
      if (m.recent_window > 60) why["창"]++;
      if (p.artist_cap != null && p.artist_cap !== capRule) why["상한"]++;
    }
    add("F1", "F", "P0·P11 6~10세션: |π| ≤ 0.3 · |δ| ≤ 0.02 · 배수 1/[0.8,1.25] · s=0 · 게이트 꺼짐 · r=P0 · 창 60 · 상한 2", "모두 만족 세션 ≥ 80%",
      `${pct(rate(rows, neutralSession))} (${rows.length}세션)`, GE(rate(rows, neutralSession), CRIT.F1.rate),
      `조건별 어긋난 세션: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(" · ")} — P0 은 속도 답 20% 무작위 방향, P11 은 답·코드 무작위(명세 §9.4)`);
  }
  {
    const rows = ["P1", "P3", "P5"].flatMap((id) => P(id, "wp"));
    if (rows.length) add("F2", "F", "전환 민감도 없는 P1·P3·P5: 적용 배수 1 또는 [0.8, 1.25]", "세션 ≥ 80%", `${pct(rate(rows, (r) => multOk(r.model)))} (${rows.length}세션)`, GE(rate(rows, (r) => multOk(r.model)), CRIT.F1.rate));
  }
  if (has("P6", "wp") && has("P0", "wp")) {
    const m6 = mean(P("P6", "wp", 6, 10).map((r) => r.p_pmarg_abs)), m0 = mean(P("P0", "wp", 6, 10).map((r) => r.p_pmarg_abs));
    add("F3", "F", "취향 없는 P6: 취향 여백 |p_pmarg| 평균 이동(P0 대비)", `≤ ${CRIT.F3.shift}`, `${f3(m6)} vs P0 ${f3(m0)} (Δ ${f3(m6 - m0)})`, LE(m6 - m0, CRIT.F3.shift),
      "취향 묶음 점수 이동을 로그의 곡별 취향 여백(내 중립점 − 선호)으로 잰다");
  }
  {
    const f4 = F.filter((f) => f.persona === "P3" && f.f4);
    if (f4.length) {
      const infl = (k) => mean(f4.map((f) => Math.max(...Object.values(f.f4[k].m).map((m) => Math.abs(Math.log(m))))));
      const okQ = f4.every((f) => Object.entries(f.f4.withQ.m).every(([k, m]) => !f.f4.withQ.applied[k] || (m >= 0.8 && m <= 1.25)));
      add("F4", "F", "q 대조(P3): q 없이 적합 → 배수 부풂, q 포함 → F2 만족", "보고 · q 포함 F2", `max|ln m| q 없음 ${f3(infl("noQ"))} vs q 포함 ${f3(infl("withQ"))} · 적용 배수 q 없음 ${f4.map((f) => Object.keys(f.f4.noQ.applied).filter((k) => f.f4.noQ.applied[k]).join("+") || "없음").join(" / ")}`,
        okQ, "진단용 재적합(lib_metrics.fitAdjacency, 명세 §4.8.3 식) — 학습기 자체는 personal.js");
    }
  }
  {
    const rows = ["P1", "P3", "P5"].flatMap((id) => P(id, "wp"));
    if (rows.length) {
      const f5 = (r) => !(r.policy && r.policy.start_offset > 0) && (!r.ref_policy || r.policy.hold_radius === r.ref_policy.hold_radius) && !r.sug_applied;
      add("F5", "F", "취향만 있는 페르소나(P1·P3·P5): s·r·길이 제안이 P0 값", "100%", `${pct(rate(rows, f5))} (${rows.length}세션)`, rows.length ? rows.every(f5) : null);
    }
  }

  // ── G ──
  if (has("P8", "wp")) {
    const tpRows = rules.iso.transition_point;
    const atDef = (min) => { for (const row of tpRows) if (min <= row.up_to) return Number(row.at); return Number(tpRows.at(-1).at); };
    const A = rules.personalization && rules.personalization.adjacency, band = Number(rules.preference.band);
    const rows = P("P8", "wp");
    const g = (r) => {
      const p = r.policy || {};
      const tpOk = r.pace_user === "fast" || p.tp == null || p.tp >= atDef(r.minutes) - 1e-9;
      const mOk = !p.adj_w || !A ? true : Object.entries(A.base_weights_bands).every(([f, w]) => (p.adj_w[f] ?? 0) >= band * w * Number(A.scale) - 1e-9);
      return tpOk && r.discovery_rows === 0 && p.discovery_u == null && (p.hold_radius ?? 0) <= CRIT.G.r + 1e-9 && (p.start_offset ?? 0) <= CRIT.G.s + 1e-9 && mOk;
    };
    add("G", "G", "P8 고긴장: 자동 tp ≥ at_def · 발견 0 · r ≤ 0.035 · s ≤ 0.075 · 배수 ≥ 1", "100%", `${pct(rate(rows, g))} (${rows.length}세션, 고긴장 ${rows.filter((r) => r.stress >= 3).length})`, rows.length ? rows.every(g) : null);
  }

  // ── H ──
  if (extra.h1) add("H1", "H", `같은 입력 ${extra.h1.runs}회: 모델·정책 digest·시퀀스`, "100% 동일", `서로 다른 결과 ${extra.h1.distinct}가지`, extra.h1.distinct === 1);
  if (extra.h4) add("H4", "H", "설명 충실도: p_smooth 행을 adj_w = 0 으로 다시 돌리면 그 걸음 곡 또는 경로가 바뀜", "≥ 90%",
    `${pct(rate(extra.h4.cases, (c) => c.changed))} (${extra.h4.cases.length}행)`, GE(rate(extra.h4.cases, (c) => c.changed), CRIT.H4.rate));
  {
    const t = arm("wp").map((r) => r.timing);
    const mm = q(t.map((x) => x.model_ms), 0.5), pm = q(t.map((x) => x.policy_ms), 0.5), am = q(t.map((x) => x.runA_ms), 0.5);
    const tot = q(t.map((x) => (x.runA_ms || 0) + (x.runR_ms || 0) + (x.extras_ms || 0)), 0.5);
    const simNote = t.length ? `시뮬레이터 세션 안(워커 경합, 기록 ≤ 20 추천): 모델 ${f1(mm)} · resolvePolicy ${f2(pm)} · A ${f1(am)} · A+R+extras ${f1(tot)} ms` : "";
    const b = extra.h5;
    if (b && !b.error) {
      /* 전용 측정(bench_h5.mjs) — 워커가 모두 끝난 뒤 한 스레드, 추천 100·이벤트 1,200 합성 기록 */
      const mB = b.model.total.med, pB = b.policy.personal.med, aB = b.run.personal.med, sB = b.run.button_spec.med, fB = b.run.button_full.med;
      add("H5", "H", "성능(이 기기 Node, 한 스레드): 모델 빌드(추천 100·이벤트 1,200) · resolvePolicy · 개인 실행 A · 버튼→결과 A+R+extras (중앙)", "≤ 50 · ≤ 5 · ≤ 150 · ≤ 400 ms",
        `${f1(mB)} (최대 ${f1(b.model.total.max)}) · ${f2(pB)} · ${f1(aB)} · ${f1(sB)} ms (앱 recommend() 전체 ${f1(fB)} ms)`,
        ALL(LE(mB, CRIT.H5.model_ms), LE(pB, CRIT.H5.policy_ms), LE(aB, CRIT.H5.run_ms), LE(sB, CRIT.H5.total_ms)),
        `bench_h5.mjs: ${b.machine.cpus} · Node ${b.machine.node} · 합성 기록 ${b.history.persona} ${b.history.sessions}세션(추천 ${b.history.recs_window} · 이벤트 ${b.history.events_window}) · 입력 ${b.contexts}개(iso1224 표본). `
        + `실행 분해(중앙 ms): 2.5.1 ${f1(b.run.base251.med)} · 2.6.0-wp personal 없음 ${f1(b.run.none.med)} · neutralPolicy ${f1(b.run.neutral.med)} · P0 ${f1(b.run.p0.med)} · 개인 A ${f1(aB)} · 개인 adj_w=0 ${f1(b.run.personal_adj0.med)} · R ${f1(b.run.R.med)} · extras ${f1(b.run.extras.med)} · safetyCheck ${f2(b.run.safety.med)} · buildRecLog ${f2(b.run.reclog.med)}`
        + (b.run.geo.n ? ` · A′ ${f1(b.run.geo.med)}(${b.run.geo.n}회)` : "")
        + (simNote ? `. ${simNote}` : ""));
    } else if (t.length) add("H5", "H", "성능(이 기기 Node): 모델 빌드 · resolvePolicy · 개인 실행 · A+R+extras (중앙)", "≤ 50 · ≤ 5 · ≤ 150 · ≤ 400 ms",
      `${f1(mm)} (최대 ${f1(Math.max(...t.map((x) => x.model_ms || 0)))}) · ${f2(pm)} · ${f1(am)} · ${f1(tot)} ms`,
      false, `전용 측정(bench_h5.mjs) 없이 시뮬레이터 세션 안 시간만 있음 — 워커 경합·기록 ≤ 20 추천이라 명세 조건(추천 100·이벤트 1,200)이 아니다: 불합격 처리${b && b.error ? ` (bench 오류: ${b.error})` : ""}`);
  }
  return { results: res, personasRun };
}

/** 페르소나 × 팔 요약 표 (6~10세션) */
export function personaTable(R) {
  const ok = R.filter((r) => !r.error && r.ks != null);
  const nat = (x) => { const m = /^P(\d+)(.*)$/.exec(x); return m ? Number(m[1]) + (m[2] ? 0.5 : 0) : 99; };
  const ids = [...new Set(ok.map((r) => r.persona))].sort((a, b) => nat(a) - nat(b));
  const lines = ["| 페르소나 | 팔 | 세션 | 조기 넘김(경로) | 좋아요율 | 완주율 | E[change] | 좋아하는 묶음 | 도착 오차 중앙 | 최대 전환 90% | 폴백 |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const id of ids) for (const a of ["wp", "frozen", "twin"]) {
    const rows = ok.filter((r) => r.persona === id && r.arm === a && r.ks >= 6);
    if (!rows.length) continue;
    const e = sum(rows.map((r) => r.exp_path));
    lines.push(`| ${id} | ${a} | ${rows.length} | ${pct(sum(rows.map((r) => r.skip_path)) / e)} | ${pct(sum(rows.map((r) => r.like_path)) / e)} | ${f3(mean(rows.flatMap((r) => r.comp_path)))} | ${f2(mean(rows.map((r) => r.E_change)))} | ${rows[0].fav_path === null ? "—" : pct(sum(rows.map((r) => r.fav_path)) / sum(rows.map((r) => r.n_path)))} | ${f3(q(rows.map((r) => r.shape && r.shape.arrival), 0.5))} | ${f3(q(rows.map((r) => r.shape && r.shape.maxJump), 0.9))} | ${a === "twin" ? "—" : pct(rate(rows, (r) => !!r.fallback))} |`);
  }
  return lines.join("\n");
}

/** 학습 궤적 표 (wp 팔, 세션별 반복 평균) */
export function trajectoryTable(R, id) {
  const rows = R.filter((r) => !r.error && r.persona === id && r.arm === "wp" && r.ks != null);
  if (!rows.length) return "";
  const lines = ["| 세션 | π | 적용 π | tp | s | r | μ | m_tempo | m_vocal | 게이트 | 창 | 감상 시간 | 조기 넘김 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (let k = 1; k <= 10; k++) {
    const s = rows.filter((r) => r.ks === k);
    if (!s.length) continue;
    const avg = (f) => mean(s.map(f));
    lines.push(`| ${k} | ${f2(avg((r) => r.model && r.model.pi))} | ${f2(avg((r) => r.pi_used))} | ${f2(avg((r) => r.policy && r.policy.tp))} | ${f3(avg((r) => r.policy && r.policy.start_offset))} | ${f3(avg((r) => r.policy && r.policy.hold_radius))} | ${f2(avg((r) => r.policy && r.policy.mu))} | ${f2(avg((r) => r.model && r.model.m_applied.tempo))} | ${f2(avg((r) => r.model && r.model.m_applied.vocal))} | ${pct(rate(s, (r) => r.policy && r.policy.soft_gates.length > 0))} | ${f1(avg((r) => r.model && r.model.recent_window))} | ${f1(avg((r) => r.minutes))} | ${pct(sum(s.map((r) => r.skip_path)) / sum(s.map((r) => r.exp_path)))} |`);
  }
  return lines.join("\n");
}

export function renderCriteria(results) {
  const lines = ["| ID | 기준 | 합격선 | 값 (합성 사용자) | 합격 |", "|---|---|---|---|---|"];
  const e = (x) => String(x ?? "").replace(/\|/g, "\|").replace(/\r?\n/g, " ");   // 표 칸 안의 | 와 줄바꿈
  for (const r of results) lines.push(`| ${r.id} | ${e(r.title)}${r.note ? ` <br><sub>${e(r.note)}</sub>` : ""} | ${e(r.target)} | ${e(r.value)} | ${mark(r.pass)} |`);
  return lines.join("\n");
}
