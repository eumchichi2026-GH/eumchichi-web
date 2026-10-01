/*
 * run.mjs 밖에서 재는 수용 기준 (TOOLS · 명세 §11 A1–A4 · B7 · H2 · H3 · I · J) → run.mjs --external 이 읽는 JSON.
 * 각 행에 실행한 명령과 그 출력에서 옮긴 값을 적는다. **H3 의 추천 문서는 합성 사용자(시뮬레이터) 기록이다.**
 *
 *   node tools/sim/external.mjs [--out docs/personal_eval_<date>_external.json] [--date YYYYMMDD]
 *        [--unit-log <파일>] [--regress-log <파일>] [--check-log <파일>]   이미 돌린 출력(파일)을 읽는다 — 없으면 여기서 돌린다
 *        [--browser <json>]    브라우저에서 잰 값(H2 픽스처 digest · 개발 페이지 쓰기 카운터). 없으면 그 행은 "측정 안 됨"
 *        [--h3-personas all|P1,…] [--h3-sessions 10] [--skip h3,regress,unit,check]
 *
 * --browser JSON 모양: { measured_by, url_base, fixtures: [{ name, model_digest, policy_digest, error? }],
 *                       writes: [{ page, writes_enabled, counts: {…}, total }] }
 * 기준을 바꾸지 않는다: 잴 수 없었던 기준은 pass=false, value "측정 안 됨"으로 적는다(평가 규칙).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, dateTag, loadDeps, writeFileSafe, ROOT } from "./lib_env.mjs";

const A = parseArgs();
const tag = dateTag(A.date);
const skip = new Set(String(A.skip || "").split(",").map((s) => s.trim()).filter(Boolean));
const log = (...x) => { if (!A.quiet) console.error(...x); };
const rows = [], notes = [];
const row = (r) => rows.push({ pass: null, ...r });

/* 명령을 돌리거나(로그 파일이 있으면) 그 출력을 읽는다 */
function runOrRead(name, cmdArgs, logFile) {
  const cmd = `node ${cmdArgs.map((a) => (/[\s*]/.test(a) ? `"${a}"` : a)).join(" ")}`;
  if (logFile) {
    const text = fs.readFileSync(path.resolve(String(logFile)), "utf8");
    const m = /exit=(\d+)\s*$/.exec(text.trim());
    return { cmd, text, code: m ? Number(m[1]) : null, from: `로그 ${path.basename(String(logFile))}` };
  }
  log(`[${name}] ${cmd}`);
  const t0 = performance.now();
  const r = spawnSync(process.execPath, cmdArgs, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  log(`[${name}] exit ${r.status} · ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  return { cmd, text: `${r.stdout || ""}\n${r.stderr || ""}`, code: r.status, from: "이 실행" };
}

// ── 단위 시험 (B7 · 전체 결과는 notes) ──
if (!skip.has("unit")) {
  const u = runOrRead("unit", ["--test", "engine/test/*.test.mjs"], A["unit-log"]);
  const num = (k) => { const m = new RegExp(`ℹ ${k} (\\d+)`).exec(u.text); return m ? Number(m[1]) : null; };
  const nT = num("tests"), nP = num("pass"), nF = num("fail");
  const failIdx = u.text.indexOf("✖ failing tests:");
  const failed = failIdx >= 0 ? [...new Set(u.text.slice(failIdx).split(/\r?\n/).filter((l) => l.startsWith("✖ ") && !l.startsWith("✖ failing")).map((l) => l.slice(2).replace(/\s*\([\d.]+ms\)\s*$/, "")))] : [];
  notes.push(`단위 시험 \`${u.cmd}\` (${u.from}): ${nT ?? "?"}개 중 통과 ${nP ?? "?"} · 실패 ${nF ?? "?"}${failed.length ? ` — 실패: ${failed.map((f) => `「${f}」`).join(" · ")}` : ""}`);
  const b7 = u.text.split(/\r?\n/).filter((l) => /^[✔✖] 정리\((이동|머묾)\): 10만 조합/.test(l));
  const b7ok = b7.length === 2 && b7.every((l) => l.startsWith("✔"));
  row({ id: "B7", group: "B", title: "§3.8 정리 위반(단위 시험 10만 조합, 이동·머묾)", target: "0", source: `${u.cmd} (engine_corridor.test.mjs)`,
        value: b7.length ? `${b7.map((l) => `${l[0] === "✔" ? "통과" : "실패"} ${l.slice(2, 22)}…`).join(" · ")}` : "측정 안 됨 — 시험 줄을 찾지 못함", pass: b7.length ? b7ok : false });
  rows.unitSummary = { nT, nP, nF, failed };
}

// ── 회귀 (A1–A4) ──
if (!skip.has("regress")) {
  const r = runOrRead("regress", ["tools/sim/regress.mjs", "--grid", "all", "--check", "all"], A["regress-log"]);
  const lines = r.text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^격자\s+검사\s+결과/.test(l));
  const res = {};
  if (at >= 0) for (const l of lines.slice(at + 1)) { const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(l); if (m && !/^모두|^요청한/.test(l)) res[`${m[1]}|${m[2]}`] = m[3].trim(); }
  const mismatch = lines.find((l) => l.startsWith("✗ 불일치"));
  const allOk = lines.some((l) => /^모두 일치/.test(l)) && r.code !== 1 && !mismatch;
  const grids = ["iso1224", "adj660", "probe"];
  const cell = (c) => grids.map((g) => `${g} ${res[`${g}|${c}`] || "—"}`).join(" · ");
  const full = (c) => grids.every((g) => { const v = res[`${g}|${c}`]; const m = v && /^(\d+)\/(\d+) 일치/.exec(v); return m && m[1] === m[2]; });
  const src = `${r.cmd} (${r.from}${r.code != null ? `, exit ${r.code}` : ""})`;
  const mm = mismatch ? ` · 첫 불일치: ${mismatch}` : "";
  row({ id: "A1", group: "A", title: "I0: personal 없음(undefined·null) — 1,224 + 660 + 탐침 격자에서 2.6.0-wp vs 2.5.1", target: "100% 일치(버전·해시 제외)", source: src,
        value: at >= 0 ? `${cell("i0")} · 규칙 스위치 끔(i0off) ${cell("i0off")}${mm}` : `측정 안 됨${mm}`, pass: at >= 0 ? allOk && full("i0") && full("i0off") : false });
  row({ id: "A2", group: "A", title: "inputs.pace fast/slow vs 옛 규칙 사본 경로", target: "100%", source: src, value: at >= 0 ? `${cell("pace")}${mm}` : `측정 안 됨${mm}`, pass: at >= 0 ? allOk && full("pace") : false });
  row({ id: "A3", group: "A", title: "I1: neutralPolicy — 곡 순서 · 2.5.1 trace 키", target: "100%", source: src, value: at >= 0 ? `${cell("i1")}${mm}` : `측정 안 됨${mm}`, pass: at >= 0 ? allOk && full("i1") : false });
  const aff = res["items|affinity"];
  const affOk = aff && /^(\d+)\/(\d+)/.exec(aff);
  row({ id: "A4", group: "A", title: "aggregateAffinity(items, rules) 2인자, 무작위 항목 집합 200", target: "100%", source: src,
        value: aff ? `${aff}${mm}` : `측정 안 됨${mm}`, pass: !!(affOk && affOk[1] === affOk[2] && Number(affOk[2]) >= 200 && allOk) });
}

