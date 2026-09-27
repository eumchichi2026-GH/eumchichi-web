/*
 * 시뮬레이터 도구 공통 (Node 전용) — 인자 해석, 날짜 꼬리표, 의존 모듈 불러오기.
 *
 * 불러오는 것 (명세 §9.2 · §9.3 인터페이스):
 *   engine/engine.js (2.6.0-wp)       recommend · recommendExtras · makeFeatureBinner …
 *   engine/personal.js                normalizeLogs · buildPersonalModel · resolvePolicy · safetyCheck · buildRecLog …
 *   rules/rules.compiled.json          personalization 절
 *   tools/sim/catalog.mjs              loadCatalog — 데이터 저장소를 git show 로만 읽는다
 *   tools/sim/baseline.mjs             loadBaseline("76e8bdf") — 없으면 같은 방식(임시 파일 import 후 즉시 삭제)으로 대신 읽는다
 *   tools/sim/app_tables.mjs           감정·목표 칩 (vocab), 76e8bdf 의 PACE_TP·deriveStress
 *   tools/sim/grids.mjs                iso1224 · adj660 — 없으면 같은 정의로 대신 만든다(보고서에 표시)
 * 다른 빌더가 동시에 쓰는 파일은 import 가 실패해도 도구 전체가 죽지 않게 이유를 모아 돌려준다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE_REF = "76e8bdf";

/** --key value / --flag 해석. 반복 키는 마지막 값. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) out[k] = v;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
/** 산출물 날짜 꼬리표 YYYYMMDD — --date 가 있으면 그 값, 없으면 도구의 시스템 시계(엔진 코드가 아니므로 허용) */
export function dateTag(arg) {
  if (arg && /^\d{8}$/.test(String(arg))) return String(arg);
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
export const gitShow = (ref, rel, repo = ROOT) =>
  execFileSync("git", ["-C", repo, "show", `${ref}:${rel}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/* azt_app.mjs importSource 방식 — OS 임시 파일에 쓰고 import 한 뒤 바로 지운다 */
async function importSource(src, name) {
  const f = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now().toString(36)}.mjs`);
  fs.writeFileSync(f, src);
  try { return await import(pathToFileURL(f).href); } finally { fs.rmSync(f, { force: true }); }
}
async function tryImport(rel) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return { mod: null, err: `${rel} 없음` };
  try { return { mod: await import(pathToFileURL(f).href), err: null }; }
  catch (e) { return { mod: null, err: `${rel} import 실패: ${e.message}` }; }
}

/** 기준(76e8bdf) 엔진·규칙 — baseline.mjs 가 있으면 그것, 없으면 같은 방식으로 */
export async function loadBaselineAny(notes) {
  const b = await tryImport("tools/sim/baseline.mjs");
  if (b.mod && typeof b.mod.loadBaseline === "function") {
    try { return await b.mod.loadBaseline(BASE_REF); } catch (e) { notes.push(`baseline.mjs loadBaseline 실패 → 대체 로더 사용 (${e.message})`); }
  } else notes.push(`${b.err || "baseline.mjs 에 loadBaseline 없음"} → 대체 로더 사용`);
  const engine = await importSource(gitShow(BASE_REF, "engine/engine.js"), "azt-baseline-engine");
  const rules = JSON.parse(gitShow(BASE_REF, "rules/rules.compiled.json"));
  return { engine, rules };
}

