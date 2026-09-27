/*
 * 기준 엔진·규칙 불러오기 (TOOLS · 명세 §9.1 · §9.3) — 회귀(I0)와 fix-web 쌍둥이의 비교 기준.
 *
 *   loadBaseline(ref = "76e8bdf")  이 저장소 커밋의 engine/engine.js(2.5.1)·rules/rules.compiled.json(v2.4.0)
 *                                  엔진 소스는 `git show` → OS 임시 파일(.mjs) → import → **바로 지운다**
 *                                  (eumchichi-data azt_app.mjs 의 importSource 방식. 저장소 안에 사본을 두지 않는다)
 *   loadCurrent()                  작업 트리의 engine/engine.js · engine/personal.js(없으면 null) · rules/rules.compiled.json
 *   importSource(src, name)        소스 문자열을 임시 파일로 import 하고 지운다
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE_REF = "76e8bdf";   // 명세 기준 커밋 (engine 2.5.1, rules v2.4.0)

const gitShowHere = (repo, ref, p) =>
  execFileSync("git", ["-C", repo, "show", `${ref}:${p}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

let seq = 0;
export async function importSource(src, name = "azt-src") {
  /* 이름 충돌만 피하면 된다 — pid·순번·고해상도 시각 (도구 쪽이라 결정성 제약 없음) */
  const f = path.join(os.tmpdir(), `${name}-${process.pid}-${++seq}-${process.hrtime.bigint().toString(36)}.mjs`);
  fs.writeFileSync(f, src);
  try { return await import(pathToFileURL(f).href); }
  finally { fs.rmSync(f, { force: true }); }
}

const baseCache = new Map();
export async function loadBaseline(ref = BASELINE_REF, { repo = ROOT } = {}) {
  const key = `${repo}@${ref}`;
  if (!baseCache.has(key)) {
    baseCache.set(key, (async () => {
      const sha = execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();
      const engineSrc = gitShowHere(repo, sha, "engine/engine.js");
      const rules = JSON.parse(gitShowHere(repo, sha, "rules/rules.compiled.json"));
      const engine = await importSource(engineSrc, `azt-engine-${sha.slice(0, 7)}`);
      return { ref, sha, engine, rules, engineSrc };
    })());
  }
  return baseCache.get(key);
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