// ── 정적 검사 (I) ──
if (!skip.has("check")) {
  const c = runOrRead("check", ["tools/sim/check.mjs"], A["check-log"]);
  const L = c.text.split(/\r?\n/).filter((l) => /^[✓✗⚠] \S/.test(l) && !/^✓ 모두/.test(l));
  const get = (k) => L.find((l) => l.slice(2).startsWith(k));
  const src = `${c.cmd} (${c.from}${c.code != null ? `, exit ${c.code}` : ""})`;
  const I = [
    ["I·collections", "새 컬렉션 이름 0", "collections"], ["I·fs-writes", "index.html 의 모든 Firestore 쓰기가 fsWrite 안(계정 삭제 batch 만 예외)", "fs-writes"],
    ["I·song-stats", "song_stats 키 ⊆ 기존 7개", "song-stats"], ["I·determinism", "engine/*.js 에 Math.random·Date.now 0", "determinism"],
    ["I·rules-hash", "rules_hash 일치", "rules-hash"], ["I·trace-keys", "trace_keys ⊇ 엔진이 내는 p_* 키", "trace-keys"],
    ["I·sw-version", "sw.js VERSION ≠ azt-v9", "sw-version"], ["I·personalization", "personalization 절 JSON 이 §10 키를 모두 가짐", "personalization"],
    ["I·app-numbers", "(보충) 앱에 규칙 숫자 사본 없음 · env · 의존성 없음", "app-numbers"],
  ];
  for (const [id, title, key] of I) {
    const l = get(key);
    const extra = key === "app-numbers" ? ["env", "no-deps"].map(get).filter(Boolean) : [];
    const all = [l, ...extra].filter(Boolean);
    row({ id, group: "I", title, target: "✓", source: src, value: all.length ? all.map((x) => x.replace(/\s+/g, " ")).join(" / ") : "측정 안 됨",
          pass: all.length ? all.every((x) => x.startsWith("✓")) : false });
  }
}

