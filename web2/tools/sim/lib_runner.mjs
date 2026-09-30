/*
 * 페르소나 한 명 × 반복 한 번 × 팔 하나를 세션 순서대로 돌린다 (run.mjs · demo_personas.mjs 공통).
 * P13(legacy_first): 앞의 SIM.legacy_sessions_p13 세션은 팔과 무관하게 fix-web 쌍둥이로 돌려 옛 형식 기록을 쌓고,
 * 그 뒤 세션만 평가 세션 ks = 1..N 으로 센다(같은 uid·같은 저장소 — 옛 기록으로 따뜻하게 시작하는지 본다).
 */
import { createStore, setupWall, toRawFacts } from "./lib_store.mjs";
import { runSession, modelSummary } from "./lib_session.mjs";
import { SIM, sessionTimes, fmt } from "./personas.mjs";

export function simulate({ deps, shared, twin, persona, rep, arm, sessions = SIM.sessions, env = "local", h4 = null, legacyOnly = false, captureAt = null, onError = null, endAt = null }) {
  const legacyN = persona.legacy_first ? SIM.legacy_sessions_p13 : 0;
  const total = legacyOnly ? legacyN : legacyN + sessions;
  let times = sessionTimes(persona.rng_id || persona.id, rep, total);
  if (endAt != null) { const shift = endAt - times[total - 1]; times = times.map((t) => t + shift); }   // 간격은 그대로, 끝나는 시각만 맞춘다
  const store = createStore({ uid: fmt(SIM.uid_fmt, { persona: persona.id, rep }) });
  setupWall(store, persona, deps.cat.index);
  const records = [], captures = [];
  for (let k = 1; k <= total; k++) {
    const legacy = k <= legacyN;
    const effArm = legacy ? "twin" : arm;
    const capture = captureAt && captureAt.includes(k) ? { k } : null;
    let rec;
    try {
      rec = runSession({ arm: effArm, persona, rep, k, at_ms: times[k - 1], store, deps, shared, twin, env, h4: legacy ? null : h4, capture });
    } catch (e) {
      rec = { persona: persona.id, rep, k, arm: effArm, error: String(e && e.stack || e).split("\n").slice(0, 4).join(" | ") };
      if (onError) onError(rec, e);
    }
    rec.arm = arm;                 // 기록은 요청한 팔로 묶는다(P13 의 옛 세션도 그 팔의 저장소에 쌓였다)
    rec.legacy = legacy;
    rec.ks = legacy ? null : k - legacyN;
    records.push(rec);
    if (capture && capture.raw) captures.push(capture);
  }
  const lastEnd = times[total - 1] + 3 * 3600000;
  return { records, store, times, lastEnd, captures };
}

/** 마지막 세션 뒤 모델(D2·D3·D7·D10·D11·F4 용). personal 이 없으면 null */
export function finalModel(deps, store, as_of_ms, env = "local") {
  const { personal, rules, cat } = deps;
  if (!personal) return null;
  const raw = toRawFacts(store, { as_of_ms, vocab: deps.vocab, rules, env });
  const norm = personal.normalizeLogs(raw, cat.index, rules);
  const model = personal.buildPersonalModel(norm, cat.index, rules, { as_of_ms });
  return { raw, norm, model, summary: modelSummary(model) };
}
