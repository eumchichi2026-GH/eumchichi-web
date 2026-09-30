/*
 * 기준 엔진·규칙 불러오기 (TOOLS · 명세 §9.1 · §9.3) — 회귀(I0)와 fix-web 쌍둥이의 비교 기준.
 *
 * 기준 = fix-web 커밋 76e8bdf(2026-09-24)의 파일을 그대로 옮겨 둔 **기준 사본** — tools/sim/baseline/ (출처는 그 폴더 README.md)
 *   engine_2.5.1.js      ← 76e8bdf:engine/engine.js            ENGINE_VERSION 2.5.1
 *   rules_v2.4.0.json    ← 76e8bdf:rules/rules.compiled.json   rules v2.4.0
 *   index_76e8bdf.html   ← 76e8bdf:index.html                  앱 상수표(app_tables.mjs)·컬렉션 이름(check.mjs)
 * 76e8bdf 는 web-personal(fix-web 클론)의 커밋이라 web 저장소에는 없다 — 그래서 git show 대신 이 사본을 읽는다.
 * 사본은 고치지 않는다. check.mjs 의 baseline-copy 검사가 git blob id(BASELINE_BLOBS)로 확인한다.
 *
 *   loadBaseline(ref = "76e8bdf")  기준 사본의 엔진·규칙. 엔진 소스는 사본을 읽어 OS 임시 파일(.mjs) → import → **바로 지운다**
 *                                  (.mjs 로 불러 package.json 유무와 상관없이 ES 모듈로 읽힌다 · eumchichi-data azt_app.mjs 의 importSource 방식)
 *   baselinePath(kind, ref)        사본 파일 경로 (kind: engine · rules · index). ref 는 76e8bdf(짧은·긴 sha)만 받는다
 *   readBaselineFile(kind, ref)    사본 파일 문자열
 *   gitBlobId(buf)                 git 이 저장하는 것과 같은 blob id (CRLF → LF 로 맞춘 뒤 sha1 — 윈도 체크아웃에서도 같은 값)
 *   loadCurrent()                  작업 트리의 engine/engine.js · engine/personal.js(없으면 null) · rules/rules.compiled.json
 *   importSource(src, name)        소스 문자열을 임시 파일로 import 하고 지운다
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE_REF = "76e8bdf";   // 기준 사본의 출처 커밋 (fix-web 76e8bdf — engine 2.5.1, rules v2.4.0)
export const BASELINE_SHA = "76e8bdfbe20feea78316b3b7e592634fe834327d";
export const BASELINE_DIR = path.join(ROOT, "tools", "sim", "baseline");
export const BASELINE_FILES = { engine: "engine_2.5.1.js", rules: "rules_v2.4.0.json", index: "index_76e8bdf.html" };
/* 76e8bdf 트리의 blob id — `git -C <web-personal> rev-parse 76e8bdf:<원래 경로>` 와 같다 */
export const BASELINE_BLOBS = {
  engine: "1cb99f9fefce4dbdfafc3a475eabaaed4362e1ab",   // engine/engine.js
  rules: "ab56a9f0770a98b37cb831cfdf631e5bb58d11af",    // rules/rules.compiled.json
  index: "27aa876e40de996fc78e7959c38621b54ce4be92",    // index.html
};

export function baselinePath(kind, ref = BASELINE_REF) {
  const r = String(ref ?? BASELINE_REF).trim().toLowerCase();
  if (r.length < 7 || !BASELINE_SHA.startsWith(r))
    throw new Error(`기준 사본은 ${BASELINE_REF} 하나뿐입니다(tools/sim/baseline/) — 받은 ref: ${ref}`);
  if (!BASELINE_FILES[kind]) throw new Error(`모르는 기준 사본 종류: ${kind} (engine · rules · index)`);
  return path.join(BASELINE_DIR, BASELINE_FILES[kind]);
}
export function readBaselineFile(kind, ref = BASELINE_REF) {
  const f = baselinePath(kind, ref);
  try { return fs.readFileSync(f, "utf8"); }
  catch (e) { throw new Error(`기준 사본을 읽지 못했습니다: ${path.relative(ROOT, f)} (${e.code || e.message})`); }
}
export function gitBlobId(buf) {
  const lf = Buffer.from(Buffer.from(buf).toString("latin1").replace(/\r\n/g, "\n"), "latin1");   // 바이트 그대로, CRLF 만 LF 로
  return crypto.createHash("sha1").update(`blob ${lf.length}\0`).update(lf).digest("hex");
}

let seq = 0;
export async function importSource(src, name = "azt-src") {
  /* 이름 충돌만 피하면 된다 — pid·순번·고해상도 시각 (도구 쪽이라 결정성 제약 없음) */
  const f = path.join(os.tmpdir(), `${name}-${process.pid}-${++seq}-${process.hrtime.bigint().toString(36)}.mjs`);
  fs.writeFileSync(f, src);
  try { return await import(pathToFileURL(f).href); }
  finally { fs.rmSync(f, { force: true }); }
}

let baseCache = null;
export async function loadBaseline(ref = BASELINE_REF) {
  baselinePath("engine", ref);   // 76e8bdf 가 아니면 여기서 멈춘다
  if (!baseCache) {
    baseCache = (async () => {
      const engineSrc = readBaselineFile("engine");
      const rules = JSON.parse(readBaselineFile("rules"));
      const engine = await importSource(engineSrc, `azt-engine-${BASELINE_REF}`);
      return { ref: BASELINE_REF, sha: BASELINE_SHA, engine, rules, engineSrc };
    })();
  }
  return baseCache;
}

/* 작업 트리 모듈. personal.js 는 ENGINE 빌더가 아직 안 만들었을 수 있다 — 그때 personal = null, errors 에 이유.
   fresh = true 면 파일 수정 시각을 주소에 붙여 새로 읽는다(같은 프로세스에서 고친 뒤 다시 볼 때). */
export async function loadCurrent({ root = ROOT, fresh = false } = {}) {
  const url = (rel) => {
    const f = path.join(root, rel);
    return pathToFileURL(f).href + (fresh ? `?t=${fs.statSync(f).mtimeMs}` : "");
  };
  const errors = {};
  let engine = null, personal = null, rules = null;
  try { engine = await import(url("engine/engine.js")); } catch (e) { errors.engine = e; }
  if (fs.existsSync(path.join(root, "engine", "personal.js"))) {
    try { personal = await import(url("engine/personal.js")); } catch (e) { errors.personal = e; }
  } else errors.personal = new Error("engine/personal.js 가 아직 없습니다");
  try { rules = JSON.parse(fs.readFileSync(path.join(root, "rules", "rules.compiled.json"), "utf8")); } catch (e) { errors.rules = e; }
  return { engine, personal, rules, errors };
}

/* 필요한 export 가 모두 있는지 — 없으면 이름 목록 */
export function missingExports(mod, names) {
  if (!mod) return [...names];
  return names.filter((n) => !(n in mod));
}