// ── 브라우저 (H2 · I 쓰기 카운터) ──
let B = null;
if (A.browser) B = JSON.parse(fs.readFileSync(path.resolve(String(A.browser)), "utf8"));
{
  const deps = !skip.has("h3") || B ? await loadDeps({ dataRepo: A["data-repo"] || null, needBaseline: true, needGrids: false }) : null;
  if (B && Array.isArray(B.fixtures) && B.fixtures.length) {
    const fxDir = path.join(ROOT, "tools", "sim", "fixtures");
    const res = B.fixtures.map((b) => {
      const fx = JSON.parse(fs.readFileSync(path.join(fxDir, `${b.name}.json`), "utf8"));
      const same = !b.error && b.model_digest === fx.expected.model_digest && (fx.ctx ? b.policy_digest === fx.expected.policy_digest : true);
      return { name: b.name, same, err: b.error || null, fxRules: fx.rules_hash, fxCat: fx.catalog_digest, bCat: b.catalog_digest || null };
    });
    const nFx = fs.readdirSync(fxDir).filter((f) => f.endsWith(".json")).length;
    const ok = res.filter((r) => r.same).length;
    const stale = deps ? res.filter((r) => r.fxRules !== deps.rules.rules_hash).length : 0;
    row({ id: "H2", group: "H", title: `Node vs 브라우저(개발 페이지 ?fixture=) 픽스처 ${nFx}개 — 모델·정책 digest`, target: "100% 동일",
          value: `${ok}/${res.length} 동일${res.length < nFx ? ` (픽스처 ${nFx}개 중 ${res.length}개만 잼)` : ""}${stale ? ` · 규칙 해시가 지금과 다른 픽스처 ${stale}` : ""}`
            + (res.some((r) => !r.same) ? ` · 다름: ${res.filter((r) => !r.same).map((r) => `${r.name}${r.err ? `(${r.err})` : ""}`).join(", ")}` : "")
            + (res[0] && res[0].bCat ? ` · 브라우저 카탈로그 digest ${res[0].bCat} vs 픽스처 ${res[0].fxCat}` : ""),
          pass: ok === nFx && res.length === nFx && !stale, source: `브라우저 ${B.url_base || ""}?fixture=<name> → window.AZT_FIXTURE_RESULT (${B.measured_by || "수동"})` });
  } else row({ id: "H2", group: "H", title: "Node vs 브라우저(개발 페이지 ?fixture=) 픽스처 20개", target: "100% 동일", value: "측정 안 됨 — 브라우저 결과(--browser) 없음", pass: false, source: "—" });
  if (B && Array.isArray(B.writes) && B.writes.length) {
    const tot = B.writes.reduce((a, w) => a + Number(w.total || 0), 0);
    row({ id: "I·writes", group: "I", title: "로컬 서버 기본 실행과 데모 모드에서 Firestore 쓰기 호출 0(개발 페이지 카운터)", target: "0",
          value: B.writes.map((w) => `${w.page}: 쓰기 켬 ${w.writes_enabled} · 호출 ${w.total}${w.note ? ` (${w.note})` : ""}`).join(" / "), pass: tot === 0 && B.writes.every((w) => w.writes_enabled === false),
          source: `브라우저 AZT_DEBUG.writes() (${B.measured_by || "수동"})` });
  } else row({ id: "I·writes", group: "I", title: "로컬 서버 기본 실행과 데모 모드에서 Firestore 쓰기 호출 0(개발 페이지 카운터)", target: "0", value: "측정 안 됨 — 브라우저 결과 없음", pass: false, source: "—" });

  // ── H3 재현: 시뮬레이터가 지금 규칙으로 만든 추천 문서를 replay.mjs 로 ──
  if (!skip.has("h3")) {
    const { makeShared } = await import("./lib_session.mjs");
    const { simulate } = await import("./lib_runner.mjs");
    const { toRawFacts } = await import("./lib_store.mjs");
    const { createTwin } = await import("./fixweb_twin.mjs");
    const { PERSONAS, materializePersona } = await import("./personas.mjs");
    const shared = makeShared(deps);
    const twin = createTwin({ baseline: deps.baseline, catalogIndex: deps.cat.index, tables: deps.tables76 });
    const ids = !A["h3-personas"] || A["h3-personas"] === "all" ? PERSONAS.map((p) => p.id) : String(A["h3-personas"]).split(",");
    const sessions = Number(A["h3-sessions"] ?? 10);
    let tried = 0, matched = 0, skippedN = 0, xN = 0, xSame = 0;
    const skippedWhy = {}, bad = [];
    /* §4.12.3 "점수가 아니라 횟수로" 진단(J 패널 문구와 관련, 판정 밖) — 마지막 모델의 explainModel 카드 근거·문장에 소수 횟수가 있나 */
    const frac = { cards: 0, evidence: 0, text: 0, ex: [] };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "azt-h3-"));
    try {
      for (const id of ids) {
        const persona = materializePersona(PERSONAS.find((p) => p.id === id), 0);
        const t0 = performance.now();
        const sim = simulate({ deps, shared, twin, persona, rep: 0, arm: "wp", sessions, env: "local" });
        const raw = toRawFacts(sim.store, { as_of_ms: sim.lastEnd, vocab: deps.vocab, rules: deps.rules, env: "local" });
        try {
          const model = deps.personal.buildPersonalModel(deps.personal.normalizeLogs(JSON.parse(JSON.stringify(raw)), deps.cat.index, deps.rules), deps.cat.index, deps.rules, { as_of_ms: sim.lastEnd });
          for (const c of deps.personal.explainModel(model, deps.rules) || []) {
            frac.cards++;
            const ev = typeof c.evidence === "number" && !Number.isInteger(c.evidence);
            const tx = /\d+\.\d+\s*번/.test(String(c.text || ""));
            if (ev) frac.evidence++;
            if (tx) frac.text++;
            if ((ev || tx) && frac.ex.length < 6) frac.ex.push(`${id} ${c.id}: 근거 ${c.evidence}${tx ? ` · 「${String(c.text).slice(0, 40)}…」` : ""}`);
          }
        } catch (e) { frac.err = e.message; }
        const fIn = path.join(tmpDir, `${id}.json`), fOut = path.join(tmpDir, `${id}.out.json`);
        fs.writeFileSync(fIn, JSON.stringify(raw));
        const r = spawnSync(process.execPath, ["tools/sim/replay.mjs", "--recs", fIn, "--json", fOut, "--no-fail"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        if (!fs.existsSync(fOut)) { bad.push(`${id}: replay 실패 exit ${r.status} ${(r.stderr || "").split("\n")[0]}`); continue; }
        const j = JSON.parse(fs.readFileSync(fOut, "utf8"));
        tried += j.tried; matched += j.matched;
        for (const [k, v] of Object.entries(j.skipped || {})) { skippedWhy[k] = (skippedWhy[k] || 0) + v; skippedN += v; }
        for (const x of j.results || []) { if (x.extras && "same" in x.extras) { xN++; if (x.extras.same) xSame++; } if (x.status === "mismatch") bad.push(`${x.id} 위치 ${x.first_diff.position}`); }
        log(`[H3] ${id} ${sim.records.length}세션 · 재현 ${j.tried} 일치 ${j.matched} (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
      }
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    notes.push(`내 취향 모델 패널 진단(합성 사용자 ${ids.length}명 × ${sessions}세션 뒤 explainModel, 판정 밖 — §4.12.3 "횟수로 말한다"): 카드 ${frac.cards}장 중 근거가 소수인 카드 ${frac.evidence}장 · 문장에 소수 "N.N번" ${frac.text}장${frac.ex.length ? ` — 예: ${frac.ex.join(" / ")}` : ""}${frac.err ? ` (오류 ${frac.err})` : ""}. 앱 evidenceText()는 숫자를 그대로 "근거 N번"으로 붙인다(index.html).`);
    row({ id: "H3", group: "H", title: "replay.mjs 로 시뮬레이터가 남긴 추천 문서(합성 사용자) 재현 — 경로 곡 순서", target: "100%(카탈로그 digest 일치 시)",
          value: tried ? `${matched}/${tried} 일치 (${(100 * matched / tried).toFixed(1)}%) · 더 들을 곡 ${xSame}/${xN} · 건너뜀 ${skippedN}${skippedN ? ` (${Object.entries(skippedWhy).map(([k, v]) => `${k} ${v}`).join(" · ")})` : ""}${bad.length ? ` · 어긋남 ${bad.slice(0, 6).join(", ")}` : ""}` : "측정 안 됨 — 재현한 추천 없음",
          pass: tried > 0 ? matched === tried : false,
          source: `페르소나 ${ids.join(",")} × ${sessions}세션(wp, 반복 0) → toRawFacts → node tools/sim/replay.mjs --recs <임시> --json <임시> (임시 파일은 지움)` });
  } else row({ id: "H3", group: "H", title: "replay.mjs 재현", target: "100%", value: "측정 안 됨 — --skip h3", pass: false, source: "—" });
}

// ── J (수동 점검 — 이 도구가 재지 않는다) ──
row({ id: "J", group: "J", title: "앱 수동 점검(track_exit 1건/재생 · 비교 토글 · 개인화 끄기·익명 → personal_policy null · 375px 끌기 · 빈 모델 패널 '기본값' · ?personal=0 · localhost 서비스워커 미등록)",
      target: "모두 확인", value: A["j-note"] ? String(A["j-note"]) : "측정 안 됨 — 수동 점검(배포 전), 이 평가 실행 밖", pass: false, source: "수동" });

const out = { generated: `external.mjs ${tag}`, synthetic: "합성 사용자", rows, notes, unit: rows.unitSummary || null };
const f = writeFileSafe(A.out || path.join("docs", `personal_eval_${tag}_external.json`), JSON.stringify(out, null, 1));
log(`→ ${path.relative(ROOT, f)} (${rows.length}행)`);
for (const r of rows) console.log(`${r.pass === true ? "✓" : r.pass === false ? "✗" : "—"} ${r.id.padEnd(18)} ${r.value}`);
for (const n of notes) console.log(`· ${n}`);
