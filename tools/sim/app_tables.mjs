/*
 * 앱 상수표 추출 (TOOLS · 명세 §9.3 · §6.1 vocab) — index.html 에서 최상위 선언을 앵커로 떼어 와 그대로 실행한다.
 *
 * 왜 복사하지 않나: 감정 칩 좌표·자연어 단어표·장르 매핑을 도구에 따로 적어 두면 앱과 어긋난다.
 * 그래서 index.html 의 선언 한 덩어리(`const MOOD_CHIPS = [` … `\n];`)를 잘라 new Function 으로 평가한다.
 * **앵커를 하나라도 못 찾으면 멈춘다** — 앱 구조가 바뀐 것이므로 조용히 옛 값으로 넘어가지 않는다.
 * (eumchichi-data `scripts/analysis/azt_app.mjs` loadApp 과 같은 방식)
 *
 *   loadAppTables(indexHtmlPath)   이 저장소 작업 트리의 index.html (기본)
 *   loadAppTablesAt(ref)           이 저장소의 커밋(예: 기준 "76e8bdf")의 index.html — git show
 *   appTablesFromHtml(html, label) 이미 읽은 HTML
 *
 * 돌려주는 것: { MOOD_CHIPS, GOAL_CHIPS, NL_EXTRA_EMO, NL_EXTRA_GOAL, NL_K, GENRE_RULES, GENRE_RULE_EXCLUDE,
 *               deriveStress, nlCurrentPoint, NL_EMO, NL_GOALS, NL_K_WORD, nlByLabel, nlClamp, nlEmoPoint,
 *               toGenreLabels, vocab(RawFacts.vocab 모양), PACE_TP(76e8bdf 에만 있음, 없으면 null), source }
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* [이름, 시작 앵커(문자열 또는 정규식), 끝 토큰, 필수 여부]. 끝 토큰은 시작 뒤 처음 나오는 것.
   이 파일의 최상위 선언은 닫는 괄호가 줄 맨 앞에 온다는 것에 기댄다(azt_app.mjs 와 같은 앵커). */
export const APP_ANCHORS = [
  ["MOOD_CHIPS", "const MOOD_CHIPS = [", "\n];", true],
  ["GOAL_CHIPS", "const GOAL_CHIPS = [", "\n];", true],
  ["GENRE_RULES", "const GENRE_RULES = {", "\n};", true],
  ["GENRE_RULE_EXCLUDE", "const GENRE_RULE_EXCLUDE = {", "};", true],   // 마지막 항목과 같은 줄에서 닫힌다
  ["NL_EXTRA_EMO", "const NL_EXTRA_EMO = [", "\n];", true],
  ["NL_EXTRA_GOAL", "const NL_EXTRA_GOAL = [", ";", true],             // 한 줄 선언
  ["NL_EMO", /const NL_EMO\s+=\s/, ";", true],
  ["NL_GOALS", /const NL_GOALS\s+=\s/, ";", true],
  ["NL_K", "const NL_K = ", ";", true],
  ["NL_K_WORD", "const NL_K_WORD = ", ";", true],
  ["nlByLabel", "const nlByLabel = ", ";", true],
  ["nlClamp", "const nlClamp = ", ";", true],
  ["nlEmoPoint", "function nlEmoPoint(c) {", "\n", true],
  ["nlCurrentPoint", "function nlCurrentPoint(cur) {", "\n}", true],
  ["deriveStress", "function deriveStress(cur) {", "\n}", true],
  /* 속도 버튼 전환점 사본 — 76e8bdf recommend() 안에만 있다(web-personal 은 규칙 personalization.pace.manual_tp 로 옮김, B20).
     regress.mjs 의 pace 검사가 기준 앱에서 이 값을 읽는다. 없어도 된다. */
  ["PACE_TP", /const PACE_TP = \{/, "\n  };", false],
];

function sliceDecl(html, start, end, label) {
  let s, from;
  if (start instanceof RegExp) { const m = start.exec(html); s = m ? m.index : -1; from = m ? m.index + m[0].length : 0; }
  else { s = html.indexOf(start); from = s + start.length; }
  if (s < 0) return { missing: `'${start}' 를 찾지 못했습니다` };
  const e = html.indexOf(end, from);
  if (e < 0) return { missing: `'${start}' 의 끝 '${JSON.stringify(end)}' 를 찾지 못했습니다` };
  return { src: html.slice(s, e + end.length) };
}

export function appTablesFromHtml(html, label = "index.html") {
  const parts = [], missing = [];
  let hasPace = false;
  for (const [name, start, end, required] of APP_ANCHORS) {
    const r = sliceDecl(html, start, end, label);
    if (r.missing) { if (required) missing.push(`${name}: ${r.missing}`); continue; }
    /* PACE_TP 는 함수 안 들여쓴 선언이라 그대로 평가하면 된다 */
    parts.push(r.src);
    if (name === "PACE_TP") hasPace = true;
  }
  if (missing.length) throw new Error(`${label} 에서 앱 상수 앵커를 찾지 못했습니다 — 앱 구조가 바뀌었는지 확인하세요:\n  ${missing.join("\n  ")}`);
  const names = APP_ANCHORS.filter(([n, , , req]) => req).map(([n]) => n);
  const T = new Function(parts.join("\n") + `\nreturn { ${names.join(", ")}${hasPace ? ", PACE_TP" : ""} };`)();
  if (!hasPace) T.PACE_TP = null;

  /* 앱 toGenreLabels 와 같은 판정(진단용 UNMAPPED 집계만 뺐다) */
  T.toGenreLabels = (rawList) => {
    const labels = new Set();
    for (const raw of rawList || [])
      for (const [lab, pat] of Object.entries(T.GENRE_RULES)) {
        const ex = T.GENRE_RULE_EXCLUDE[lab];
        if (raw.toLowerCase() === lab.toLowerCase() || (pat.test(raw) && !(ex && ex.test(raw)))) labels.add(lab);
      }
    return [...labels];
  };
  /* RawFacts.vocab (§6.1) — 옛 기록의 표 좌표를 다시 계산할 때 personal.js 가 쓴다 */
  T.vocab = {
    mood_chips: T.MOOD_CHIPS.map((a) => [...a]), goal_chips: T.GOAL_CHIPS.map((a) => [...a]),
    nl_extra_emo: T.NL_EXTRA_EMO.map((a) => [...a]), nl_extra_goal: T.NL_EXTRA_GOAL.map((a) => [...a]),
    nl_k: Object.fromEntries(Object.entries(T.NL_K).map(([k, v]) => [String(k), v])),
  };
  T.source = label;
  return T;
}

const cache = new Map();
export function loadAppTables(indexHtmlPath = path.join(ROOT, "index.html")) {
  if (indexHtmlPath && typeof indexHtmlPath === "object" && indexHtmlPath.ref) return loadAppTablesAt(indexHtmlPath.ref, indexHtmlPath);
  const f = path.resolve(indexHtmlPath);
  const key = `file:${f}:${fs.statSync(f).mtimeMs}`;
  if (!cache.has(key)) cache.set(key, appTablesFromHtml(fs.readFileSync(f, "utf8"), path.relative(ROOT, f) || f));
  return cache.get(key);
}
export function loadAppTablesAt(ref, { repo = ROOT } = {}) {
  const key = `git:${repo}:${ref}`;
  if (!cache.has(key)) {
    const html = execFileSync("git", ["-C", repo, "show", `${ref}:index.html`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    cache.set(key, appTablesFromHtml(html, `${ref}:index.html`));
  }
  return cache.get(key);
}