/* grids.mjs 가 없을 때의 대체 격자 — 명세 §9.3 정의와 분석 스크립트(iso_path_quality·adjacent_similarity)의 시드 규칙 */
function fallbackGrids(tables) {
  const iso1224 = () => {
    const out = [];
    for (const e of tables.NL_EMO) for (const g of tables.NL_GOALS) for (const minutes of [15, 30, 60]) for (let k = 1; k <= 3; k++)
      out.push({ now_label: e.label, goal_label: g.label, now: { v: e.v, e: e.e }, target: { v: g.v, e: g.e }, minutes, seed: `guest-Q${k}:demo:1` });
    return out;
  };
  const adj660 = () => {
    const out = [];
    let k = 0;
    for (const m of tables.MOOD_CHIPS) for (const g of tables.GOAL_CHIPS) for (const minutes of [15, 30]) for (let s = 1; s <= 5; s++)
      out.push({ now_label: m[0], goal_label: g[0], now: { v: m[1], e: m[2] }, target: { v: g[1], e: g[2] }, minutes, seed: `adjacent-similarity:${++k}` });
    return out;
  };
  return { iso1224, adj660, fallback: true };
}
/** 격자 시나리오 → { now_label, goal_label, now:{v,e}, target:{v,e}, minutes, seed } (grids.mjs 의 모양이 조금 달라도 받는다) */
export function normScenario(sc) {
  const pt = (p) => (p ? { v: Number(p.v ?? p.V), e: Number(p.e ?? p.A ?? p.a) } : null);
  const now = pt(sc.now ?? sc.nowVA ?? sc.current ?? (sc.x && sc.x.nowVA));
  const target = pt(sc.target ?? sc.tgtVA ?? sc.goal_point ?? (sc.x && sc.x.tgtVA));
  const lab = (x) => (typeof x === "string" ? x : x && (x.label || x.chip)) || null;
  return {
    now_label: sc.now_label ?? sc.nowLabel ?? lab(sc.now_chip) ?? lab(sc.emotion) ?? (typeof sc.now === "string" ? sc.now : null),
    goal_label: sc.goal_label ?? sc.goalLabel ?? lab(sc.goal_chip) ?? (typeof sc.goal === "string" ? sc.goal : null),
    now, target, minutes: Number(sc.minutes ?? sc.duration_min ?? (sc.x && sc.x.minutes) ?? 30), seed: sc.seed ?? null,
    label_mode: sc.label_mode || null,
  };
}

/**
 * 도구가 쓰는 모든 것을 한 번에. 실패한 것은 null 과 notes 로.
 * @returns { engine, personal, rules, cat, baseline, tablesNow, tables76, vocab, grids, notes }
 */
export async function loadDeps({ dataRepo = null, needBaseline = true, needGrids = false } = {}) {
  const notes = [];
  const E = await tryImport("engine/engine.js");
  if (!E.mod) throw new Error(E.err);
  const P = await tryImport("engine/personal.js");
  if (!P.mod) notes.push(`${P.err} — wp·frozen 팔을 돌릴 수 없습니다`);
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, "rules", "rules.compiled.json"), "utf8"));
  if (!rules.personalization) notes.push("rules.compiled.json 에 personalization 절이 아직 없습니다");
  const { loadAppTables, loadAppTablesAt } = await import(pathToFileURL(path.join(ROOT, "tools", "sim", "app_tables.mjs")).href);
  let tablesNow = null;
  try { tablesNow = loadAppTables(); } catch (e) { notes.push(`index.html 앵커 추출 실패 → 76e8bdf 칩 사용 (${e.message.split("\n")[0]})`); }
  const tables76 = loadAppTablesAt(BASE_REF);
  const tables = tablesNow || tables76;
  const { loadCatalog } = await import(pathToFileURL(path.join(ROOT, "tools", "sim", "catalog.mjs")).href);
  const cat = loadCatalog({ ...(dataRepo ? { dataRepo } : {}), engine: E.mod, rules, tables, quiet: false });
  const baseline = needBaseline ? await loadBaselineAny(notes) : null;
  let grids = null;
  if (needGrids) {
    const G = await tryImport("tools/sim/grids.mjs");
    if (G.mod && typeof G.mod.iso1224 === "function" && typeof G.mod.adj660 === "function") grids = { iso1224: G.mod.iso1224, adj660: G.mod.adj660, fallback: false };
    else { notes.push(`${G.err || "grids.mjs 에 iso1224/adj660 없음"} → 같은 정의의 대체 격자 사용`); grids = fallbackGrids(tables); }
  }
  return { engine: E.mod, personal: P.mod, rules, cat, baseline, tablesNow, tables76, tables, vocab: tables.vocab, grids, notes };
}

export function writeFileSafe(rel, text) {
  const f = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!path.resolve(f).startsWith(ROOT)) throw new Error(`저장소 밖에 쓰지 않습니다: ${f}`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
