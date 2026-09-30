/*
 * 데이터 안전·정적 검사 (TOOLS · 명세 §11 I · I7 · I8 · I9) — 매 병합 전에 돌린다.
 *
 *   node tools/sim/check.mjs                       전부
 *   node tools/sim/check.mjs --quick               카탈로그·엔진 실행이 필요한 검사(trace 키 실측)는 건너뜀
 *   node tools/sim/check.mjs --app-contract <json> 앱 AZT_DEBUG.dumpContract(ids) 결과와 도구 카탈로그를 곡마다 비교(§6.2)
 *
 * 검사 (✗ 가 하나라도 있으면 exit 1, ⚠ 는 경고만)
 *   determinism      engine/*.js 코드(주석·문자열 제외)에 Math.random · Date.now 0 (I7)
 *   rules-hash       rules_hash 가 내용과 일치 (tools/rules_hash.mjs, B7)
 *   personalization  rules.personalization 이 명세 §10 의 키를 모두 같은 타입으로 가짐 · 하위 절마다 *_evidence (I8)
 *   trace-keys       rules.trace_keys ⊇ 명세 §6.8 의 p_* 키 ⊇ 엔진이 P 모드에서 실제로 내는 p_* 키 · 설명의 trace_key·binds 가 trace_keys 안
 *   fs-writes        index.html 의 모든 Firestore 쓰기(.add/.set/.update/.delete/.commit)가 fsWrite 안 (계정 삭제 batch 만 예외) ·
 *                    fsWrite 가 AZT_ENV.writes 를 본다 (I9 · §7.5)
 *   collections      index.html 의 컬렉션 이름 ⊆ 76e8bdf 에 있던 것 (새 컬렉션 0 — 기준 사본 tools/sim/baseline/index_76e8bdf.html)
 *   baseline-copy    기준 사본 3개(tools/sim/baseline/)가 76e8bdf 원본과 같은 git blob id · 엔진 2.5.1 · 규칙 v2.4.0 (회귀 I0 의 기준)
 *   song-stats       song_stats 에 쓰는 키 ⊆ 기존 7개
 *   app-numbers      앱에 규칙 숫자 사본이 없음 — PACE_TP · RECENT_MAX · extras 0.85 (I8 · B20)
 *   sw-version       sw.js VERSION ≠ azt-v9
 *   env              index.html 이 env.js 를 앱 스크립트보다 먼저 부름 · server.mjs 기본 실행의 /env.js 가 writes:false·offline:true ·
 *                    local_firebase.js 가 Firebase SDK 뒤·앱 스크립트 앞 · .gitignore 에 .env* ·
 *                    정적 env.js 가 배포 루트에서만 쓰기·서비스워커를 켜고 로컬 주소·하위 경로(/web2/ 등)에서는 끔 (web2 2026-09-30)
 *   no-deps          package.json 없음 · server.mjs·tools/sim·engine 은 node: 내장 모듈과 상대 경로만 import
 *   contract         (--app-contract 를 줄 때만) 앱과 도구의 ContractSong 이 같은 값
 * "로컬 서버 기본 실행과 데모 모드에서 Firestore 쓰기 호출 0(개발 페이지 카운터)" 은 브라우저에서 보는 수동 점검(§11 J)이다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules } from "node:module";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASELINE_REF, BASELINE_BLOBS, baselinePath, gitBlobId, readBaselineFile } from "./baseline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = path.join(ROOT, "docs", "personalization_spec_20260927.md");
const SONG_STATS_KEYS = ["likes", "dislikes", "completes", "clicks", "playlistAdds", "sum_change", "n_change"];   // 기존 7개 (§7.5)
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

// ── JS 스캐너: 주석·문자열·정규식 내용을 공백으로 (길이·줄바꿈 보존) ──
const KW_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
export function stripJs(src) {
  const out = src.split("");
  const comments = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " "; };
  const tpl = [];   // 템플릿 ${ } 깊이 스택
  let i = 0;
  const prevSig = (k) => { let j = k - 1; while (j >= 0 && /\s/.test(out[j])) j--; return j; };
  const regexAllowed = (k) => {
    const j = prevSig(k);
    if (j < 0) return true;
    const c = out[j];
    if ("(,=:[!&|?{};+-*%<>~^".includes(c)) return true;
    if (/[\w$]/.test(c)) { let s = j; while (s > 0 && /[\w$]/.test(out[s - 1])) s--; return KW_BEFORE_REGEX.has(out.slice(s, j + 1).join("")); }
    return false;
  };
  const scanTemplate = (start) => {   // start = 여는 ` 다음. 닫는 ` 또는 ${ 에서 멈춘다
    let k = start;
    while (k < src.length) {
      if (src[k] === "\\") { k += 2; continue; }
      if (src[k] === "`") { blank(start, k); return { end: k + 1, open: false }; }
      if (src[k] === "$" && src[k + 1] === "{") { blank(start, k); return { end: k + 2, open: true }; }
      k++;
    }
    blank(start, src.length); return { end: src.length, open: false };
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e; comments.push({ at: i, text: src.slice(i, end) }); blank(i, end); i = end; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; comments.push({ at: i, text: src.slice(i, end) }); blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let k = i + 1; while (k < src.length && src[k] !== c && src[k] !== "\n") { if (src[k] === "\\") k++; k++; }
      blank(i + 1, k); i = k + 1; continue;
    }
    if (c === "`") { const r = scanTemplate(i + 1); if (r.open) tpl.push(0); i = r.end; continue; }
    if (tpl.length && c === "{") { tpl[tpl.length - 1]++; i++; continue; }
    if (tpl.length && c === "}") {
      if (tpl[tpl.length - 1] === 0) { tpl.pop(); const r = scanTemplate(i + 1); if (r.open) tpl.push(0); i = r.end; continue; }
      tpl[tpl.length - 1]--; i++; continue;
    }
    if (c === "/" && regexAllowed(i)) {
      let k = i + 1, cls = false;
      while (k < src.length && src[k] !== "\n") {
        if (src[k] === "\\") { k += 2; continue; }
        if (src[k] === "[") cls = true; else if (src[k] === "]") cls = false; else if (src[k] === "/" && !cls) break;
        k++;
      }
      blank(i + 1, k); i = k + 1; continue;
    }
    i++;
  }
  return { code: out.join(""), comments };
}
/* code[open] 이 여는 괄호일 때 짝이 되는 닫는 괄호 위치 */
function matchForward(code, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let k = open; k < code.length; k++) {
    const c = code[k];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") { if (stack.pop() !== c) return -1; if (!stack.length) return k; }
  }
  return -1;
}
function matchBackward(code, close) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const c = code[k];
    if (pairs[c]) depth++;
    else if (c === "(" || c === "[" || c === "{") { depth--; if (!depth) return k; }
  }
  return -1;
}
/* '.' 바로 앞에서 시작해 호출 받는 쪽 식(a.b(…).c)을 거꾸로 읽는다 */
function receiverChain(code, dot) {
  let k = dot - 1;
  while (k >= 0 && /\s/.test(code[k])) k--;
  let start = k + 1;
  while (k >= 0) {
    const c = code[k];
    if (c === ")" || c === "]") { const o = matchBackward(code, k); if (o < 0) break; k = o - 1; start = o; continue; }
    if (/[\w$]/.test(c)) { while (k >= 0 && /[\w$]/.test(code[k])) k--; start = k + 1; }
    else break;
    let j = k; while (j >= 0 && /\s/.test(code[j])) j--;
    if (j >= 0 && code[j] === "." ) { k = j - 1; if (k >= 0 && code[k] === "?") k--; while (k >= 0 && /\s/.test(code[k])) k--; continue; }
    break;
  }
  return { start, text: code.slice(start, dot).replace(/\s+/g, "") };
}
/* 인라인 <script> 블록들 (src 없는 것) */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\bsrc\s*=/.test(m[1])) out.push({ offset: m.index + m[0].indexOf(">") + 1, attrs: m[1], src: m[2] });
  return out;
}
function splitTopArgs(code, open) {   // code[open] === "(" → [ [a,b], … ] 인자별 구간
  const close = matchForward(code, open);
  if (close < 0) return [];
  const args = [];
  let depth = 0, s = open + 1;
  for (let k = open + 1; k < close; k++) {
    const c = code[k];
    if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { args.push([s, k]); s = k + 1; }
  }
  args.push([s, close]);
  return args;
}
/* 객체 리터럴 { … } 의 최상위 키. 계산된 키·전개는 unknown 으로 */
function objectKeys(orig, code, a, b) {
  let k = a; while (k < b && /\s/.test(code[k])) k++;
  if (code[k] !== "{") return null;
  const close = matchForward(code, k);
  const keys = [], unknown = [];
  let depth = 0, expectKey = true;
  for (let p = k + 1; p < close; p++) {
    const c = code[p];
    if ("([{".includes(c)) { if (depth === 0 && expectKey && c === "[") unknown.push(orig.slice(p, matchForward(code, p) + 1)); depth++; expectKey = false; continue; }
    if (")]}".includes(c)) { depth--; continue; }
    if (depth) continue;
    if (c === ",") { expectKey = true; continue; }
    if (!expectKey || /\s/.test(c)) continue;
    if (orig.startsWith("...", p)) { unknown.push("..." + /^[\w$.]*/.exec(orig.slice(p + 3))[0]); expectKey = false; continue; }
    let m = /^([A-Za-z_$][\w$]*)|^"([^"]*)"|^'([^']*)'/.exec(orig.slice(p));
    if (m) { keys.push(m[1] || m[2] || m[3]); p += m[0].length - 1; }
    expectKey = false;
  }
  return { keys, unknown };
}

