/*
 * 시뮬레이터 자체 점검 (TOOLS) — `node tools/sim/lib_selftest.mjs` · 실패하면 exit 1.
 * 엔진·personal 의 정확성 시험이 아니라 "시뮬레이터가 앱처럼 기록을 남기는가"를 본다.
 *
 *   1 순수성      behavior.mjs · personas.mjs · lib_rng.mjs 에 Math.random·Date.now·node: import 없음(브라우저 데모에서 그대로 import)
 *   2 결정성      같은 (페르소나, 추천 문서, 키) → 같은 반응 · 키가 다르면 다른 난수
 *   3 공통 난수    같은 곡·같은 키면 팔이 달라도 같은 넘김 난수
 *   4 이벤트 모양  web-personal 세션의 모든 이벤트가 personal.validateEvent 통과 · 곡 재생 1회당 track_exit 1건
 *   5 쌍둥이 재현  fixweb_twin 의 신규 사용자 추천 = 76e8bdf 엔진에 앱 입력(grids.engineInput)을 직접 넣은 결과, 속도 버튼 = 규칙 사본 경로
 *   6 옛 기록     쌍둥이가 남긴 fix-web 형식 로그를 normalizeLogs 가 옛 세션으로 읽고 노출을 재구성
 *   7 미리듣기     P12 의 track_exit 가 preview = true
 *   8 픽스처      tools/sim/fixtures/*.json 을 다시 계산하면 기대 모델·정책 digest·시퀀스가 나온다(§11 H2 의 Node 쪽)
 */
import fs from "node:fs";
import path from "node:path";
import { loadDeps, ROOT } from "./lib_env.mjs";
import { makeShared, runSession } from "./lib_session.mjs";
import { createStore, setupWall, toRawFacts } from "./lib_store.mjs";
import { createTwin } from "./fixweb_twin.mjs";
import { respond, planSession } from "./behavior.mjs";
import { u01 } from "./lib_rng.mjs";
import { personaById, materializePersona, sessionTimes } from "./personas.mjs";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

