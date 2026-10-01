/*
 * run.mjs 의 작업 단위 = (페르소나, 반복) 하나를 모든 팔로 — 워커 스레드(node:worker_threads)에서도, 같은 스레드에서도 돈다.
 * 엔진 한 번이 이 노트북에서 0.5~3초라 페르소나×반복을 워커 여러 개에 나눠 돌린다(결과는 워커 수와 무관하게 같다 — 난수는 전부 키 해시).
 *
 *   runJob(deps, shared, twin, job) → { records, finals, h4cases, h1, fills, errors }
 *     job = { id, rep, arms, sessions, h4budget, wantH1 }
 *   P13: 앞의 fix-web 형식 세션(팔과 무관, 공통 난수라 세 팔에서 같다)은 한 번만 돌리고 저장소를 복제해 각 팔을 잇는다.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { loadDeps } from "./lib_env.mjs";
import { makeShared, runSession } from "./lib_session.mjs";
import { finalModel } from "./lib_runner.mjs";
import { createStore, setupWall } from "./lib_store.mjs";
import { createTwin } from "./fixweb_twin.mjs";
import { personaById, materializePersona, sessionTimes, SIM, fmt } from "./personas.mjs";
import { fitAdjacency } from "./lib_metrics.mjs";
import { gridRun, patchRules } from "./lib_grid.mjs";

export async function prepare({ dataRepo = null, needBaseline = true } = {}) {
  const deps = await loadDeps({ dataRepo, needBaseline, needGrids: true });
  const shared = makeShared(deps);
  const twin = deps.baseline ? createTwin({ baseline: deps.baseline, catalogIndex: deps.cat.index, tables: deps.tables76 }) : null;
  return { deps, shared, twin };
}

function oneSession(ctx, args, errors) {
  try { return runSession(args); }
  catch (e) {
    errors.push(`${args.persona.id} r${args.rep} k${args.k} ${args.arm}: ${String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")}`);
    return { persona: args.persona.id, rep: args.rep, k: args.k, arm: args.arm, error: String(e && e.message || e) };
  }
}

/* 격자 조각 — { kind: "grid", grid: "iso1224"|"adj660", mode: "p0"|"twin", from, to, patch: [[경로, 값], …] | null } */
const gridCache = new Map();
function runGridJob({ deps, shared }, job) {
  if (!gridCache.has(job.grid)) gridCache.set(job.grid, deps.grids[job.grid]({ tables: deps.tables76 }));
  const all = gridCache.get(job.grid);
  let rules = deps.rules;
  for (const [p, v] of job.patch || []) rules = patchRules(rules, p, v);
  const stride = Math.max(1, Number(job.stride) || 1);   // 빠른 점검용 표본(--grid-sample) — 보고서에 표시된다
  const scen = all.slice(job.from, job.to).filter((_, i) => (job.from + i) % stride === 0);
  return { runs: gridRun({ deps, shared, scenarios: scen, mode: job.mode, rules }) };
}

export function runJob(ctx, job) {
  if (job.kind === "grid") return runGridJob(ctx, job);
  const { deps, shared, twin } = ctx;
  const base = personaById(job.id);
  const persona = materializePersona(base, job.rep);
  const rep = job.rep, sessions = job.sessions;
  const legacyN = persona.legacy_first ? SIM.legacy_sessions_p13 : 0;
  const total = legacyN + sessions;
  const times = sessionTimes(persona.rng_id || persona.id, rep, total);
  const uid = fmt(SIM.uid_fmt, { persona: persona.id, rep });
  const out = { records: [], finals: [], h4cases: [], h1: null, fills: 0, errors: [] };
  const h4 = { budget: job.h4budget || 0, cases: out.h4cases };

  // 옛 형식 앞 세션 (P13) — 한 번만
  let prelude = null;
  if (legacyN) {
    if (!twin) { out.errors.push(`${persona.id}: 쌍둥이(76e8bdf) 없이 옛 형식 세션을 만들 수 없습니다`); return out; }
    const store = createStore({ uid }); setupWall(store, persona, deps.cat.index);
    for (let k = 1; k <= legacyN; k++) {
      const rec = oneSession(null, { arm: "twin", persona, rep, k, at_ms: times[k - 1], store, deps, shared, twin }, out.errors);
      rec.legacy = true; rec.ks = null; rec.arm = "legacy";
      out.records.push(rec);
    }
    prelude = store;
  }
  for (const arm of job.arms) {
    if (arm === "twin" && !twin) continue;
    if (arm !== "twin" && !deps.personal) continue;
    const store = prelude ? structuredClone(prelude) : (() => { const s = createStore({ uid }); setupWall(s, persona, deps.cat.index); return s; })();
    for (let k = legacyN + 1; k <= total; k++) {
      const rec = oneSession(null, { arm, persona, rep, k, at_ms: times[k - 1], store, deps, shared, twin, h4: arm === "wp" ? h4 : null }, out.errors);
      rec.arm = arm; rec.legacy = false; rec.ks = k - legacyN;
      out.records.push(rec);
    }
    out.fills += store.fills;
    if (arm === "wp" && deps.personal) {
      try {
        const as_of = times[total - 1] + 3 * 3600000;
        const fm = finalModel(deps, store, as_of);
        const f = { persona: persona.id, rep, arm, model: fm.summary };
        if (persona.calib) {
          /* D2: 마지막 세션 뒤 모델로 그 단어를 다시 골랐을 때의 보정 δ̂ 와 참값 δ* */
          const err = {}, hat = {};
          for (const [field, m] of Object.entries(persona.calib)) for (const [label, dstar] of Object.entries(m)) {
            const chips = field === "current" ? deps.vocab.mood_chips : deps.vocab.goal_chips;
            const c = chips.find((x) => x[0] === label);
            const lab = { mode: "chip", chip: label };
            const r = deps.personal.calibratePoint(fm.model, field, { ...lab, [field]: lab }, { v: c[1], e: c[2] }, deps.rules);
            const dv = r && r.applied ? Number(r.applied.dv || 0) : 0, de = r && r.applied ? Number(r.applied.de || 0) : 0;
            err[field] = Math.hypot(dv - dstar[0], de - dstar[1]); hat[field] = [dv, de];
          }
          f.p7 = { err_current: err.current ?? 0, err_target: err.target ?? 0, hat_current: hat.current, hat_target: hat.target };
        }
        if (persona.id === "P3") {
          const trans = (fm.norm.sessions || []).flatMap((s) => s.transitions || []);
          const adj = (deps.rules.personalization && deps.rules.personalization.adjacency) || {};
          f.f4 = { n: trans.length, withQ: fitAdjacency(trans, adj, { useQ: true }), noQ: fitAdjacency(trans, adj, { useQ: false }) };
        }
        out.finals.push(f);
        if (job.wantH1) out.h1 = { raw: fm.raw, at: as_of, persona: persona.id };
      } catch (e) { out.errors.push(`${persona.id} r${rep} 마지막 모델: ${e.message}`); }
    }
  }
  return out;
}

/* 워커 스레드 진입점 */
if (!isMainThread && workerData && workerData.kind === "azt-sim") {
  const ready = prepare({ dataRepo: workerData.dataRepo, needBaseline: workerData.needBaseline });
  parentPort.on("message", async (job) => {
    if (job === "exit") { parentPort.close(); return; }
    try { parentPort.postMessage({ ok: true, job, result: runJob(await ready, job) }); }
    catch (e) { parentPort.postMessage({ ok: false, job, error: String(e && e.stack || e) }); }
  });
}