// ── 검사들 ───────────────────────────────────────────────
const results = [];
const add = (id, status, detail) => results.push({ id, status, detail });   // status: "ok" | "fail" | "warn" | "skip"

function checkDeterminism() {
  const files = fs.readdirSync(path.join(ROOT, "engine")).filter((f) => f.endsWith(".js")).sort();
  const bad = [], mention = [];
  for (const f of files) {
    const src = read(`engine/${f}`);
    const { code, comments } = stripJs(src);
    for (const re of [/\bMath\s*\.\s*random\b/g, /\bDate\s*\.\s*now\b/g, /\bMath\s*\[\s*["']random["']\s*\]/g]) {
      let m; while ((m = re.exec(code))) bad.push(`engine/${f}:${lineOf(src, m.index)} ${m[0].replace(/\s+/g, "")}`);
    }
    let m; const nd = /\bnew\s+Date\s*\(\s*\)/g;
    while ((m = nd.exec(code))) mention.push(`engine/${f}:${lineOf(src, m.index)} new Date() (인자 없는 현재 시각)`);
    for (const c of comments) if (/Math\.random|Date\.now/.test(c.text)) mention.push(`engine/${f}:${lineOf(src, c.at)} 주석 안 언급(코드 아님)`);
  }
  if (bad.length) add("determinism", "fail", `Math.random·Date.now 발견 — ${bad.join(" · ")}`);
  else add("determinism", mention.some((x) => x.includes("new Date()")) ? "warn" : "ok",
           `engine/*.js ${files.length}개 (${files.join(", ")}) 코드에 Math.random·Date.now 0${mention.length ? ` · 참고: ${mention.join(" · ")}` : ""}`);
}

function checkRulesHash() {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "rules_hash.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    add("rules-hash", "ok", out.trim());
  } catch (e) {
    add("rules-hash", "fail", `${String(e.stderr || e.stdout || e.message).trim().split("\n")[0]} — ENGINE 이 규칙을 고친 뒤 node tools/rules_hash.mjs --write`);
  }
}

/* 명세 §10 의 ```json 블록을 그대로 파싱해 키 목록을 얻는다(문서가 기준 — 사본을 두지 않는다) */
function specPersonalization() {
  const md = fs.readFileSync(SPEC, "utf8");
  const h = md.indexOf("## 10.");
  const s = md.indexOf("```json", h), e = md.indexOf("```", s + 7);
  if (h < 0 || s < 0 || e < 0) throw new Error("명세 §10 의 json 블록을 찾지 못했습니다");
  return JSON.parse("{" + md.slice(s + 7, e) + "}").personalization;
}
const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
function checkPersonalization(rules) {
  let spec;
  try { spec = specPersonalization(); } catch (e) { add("personalization", "fail", e.message); return; }
  const P = rules.personalization;
  if (!P || typeof P !== "object") { add("personalization", "fail", "rules.personalization 절이 없습니다 (ENGINE, §10)"); return; }
  const missing = [], wrongType = [];
  const walk = (s, r, p) => {
    for (const [k, v] of Object.entries(s)) {
      const q = p ? `${p}.${k}` : k;
      if (!r || !(k in r)) { missing.push(q); continue; }
      if (typeOf(v) !== typeOf(r[k])) { wrongType.push(`${q}(${typeOf(v)}→${typeOf(r[k])})`); continue; }
      if (typeOf(v) === "object") walk(v, r[k], q);
    }
  };
  walk(spec, P, "");
  /* 근거 문자열: 최상위 evidence + 객체인 하위 절마다 *_evidence (명세에 없는 새 절도) */
  const noEv = [];
  if (typeof P.evidence !== "string" || !P.evidence.trim()) noEv.push("(최상위) evidence");
  for (const [k, v] of Object.entries(P)) {
    if (typeOf(v) !== "object") continue;
    if (!Object.entries(v).some(([kk, vv]) => /evidence$/.test(kk) && typeof vv === "string" && vv.trim())) noEv.push(k);
  }
  const extra = Object.keys(P).filter((k) => !(k in spec));
  const bad = missing.length || wrongType.length || noEv.length;
  add("personalization", bad ? "fail" : "ok",
      bad ? [missing.length && `없는 키 ${missing.length}: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}`,
             wrongType.length && `타입 다름: ${wrongType.join(", ")}`, noEv.length && `근거 문자열 없는 절: ${noEv.join(", ")}`].filter(Boolean).join(" · ")
          : `§10 키 모두 있음 · 절마다 근거 문자열${extra.length ? ` · 명세에 없는 절(근거 있음): ${extra.join(", ")}` : ""}`);
}

function specTraceKeys() {
  const md = fs.readFileSync(SPEC, "utf8");
  const s = md.indexOf("### 6.8"), e = md.indexOf("## 7.", s);
  if (s < 0) throw new Error("명세 §6.8 을 찾지 못했습니다");
  const sec = md.slice(s, e < 0 ? md.length : e);
  const keys = new Set();
  for (const line of sec.split("\n")) if (line.startsWith("| `p_")) for (const m of line.split("|")[1].matchAll(/`(p_[a-z_]+)`/g)) keys.add(m[1]);
  return [...keys];
}
async function checkTraceKeys(rules, { quick, dataRepo }) {
  const tk = new Set(rules.trace_keys || []);
  const problems = [];
  const specKeys = specTraceKeys();
  const missSpec = specKeys.filter((k) => !tk.has(k));
  if (missSpec.length) problems.push(`명세 §6.8 키가 trace_keys 에 없음: ${missSpec.join(", ")}`);
  for (const e of rules.explanations || []) {
    if (e.when && e.when.trace_key && !tk.has(e.when.trace_key)) problems.push(`설명 ${e.id} 의 trace_key ${e.when.trace_key} 없음`);
    for (const b of e.binds || []) if (!tk.has(b)) problems.push(`설명 ${e.id} 의 binds ${b} 없음`);
  }
  let seen = null, note = "";
  if (quick) note = " · 실측은 --quick 으로 건너뜀";
  else {
    try {
      const { loadCurrent } = await import("./baseline.mjs");
      const { loadCatalog } = await import("./catalog.mjs");
      const { iso1224 } = await import("./grids.mjs");
      const C = await loadCurrent();
      if (!C.engine) throw new Error(`engine.js import 실패: ${C.errors.engine && C.errors.engine.message}`);
      const P = C.personal;
      if (!P || typeof P.resolvePolicy !== "function" || typeof P.emptyModel !== "function") throw new Error("engine/personal.js 의 resolvePolicy·emptyModel 이 없어 P 모드를 돌릴 수 없습니다");
      const { songs } = loadCatalog({ dataRepo, engine: C.engine, rules, quiet: true });
      seen = new Set();
      const grid = iso1224().filter((_, i) => i % 97 === 0);   // 감정·목표·길이가 섞인 13개
      for (const sc of grid) {
        const m = sc.meta;
        const ctx = { now: m.now, target: m.target, now_table: m.now, target_table: m.target, labels: { current: { mode: "tap" }, target: { mode: "tap" } },
                      nudged: { current: false, target: false }, minutes: m.minutes, lyric: "no_preference", genres: [], pace_user: null,
                      seed: sc.inputs.seed, global_stats: {}, disliked_now: [], session_no: 1 };
        const out = P.resolvePolicy(P.emptyModel(rules), ctx, rules, { mode: "p0" });
        const inputs = { ...sc.inputs, user: out.user || sc.inputs.user, personal: out.policy };
        const res = C.engine.recommend(songs, rules, inputs);
        for (const r of res.sequence || []) for (const k of Object.keys(r.trace || {})) if (k.startsWith("p_")) seen.add(k);
        if (typeof C.engine.recommendExtras === "function") {
          const ex = C.engine.recommendExtras(songs, rules, inputs, res, {});   // target_sec 생략 → 엔진 기본(감상 시간 × 60 × extras.fill_ratio)
          for (const r of (ex && ex.extras) || []) for (const k of Object.keys(r.trace || {})) if (k.startsWith("p_")) seen.add(k);
        }
      }
      const missRun = [...seen].filter((k) => !tk.has(k));
      if (missRun.length) problems.push(`엔진이 내는데 trace_keys 에 없음: ${missRun.join(", ")}`);
      if (!seen.size) problems.push("P 모드 실행에서 p_* 키가 하나도 나오지 않았습니다");
    } catch (e) { problems.push(`실측 불가 — ${e.message}`); }
  }
  add("trace-keys", problems.length ? "fail" : "ok",
      problems.length ? problems.join(" · ") : `§6.8 키 ${specKeys.length}개 · 설명 trace_key/binds 모두 trace_keys 안${seen ? ` · P 모드 실측 p_* ${seen.size}개 모두 포함` : ""}${note}`);
}

/* index.html 의 Firestore 쓰기 위치 */
export function firestoreWrites(html) {
  const found = [];   // { line, text, allowed, why }
  let hasFsWrite = false, fsWriteSeesEnv = false;
  for (const blk of inlineScripts(html)) {
    const { code } = stripJs(blk.src);
    /* fsWrite 본문 범위 */
    const ranges = [];
    for (const re of [/\b(?:async\s+)?function\s+fsWrite\s*\(/g, /\b(?:const|let|var)\s+fsWrite\s*=\s*(?:async\s*)?(?:function\s*)?\(/g]) {
      let m;
      while ((m = re.exec(code))) {
        const pOpen = code.indexOf("(", m.index + m[0].length - 1);
        const pClose = matchForward(code, pOpen);
        const bOpen = code.indexOf("{", pClose);
        const bClose = matchForward(code, bOpen);
        if (bOpen > 0 && bClose > 0) { ranges.push([bOpen, bClose]); hasFsWrite = true; if (/AZT_ENV|\bwrites\b/.test(code.slice(bOpen, bClose))) fsWriteSeesEnv = true; }
      }
    }
    /* Firestore 참조를 담은 변수 (읽기 결과 .get() 은 제외) · batch 변수 */
    const fsVars = new Set(["db"]), batchVars = new Set();
    const decl = /\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([^;\n]*)/g;
    let m;
    while ((m = decl.exec(code))) {
      const rhs = m[2];
      if (/^=/.test(rhs)) continue;   // == 비교
      if (/\.batch\(\s*\)/.test(rhs)) { batchVars.add(m[1]); fsVars.add(m[1]); continue; }
      if (/firestore\(\s*\)|\.collection\(|\.doc\(/.test(rhs) && !/\.(get|onSnapshot)\(/.test(rhs)) fsVars.add(m[1]);
    }
    const call = /\.\s*(add|set|update|delete|commit)\s*\(/g;
    while ((m = call.exec(code))) {
      const ch = receiverChain(code, m.index);
      const root = (/^[A-Za-z_$][\w$]*/.exec(ch.text) || [""])[0];
      const isFs = /firestore\(\)|\.collection\(|\.doc\(|\.batch\(/.test(ch.text) || fsVars.has(root);
      if (!isFs) continue;
      const at = m.index;
      const inFsWrite = ranges.some(([a, b]) => at > a && at < b);
      const batchDelete = batchVars.has(root) && (m[1] === "delete" || m[1] === "commit");
      const line = lineOf(html, blk.offset + at);
      const text = `${ch.text}.${m[1]}(`.slice(-90);
      found.push({ line, text, allowed: inFsWrite || batchDelete, why: inFsWrite ? "fsWrite 안" : batchDelete ? "계정 삭제 batch(예외)" : "fsWrite 밖" });
    }
  }
  return { found, hasFsWrite, fsWriteSeesEnv };
}
function checkFsWrites() {
  const html = read("index.html");
  const { found, hasFsWrite, fsWriteSeesEnv } = firestoreWrites(html);
  const outside = found.filter((f) => !f.allowed);
  const probs = [];
  if (!hasFsWrite) probs.push("index.html 에 fsWrite 함수가 없습니다 (APP §7.5)");
  else if (!fsWriteSeesEnv) probs.push("fsWrite 가 AZT_ENV.writes 를 보지 않습니다 (로컬·데모 쓰기 끔)");
  if (outside.length) probs.push(`fsWrite 밖 Firestore 쓰기 ${outside.length}곳: ${outside.map((f) => `L${f.line} ${f.text}`).join(" · ")}`);
  add("fs-writes", probs.length ? "fail" : "ok",
      probs.length ? probs.join(" · ") : `Firestore 쓰기 ${found.length}곳 모두 fsWrite 안(예외: 계정 삭제 batch ${found.filter((f) => f.why.startsWith("계정")).length})`);
}

const collectionNames = (html) => [...new Set([...html.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]))].sort();
function checkCollections() {
  let base;
  try { base = collectionNames(readBaselineFile("index")); }
  catch (e) { add("collections", "fail", `기준 ${BASELINE_REF}:index.html(기준 사본)을 읽지 못했습니다 — ${e.message}`); return; }
  const now = collectionNames(read("index.html"));
  const extra = now.filter((c) => !base.includes(c));
  add("collections", extra.length ? "fail" : "ok", extra.length ? `새 컬렉션: ${extra.join(", ")} (허용: ${base.join(", ")})` : `컬렉션 ${now.join(", ")} ⊆ 기준 ${BASELINE_REF}`);
}

/* 기준 사본은 76e8bdf 원본과 바이트까지 같아야 한다(줄바꿈만 git 처럼 LF 로 맞춰 비교) — 고치면 회귀 I0 의 기준이 바뀐다 */
function checkBaselineCopies() {
  const probs = [];
  for (const [kind, blob] of Object.entries(BASELINE_BLOBS)) {
    const f = baselinePath(kind);
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    if (!fs.existsSync(f)) { probs.push(`${rel} 없음`); continue; }
    const id = gitBlobId(fs.readFileSync(f));
    if (id !== blob) probs.push(`${rel} blob ${id.slice(0, 12)} ≠ 원본 ${blob.slice(0, 12)}`);
  }
  if (!probs.length) {
    const eng = /export const ENGINE_VERSION = "([^"]+)"/.exec(readBaselineFile("engine"));
    const rules = JSON.parse(readBaselineFile("rules"));
    if (!eng || eng[1] !== "2.5.1") probs.push(`엔진 사본 ENGINE_VERSION ${eng ? eng[1] : "?"} ≠ 2.5.1`);
    if (rules.rules_version !== "v2.4.0") probs.push(`규칙 사본 rules_version ${rules.rules_version} ≠ v2.4.0`);
  }
  add("baseline-copy", probs.length ? "fail" : "ok",
      probs.length ? `${probs.join(" · ")} — tools/sim/baseline/README.md 대로 76e8bdf 원본을 다시 옮길 것`
                   : `tools/sim/baseline/ 3개 = ${BASELINE_REF} 원본 blob · 엔진 2.5.1 · 규칙 v2.4.0`);
}

function checkSongStats() {
  const html = read("index.html");
  const bad = [], unknown = [];
  let sites = 0;
  /* fsWrite 허용 목록(FS_ALLOWED.stats)이 있으면 그것도 7개 안이어야 한다 */
  const allow = /\bFS_ALLOWED\s*=\s*\{[\s\S]*?\bstats\s*:\s*\[([^\]]*)\]/.exec(html);
  if (allow) for (const k of [...allow[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1])) if (!SONG_STATS_KEYS.includes(k)) bad.push(`FS_ALLOWED.stats ${k}`);
  for (const blk of inlineScripts(html)) {
    const { code } = stripJs(blk.src);
    /* bumpStats(id, fields) 안의 fsWrite("stats", id, fields) 는 전달일 뿐 — bumpStats 호출부의 키를 본다 */
    const wrappers = [];
    for (const w of code.matchAll(/\bfunction\s+bumpStats\s*\(/g)) {
      const pc = matchForward(code, code.indexOf("(", w.index)), bo = code.indexOf("{", pc);
      wrappers.push([bo, matchForward(code, bo)]);
    }
    const re = /\b(bumpStats|fsWrite)\s*\(/g;
    let m;
    while ((m = re.exec(code))) {
      if (m[1] === "fsWrite" && wrappers.some(([a, b]) => m.index > a && m.index < b)) continue;
      const open = m.index + m[0].length - 1;
      const args = splitTopArgs(code, open);
      let dataArg;
      if (m[1] === "bumpStats") dataArg = args[1];
      else {
        const kind = args[0] && blk.src.slice(args[0][0], args[0][1]).trim();
        if (!/^["'`]stats["'`]$/.test(kind || "")) continue;
        dataArg = args[2];
      }
      if (!dataArg) continue;
      /* 정의부(function bumpStats(songId, fields)) 는 호출이 아니다 */
      const before = code.slice(Math.max(0, m.index - 9), m.index);
      if (/function\s*$/.test(before)) continue;
      sites++;
      const line = lineOf(html, blk.offset + m.index);
      const ok = objectKeys(blk.src, code, dataArg[0], dataArg[1]);
      if (!ok) { unknown.push(`L${line} ${blk.src.slice(dataArg[0], dataArg[1]).trim().slice(0, 40)}`); continue; }
      for (const k of ok.keys) if (!SONG_STATS_KEYS.includes(k)) bad.push(`L${line} ${k}`);
      for (const u of ok.unknown) unknown.push(`L${line} ${u}`);
    }
  }
  if (bad.length) add("song-stats", "fail", `기존 7개 밖의 키: ${bad.join(" · ")}`);
  else add("song-stats", unknown.length ? "warn" : "ok", `쓰는 곳 ${sites}곳 · 키 ⊆ {${SONG_STATS_KEYS.join(", ")}}${unknown.length ? ` · 정적으로 못 읽은 인자: ${unknown.join(" · ")}` : ""}`);
}

function checkAppNumbers() {
  const html = read("index.html");
  const code = inlineScripts(html).map((b) => stripJs(b.src).code).join("\n");
  const hits = [];
  if (/\bconst\s+PACE_TP\s*=/.test(code)) hits.push("PACE_TP (→ personalization.pace.manual_tp, B20)");
  if (/\bRECENT_MAX\s*=\s*\d/.test(code)) hits.push("RECENT_MAX = 숫자 (→ personalization.diversity.recent_window)");
  if (/\*\s*0\.85\b/.test(code)) hits.push("× 0.85 (→ personalization.extras.fill_ratio)");
  add("app-numbers", hits.length ? "fail" : "ok", hits.length ? `앱에 규칙 숫자 사본: ${hits.join(" · ")}` : "PACE_TP·RECENT_MAX·0.85 사본 없음");
}

function checkSw() {
  if (!exists("sw.js")) { add("sw-version", "fail", "sw.js 없음"); return; }
  const m = /const\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(read("sw.js"));
  if (!m) { add("sw-version", "fail", "sw.js 에서 VERSION 을 찾지 못했습니다"); return; }
  if (m[1] === "azt-v9") add("sw-version", "fail", "VERSION 이 아직 azt-v9 — fix-web 과 캐시를 공유합니다 (APP: azt-personal-v1)");
  else add("sw-version", m[1] === "azt-personal-v1" ? "ok" : "warn", `VERSION ${m[1]}${m[1] === "azt-personal-v1" ? "" : " (명세 권장 azt-personal-v1)"}`);
}

async function checkEnv() {
  const probs = [], notes = [];
  const html = read("index.html");
  const tag = /<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/|\/)?env\.js(?:\?[^"']*)?["'][^>]*>/i.exec(html);
  if (!tag) probs.push("index.html 이 env.js 를 부르지 않습니다 (APP §9.5-1)");
  else {
    const firstApp = inlineScripts(html).find((b) => /function\s+loadEngine|AZT_ENV/.test(b.src));
    if (firstApp && tag.index > firstApp.offset) probs.push("env.js 가 앱 스크립트보다 뒤에 있습니다");
    if (/\b(?:async|defer|type\s*=\s*["']module["'])/i.test(tag[0])) notes.push("env.js 태그에 async/defer/module — 앱보다 늦게 실행될 수 있음");
  }
  if (!exists("env.js")) notes.push("저장소에 배포용 env.js 없음(APP)");
  else {
    /* [web2 2026-09-30] 정적 env.js 를 주소별로 실행해 본다 — 운영 쓰기는 배포 도메인 루트에서만. web 저장소 루트 배포에 딸려
       /web2/ 로 열리면 API·서비스워커가 web 의 것이라 쓰기·서비스워커를 꺼야 한다(README "배포 주의") */
    const envSrc = read("env.js");
    const evalEnv = (href) => {
      const ctx = { location: new URL(href), window: {}, console: { warn() {}, info() {}, log() {} } };
      ctx.window.console = ctx.console;
      vm.runInNewContext(envSrc, ctx, { timeout: 1000 });
      return ctx.window.AZT_ENV || {};
    };
    const cases = [
      ["https://azt-personal.vercel.app/", true], ["https://azt-personal.vercel.app/index.html?source=pwa", true],
      ["https://azt.vercel.app/web2/", false], ["https://azt.vercel.app/web2/index.html", false],
      ["http://localhost:5180/", false], ["http://127.0.0.1:5180/", false],
    ];
    for (const [href, on] of cases) {
      try {
        const env = evalEnv(href);
        if (env.writes !== on || env.sw !== on) probs.push(`정적 env.js 가 ${href} 에서 writes:${env.writes}·sw:${env.sw} (기대 ${on})`);
      } catch (e) { probs.push(`정적 env.js 실행 실패(${href}): ${e.message}`); break; }
    }
  }
  try {
    const srv = await import(pathToFileURL(path.join(ROOT, "server.mjs")).href);
    const o = srv.parseServerArgs([]);
    const { port, close } = await srv.startServer({ ...o, port: 0, host: "127.0.0.1", log: () => {} });
    try {
      const hdr = { headers: { connection: "close" } };   // keep-alive 소켓을 남기지 않는다(끝낼 때 윈도 libuv 단언 방지)
      const txt = await (await fetch(`http://127.0.0.1:${port}/env.js`, hdr)).text();
      const env = JSON.parse(/window\.AZT_ENV\s*=\s*(\{[\s\S]*?\});/.exec(txt)[1]);
      if (env.writes !== false) probs.push("server.mjs 기본 실행의 /env.js 가 writes:false 가 아닙니다");
      if (env.sw !== false) probs.push("server.mjs /env.js 의 sw 가 false 가 아닙니다");
      /* [2026-09-29] 로컬 기본 실행은 운영 Firebase 에 접속하지 않는다(offline — local_firebase.js 대역, 곡은 /api/local-catalog) */
      if (env.offline !== true) probs.push("server.mjs 기본 실행의 /env.js 가 offline:true 가 아닙니다(운영 Firebase 에 로그인)");
      const dot = await fetch(`http://127.0.0.1:${port}/.env`, hdr);
      await dot.arrayBuffer();
      if (dot.status !== 404) probs.push(`/.env 요청이 ${dot.status}`);
    } finally { await close(); }
  } catch (e) { probs.push(`server.mjs 확인 실패: ${e.message}`); }
  /* 대역은 Firebase SDK 뒤·앱 스크립트 앞에서 불려야 window.firebase 를 바꿀 수 있다 */
  const lf = /<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/|\/)?local_firebase\.js(?:\?[^"']*)?["'][^>]*>/i.exec(html);
  const sdk = /firebase-firestore-compat\.js/.exec(html);
  const appBlk = inlineScripts(html).find((b) => /function\s+loadEngine|AZT_ENV/.test(b.src));
  if (!lf || !exists("local_firebase.js")) probs.push("index.html 이 local_firebase.js(로컬 대역)를 부르지 않습니다");
  else if ((sdk && lf.index < sdk.index) || (appBlk && lf.index > appBlk.offset)) probs.push("local_firebase.js 는 Firebase SDK 뒤, 앱 스크립트 앞이어야 합니다");
  const gi = exists(".gitignore") ? read(".gitignore").split(/\r?\n/).map((l) => l.trim()) : [];
  if (!gi.includes(".env*") && !gi.includes(".env")) probs.push(".gitignore 에 .env* 가 없습니다");
  add("env", probs.length ? "fail" : notes.length ? "warn" : "ok",
      probs.length ? probs.join(" · ") + (notes.length ? ` · 참고: ${notes.join(" · ")}` : "")
                   : `env.js 먼저 로드 · 정적 env.js 쓰기는 배포 루트에서만(로컬·/web2/ 하위 경로 끔) · 로컬 서버 기본 writes:false · offline:true(대역 local_firebase.js) · /.env 404 · .gitignore .env*${notes.length ? ` · 참고: ${notes.join(" · ")}` : ""}`);
}

function checkNoDeps() {
  const probs = [];
  if (exists("package.json")) probs.push("package.json 이 있습니다(명세: Node 내장 모듈만)");
  const files = ["server.mjs",
    ...(exists("tools/sim") ? fs.readdirSync(path.join(ROOT, "tools/sim")).filter((f) => /\.m?js$/.test(f)).map((f) => `tools/sim/${f}`) : []),
    ...fs.readdirSync(path.join(ROOT, "engine")).filter((f) => /\.m?js$/.test(f)).map((f) => `engine/${f}`)].filter(exists);
  const builtins = new Set(builtinModules);
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/(?:^|[;\s])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm)) {
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../")) continue;
      if (builtins.has(spec) && !f.startsWith("engine/")) continue;
      probs.push(`${f}: "${spec}"`);
    }
    if (f.startsWith("engine/") && /from\s*["']node:/.test(src)) probs.push(`${f}: 엔진이 node: 모듈을 import (브라우저에서도 돌아야 함)`);
  }
  add("no-deps", probs.length ? "fail" : "ok", probs.length ? probs.join(" · ") : `package.json 없음 · ${files.length}개 파일이 내장·상대 경로만 import`);
}

async function checkContract(file, dataRepo) {
  const { loadCatalog, contractOnly, CONTRACT_FIELDS } = await import("./catalog.mjs");
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const app = Array.isArray(raw) ? raw : raw.songs || raw.contract || Object.values(raw);
  const { index } = loadCatalog({ dataRepo, quiet: true });
  const diffs = [];
  let n = 0;
  for (const a of app) {
    const t = index.byId.get(a.song_id);
    if (!t) { diffs.push(`${a.song_id}: 도구 카탈로그에 없음`); continue; }
    n++;
    const c = contractOnly(t);
    for (const k of CONTRACT_FIELDS) {
      const x = a[k], y = c[k];
      const same = typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 1e-9 : JSON.stringify(x) === JSON.stringify(y);
      if (!same) diffs.push(`${a.song_id}.${k}: 앱 ${JSON.stringify(x)} / 도구 ${JSON.stringify(y)}`);
    }
    for (const k of ["feature_bins", "feature_bins_p"]) if (a[k] && JSON.stringify(a[k]) !== JSON.stringify(t[k])) diffs.push(`${a.song_id}.${k}: 앱 ${JSON.stringify(a[k])} / 도구 ${JSON.stringify(t[k])}`);
  }
  add("contract", diffs.length ? "fail" : "ok", diffs.length ? `${diffs.length}건 다름: ${diffs.slice(0, 12).join(" · ")}${diffs.length > 12 ? " …" : ""}` : `${n}곡 모든 계약 필드 같음`);
}

// ── 실행 ────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const quick = argv.includes("--quick");
  const dataRepo = opt("--data-repo") || null;   // 없으면 catalog.mjs 가 data_repo.mjs 순서로 찾는다(AZT_DATA_REPO → ../eumchichi-data → ../../eumchichi-data)
  let rules = null;
  try { rules = JSON.parse(read("rules/rules.compiled.json")); } catch (e) { add("rules", "fail", `rules.compiled.json 읽기 실패: ${e.message}`); }
  checkDeterminism();
  checkRulesHash();
  if (rules) { checkPersonalization(rules); await checkTraceKeys(rules, { quick, dataRepo }); }
  checkFsWrites();
  checkCollections();
  checkBaselineCopies();
  checkSongStats();
  checkAppNumbers();
  checkSw();
  await checkEnv();
  checkNoDeps();
  if (opt("--app-contract")) await checkContract(opt("--app-contract"), dataRepo);
  const mark = { ok: "✓", fail: "✗", warn: "⚠", skip: "–" };
  for (const r of results) console.log(`${mark[r.status]} ${r.id.padEnd(16)} ${r.detail}`);
  const nFail = results.filter((r) => r.status === "fail").length;
  console.log(nFail ? `\n✗ ${nFail}개 실패 — 병합 전 고칠 것` : "\n✓ 모두 통과");
  process.exitCode = nFail ? 1 : 0;   // process.exit() 은 닫히는 중인 소켓과 겹치면 윈도에서 libuv 단언으로 죽는다 — 자연 종료를 기다린다
}