// 1 순수성
for (const f of ["behavior.mjs", "personas.mjs", "lib_rng.mjs"]) {
  const src = fs.readFileSync(path.join(ROOT, "tools", "sim", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check(`순수 ESM: ${f}`, !/Math\.random|Date\.now|from\s+["']node:|require\(/.test(src));
}

const deps = await loadDeps({ needBaseline: true, needGrids: true });
const shared = makeShared(deps);
const twin = createTwin({ baseline: deps.baseline, catalogIndex: deps.cat.index, tables: deps.tables76 });
const idx = deps.cat.index;

// 2·3 결정성·공통 난수
check("키 해시 난수: 같은 키 같은 값 · 다른 키 다른 값", u01("P1:0:1|P0001|skip") === u01("P1:0:1|P0001|skip") && u01("P1:0:1|P0001|skip") !== u01("P1:0:2|P0001|skip"));
{
  const p = materializePersona(personaById("P6"), 0);
  const ids = [...idx.byId.keys()].slice(100, 108);
  const rec = { id: "t-rec", input: { app: "web-personal", env: "local", current_va: { v: 0.5, e: 0.5 }, target_va: { v: 0.6, e: 0.3 }, effective: { minutes: 30 } },
                sequence: ids.map((id, i) => ({ song_id: id, position: i + 1, role: "path", phase: "move" })) };
  const a = respond(p, rec, idx, { rngKey: "P6:0:1" }), b = respond(p, rec, idx, { rngKey: "P6:0:1" });
  check("respond 결정성(같은 입력 두 번)", JSON.stringify(a) === JSON.stringify(b), `이벤트 ${a.events.length}건`);
  const recTw = { id: "t-rec2", input: { current_va: { v: 0.5, e: 0.5 }, target_va: { v: 0.6, e: 0.3 }, recommend_minutes: 30 }, sequence: rec.sequence };
  const c = respond(p, recTw, idx, { rngKey: "P6:0:1" });
  const same = a.played.every((x, i) => !c.played[i] || x.song_id !== c.played[i].song_id || (x.early_skip === c.played[i].early_skip && x.completion === c.played[i].completion));
  check("공통 난수: 같은 곡·같은 키 → web-personal·fix-web 에서 같은 반응", same);
  check("fix-web 모드: track_exit 없음 · 이정표 있음", !c.events.some((e) => e.type === "track_exit") && c.events.some((e) => e.type === "track_milestone"));
}

// 4 이벤트 모양 (web-personal 세 세션)
if (deps.personal) {
  for (const id of ["P3", "P9", "P12"]) {
    const p = materializePersona(personaById(id), 0);
    const store = createStore({ uid: `selftest-${id}` }); setupWall(store, p, idx);
    const times = sessionTimes(id, 0, 3);
    const recs = [];
    for (let k = 1; k <= 3; k++) recs.push(runSession({ arm: "wp", persona: p, rep: 0, k, at_ms: times[k - 1], store, deps, shared, twin }));
    const bad = store.events.map((e) => ({ e, v: deps.personal.validateEvent(e.type, e.payload) })).filter((x) => !x.v.ok);
    check(`${id}: 이벤트 모양(validateEvent)`, bad.length === 0, bad.length ? `${bad[0].e.type}: ${bad[0].v.errors.join("; ")}` : `${store.events.length}건`);
    const exits = store.events.filter((e) => e.type === "track_exit");
    const played = recs.reduce((a, r) => a + r.n_played, 0);
    const uniq = new Set(exits.map((e) => e.rec_id + "|" + e.payload.song_id + "|" + e.payload.instance)).size;
    check(`${id}: 곡 재생 1회당 track_exit 정확히 1건`, exits.length === played && uniq === exits.length, `track_exit ${exits.length} · 재생 ${played}`);
    if (id === "P12") check("P12: 미리듣기 표시", store.events.filter((e) => e.type === "track_exit").every((e) => e.payload.preview === true));
    const norm = deps.personal.normalizeLogs(toRawFacts(store, { as_of_ms: times[2] + 7200000, vocab: deps.vocab, rules: deps.rules }), idx, deps.rules);
    check(`${id}: normalizeLogs 가 web-personal 세션으로 읽음`, norm.source.n_sessions_wp === 3 && norm.sessions.every((s) => s.exposures.every((x) => x.source === "track_exit")));
  }
}

// 5 쌍둥이 재현
{
  const G = await import("./grids.mjs");
  const scen = G.adj660({ tables: deps.tables76 }).filter((_, i) => i % 97 === 0).slice(0, 6);
  let same = 0;
  for (const sc of scen) {
    const store = createStore({ uid: "selftest-twin" });
    const tw = twin.recommend(store, { now: sc.now, target: sc.target, minutes: sc.minutes, pace_user: null, seed: sc.seed }, 0);
    const direct = deps.baseline.engine.recommend(twin.contract, deps.baseline.rules, sc.inputs);
    if (JSON.stringify(tw.result.sequence.map((r) => r.song_id)) === JSON.stringify(direct.sequence.map((r) => r.song_id))) same++;
  }
  check("쌍둥이 = 76e8bdf 엔진 + 앱 입력 (신규 사용자)", same === scen.length, `${same}/${scen.length}`);
  const sc = scen[0];
  const store = createStore({ uid: "selftest-twin-pace" });
  const tw = twin.recommend(store, { now: sc.now, target: sc.target, minutes: 30, pace_user: "fast", seed: sc.seed }, 0);
  const R = deps.baseline.rules;
  const direct = deps.baseline.engine.recommend(twin.contract, { ...R, iso: { ...R.iso, transition_point: [{ up_to: 999, at: 0.5 }] } }, { ...sc.inputs, duration_min: 30 });
  check("쌍둥이 속도 버튼 = PACE_TP 규칙 사본 경로", JSON.stringify(tw.result.sequence.map((r) => r.song_id)) === JSON.stringify(direct.sequence.map((r) => r.song_id)));
}

// 6 옛 기록
if (deps.personal) {
  const p = materializePersona(personaById("P13"), 0);
  const store = createStore({ uid: "selftest-legacy" });
  const times = sessionTimes("P13", 0, 3);
  for (let k = 1; k <= 3; k++) runSession({ arm: "twin", persona: p, rep: 0, k, at_ms: times[k - 1], store, deps, shared, twin });
  const norm = deps.personal.normalizeLogs(toRawFacts(store, { as_of_ms: times[2] + 7200000, vocab: deps.vocab, rules: deps.rules }), idx, deps.rules);
  const expo = norm.sessions.reduce((a, s) => a + s.exposures.length, 0);
  check("fix-web 형식 로그 → 옛 세션 재구성", norm.source.n_sessions_legacy === 3 && expo > 0 && norm.sessions.every((s) => s.exposures.every((x) => x.source === "legacy")), `옛 세션 ${norm.source.n_sessions_legacy} · 노출 ${expo}`);
  const model = deps.personal.buildPersonalModel(norm, idx, deps.rules, { as_of_ms: times[2] + 7200000 });
  check("옛 기록만으로 모델 빌드(A5 미리보기)", model && model.evidence && model.evidence.n_exposures > 0, `노출 ${model.evidence.n_exposures} · E ${model.taste.E}`);
}

// 8 픽스처(§11 H2 의 Node 쪽) — tools/sim/fixtures/*.json 을 같은 계산으로 다시 돌려 기대 digest·시퀀스와 비교
if (deps.personal) {
  const dir = path.join(ROOT, "tools", "sim", "fixtures");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  let okN = 0;
  const stale = [];
  for (const f of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (fx.rules_hash !== deps.rules.rules_hash || fx.catalog_digest !== idx.digest) { stale.push(f); continue; }
    const model = deps.personal.buildPersonalModel(deps.personal.normalizeLogs(fx.raw, idx, deps.rules), idx, deps.rules, { as_of_ms: fx.as_of_ms });
    const out = deps.personal.resolvePolicy(model, fx.ctx, deps.rules, { mode: fx.mode });
    const res = deps.engine.recommend(shared.contract, deps.rules, { ...fx.engine_input, user: out.user, personal: out.policy });
    if (model.digest === fx.expected.model_digest && out.policy.digest === fx.expected.policy_digest
        && res.sequence.map((r) => r.song_id).join() === fx.expected.sequence.join()) okN++;
  }
  const live = files.length - stale.length;
  check("픽스처 재계산 = 기대값", okN === live, `${okN}/${live}${stale.length ? ` (규칙·카탈로그가 바뀐 픽스처 ${stale.length}개 건너뜀 — demo_personas.mjs --fixtures 로 다시 만들 것)` : ""}`);
}

const fail = results.filter((r) => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} 통과`);
process.exit(fail.length ? 1 : 0);
