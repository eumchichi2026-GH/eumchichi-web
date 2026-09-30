/*
 * 데이터 저장소(eumchichi-data) 찾기 — 카탈로그 로더(catalog.mjs)·로컬 서버(server.mjs)·검사 도구가 같이 쓴다. Node 내장 모듈만.
 *
 * 찾는 순서
 *   ① 명시한 경로   --data-repo <경로>(호출자가 넘김) → 환경변수 AZT_DATA_REPO
 *                   주면 그 경로만 본다 — 없으면 옆 폴더로 넘어가지 않고 멈춘다(잘못 적은 경로를 조용히 무시하지 않으려고)
 *   ② <web2>/../eumchichi-data      옛 단독 배치  — 구글캡디/web-personal 옆의 구글캡디/eumchichi-data
 *   ③ <web2>/../../eumchichi-data   web 저장소 안 — 구글캡디/eumchichi-web/web2 에서 구글캡디/eumchichi-data
 * 못 찾으면 AZT_DATA_REPO 를 알려 주는 오류를 던진다. 데이터 저장소는 읽기만 한다(catalog.mjs 가 git show 로).
 *
 *   findDataRepo(explicit, { root, env })     → { path, from } 또는 { path: null, tried, error } (던지지 않음 — 서버 시작 안내용)
 *   resolveDataRepo(explicit, { root, env })  → 경로 문자열, 못 찾으면 오류
 *   dataRepoCandidates(root)                  → ②·③ 후보 경로
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 이 파일은 <web2>/tools/sim/ 에 있다 */
export const WEB2_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_REPO_ENV = "AZT_DATA_REPO";

export function dataRepoCandidates(root = WEB2_ROOT) {
  return [path.resolve(root, "..", "eumchichi-data"), path.resolve(root, "..", "..", "eumchichi-data")];
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

export function findDataRepo(explicit = null, { root = WEB2_ROOT, env = process.env } = {}) {
  const given = explicit ? ["--data-repo", explicit] : env[DATA_REPO_ENV] ? [DATA_REPO_ENV, env[DATA_REPO_ENV]] : null;
  if (given) {
    const p = path.resolve(String(given[1]));
    if (isDir(p)) return { path: p, from: given[0] };
    return { path: null, tried: [p],
             error: `데이터 저장소가 없습니다: ${p} (${given[0]} 로 준 경로) — eumchichi-data 클론 경로를 확인하세요` };
  }
  const tried = dataRepoCandidates(root);
  for (const p of tried) if (isDir(p)) return { path: p, from: path.relative(root, p) };
  return { path: null, tried,
           error: `데이터 저장소(eumchichi-data)를 찾지 못했습니다 — 찾아본 곳: ${tried.join(" · ")}. ` +
                  `환경변수 ${DATA_REPO_ENV} 에 클론 경로를 주거나(예: PowerShell $env:${DATA_REPO_ENV}="C:\\…\\eumchichi-data") --data-repo <경로> 를 붙이세요` };
}

export function resolveDataRepo(explicit = null, opts = {}) {
  const r = findDataRepo(explicit, opts);
  if (!r.path) throw new Error(r.error);
  return r.path;
}
