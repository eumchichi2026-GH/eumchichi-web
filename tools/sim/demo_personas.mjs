/*
 * 데모 프로필 만들기 (TOOLS · 명세 §4.12.4 · §9.3) — 페르소나를 web-personal 로 10세션 돌려 그 기록을 RawFacts 로 남긴다.
 * 앱의 `?demo=<id>` 가 demo/personas/<id>.json 을 메모리에 올려 "데모 프로필(합성 사용자)" 로 보여 준다(Firestore 쓰기 없음).
 * **전부 합성 사용자 기록이다.** 실제 사용자 기록이 아니며 파일 머리 `demo.synthetic` 에 그렇게 적는다.
 *
 *   node tools/sim/demo_personas.mjs [--personas all|P1,P5,…] [--sessions 10] [--fixtures] [--fixtures-only] [--quiet]
 *
 *   demo/personas/<id>.json        RawFacts(wp-raw/1, env "demo") + demo 머리(페르소나 이름·세션 수·생성 정보)
 *                                  P13 은 fix-web 형식 10세션만(옛 기록으로 따뜻하게 시작하는 모습을 보이려고)
 *   --fixtures-only                픽스처만 다시 쓴다(demo/personas 는 건드리지 않음 — 규칙 값만 바뀌어 픽스처 digest 를 새로 맞출 때)
 *   --fixtures                     tools/sim/fixtures/<name>.json 20개(§11 H2): { raw, ctx, as_of_ms, engine_input, expected: { model_digest, policy_digest, sequence } }
 *                                  앱 개발 페이지 `?fixture=<name>` 이 같은 계산을 브라우저에서 하고 digest 를 비교한다
 * 결정적이다 — 같은 규칙·엔진·카탈로그면 같은 파일이 나온다(난수는 키 해시, 시각은 personas.mjs 의 고정 기준점).
 */
import path from "node:path";
import { parseArgs, loadDeps, writeFileSafe, ROOT } from "./lib_env.mjs";
import { makeShared } from "./lib_session.mjs";
import { simulate } from "./lib_runner.mjs";
import { toRawFacts } from "./lib_store.mjs";
import { createTwin } from "./fixweb_twin.mjs";
import { PERSONAS, SIM, materializePersona } from "./personas.mjs";

const A = parseArgs();
if (A["fixtures-only"]) A.fixtures = true;
const sessions = Number(A.sessions ?? SIM.sessions);
const ids = !A.personas || A.personas === "all" ? PERSONAS.map((p) => p.id) : String(A.personas).split(",").map((s) => s.trim());
const log = (...x) => { if (!A.quiet) console.error(...x); };

const deps = await loadDeps({ dataRepo: A["data-repo"] || null, needBaseline: true });
if (!deps.personal) { console.error("engine/personal.js 가 없어 web-personal 기록을 만들 수 없습니다"); process.exit(1); }
for (const n of deps.notes) log(`[주의] ${n}`);
const shared = makeShared(deps);
const twin = createTwin({ baseline: deps.baseline, catalogIndex: deps.cat.index, tables: deps.tables76 });

/* 픽스처 20개: web-personal 페르소나 13명(P13 제외 — 옛 기록만)의 3번째 세션 + 학습이 보이는 7명의 6번째 세션 (작은 기록 — 브라우저에서 빠르게) */
const FIXTURE_AT = { default: [3], P1: [3, 6], P2: [3, 6], P3: [3, 6], P5: [3, 6], P7: [3, 6], P9: [3, 6], P10: [3, 6] };
const fixtures = [];
const written = [];
for (const id of ids) {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) { log(`모르는 페르소나 ${id}`); continue; }
  const persona = materializePersona(p, 0);
  const legacyOnly = !!persona.legacy_first;
  const legacyN = legacyOnly ? SIM.legacy_sessions_p13 : 0;
  const at = A.fixtures && !legacyOnly ? (FIXTURE_AT[id] || FIXTURE_AT.default).map((k) => k + legacyN) : null;
  const t0 = performance.now();
  const [y, mo, d, h, mi, s] = SIM.demo_end_utc;
  const sim = simulate({ deps, shared, twin, persona, rep: 0, arm: "wp", sessions, env: "demo", legacyOnly, captureAt: at, endAt: Date.UTC(y, mo, d, h, mi, s),
                         onError: (rec) => log(`  오류 ${id} k${rec.k}: ${rec.error}`) });
  const raw = toRawFacts(sim.store, { as_of_ms: sim.lastEnd, vocab: deps.vocab, rules: deps.rules, env: "demo" });
  raw.demo = {
    persona_id: id, name: p.name, synthetic: true, label: "데모 프로필(합성 사용자)",
    sessions: sim.records.length, app_sessions: legacyOnly ? "fix-web 형식(옛 기록)" : "web-personal",
    generated_by: "tools/sim/demo_personas.mjs", engine_version: deps.engine.ENGINE_VERSION, rules_hash: deps.rules.rules_hash,
    catalog_digest: deps.cat.index.digest, note: "시뮬레이터 페르소나의 합성 기록입니다. 실제 사용자 기록이 아닙니다.",
  };
  if (!A["fixtures-only"]) {
    const f = writeFileSafe(path.join("demo", "personas", `${id}.json`), JSON.stringify(raw));
    written.push(`${path.relative(ROOT, f)} (${(JSON.stringify(raw).length / 1024).toFixed(0)}KB, 추천 ${raw.recommendations.length} · 이벤트 ${raw.events.length})`);
  }
  for (const c of sim.captures) fixtures.push({ id, c });
  log(`${id} ${sim.records.length}세션 · ${((performance.now() - t0) / 1000).toFixed(1)}s · 오류 ${sim.records.filter((r) => r.error).length}`);
}
for (const w of written) log(`→ ${w}`);

if (A.fixtures) {
  for (const { id, c } of fixtures) {
    const name = `${id}_s${String(c.k).padStart(2, "0")}`;
    const fx = {
      name, synthetic: "합성 사용자", persona: id, k: c.k, as_of_ms: c.as_of_ms, mode: c.mode,
      rules_hash: deps.rules.rules_hash, engine_version: deps.engine.ENGINE_VERSION, personal_version: deps.personal.PERSONAL_VERSION,
      catalog_digest: deps.cat.index.digest,
      how: "normalizeLogs(raw) → buildPersonalModel(as_of_ms) → resolvePolicy(model, ctx, rules, { mode }) → engine.recommend(catalog, rules, { ...engine_input, user, personal: policy })",
      raw: c.raw, ctx: c.ctx, engine_input: c.engine_input,
      expected: { model_digest: c.model_digest, policy_digest: c.policy_digest, sequence: c.sequence },
    };
    const f = writeFileSafe(path.join("tools", "sim", "fixtures", `${name}.json`), JSON.stringify(fx));
    log(`→ ${path.relative(ROOT, f)}`);
  }
  log(`픽스처 ${fixtures.length}개`);
}
