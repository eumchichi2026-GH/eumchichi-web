/*
 * web-personal 로컬 개발 서버 (TOOLS · 명세 §9.3) — Node 내장 모듈만, package.json 없음.
 *
 *   node server.mjs [--port 5180] [--host localhost] [--firebase] [--writes] [--env .env] [--debug]
 *
 * 무엇을 하나
 *   - localhost 에만 묶는다(Firebase 인증 승인 도메인 기본값). 포트 5180 은 fix-web 과 달라 서비스워커·캐시를 공유하지 않는다.
 *   - GET /env.js     → window.AZT_ENV = { app:"web-personal", env:"local", writes, sw:false, personal:true, debug, offline }
 *                       **writes 는 기본 false** — 로컬 실행은 운영 Firestore 에 쓰지 않는다(§7.5). --writes 를 줄 때만 true.
 *                       **offline 은 기본 true** (2026-09-29, §11 H2·I) — 앱이 운영 Firebase 대신 local_firebase.js 대역을 쓴다:
 *                       로그인(익명 포함)·Firestore 읽기·쓰기가 없고, 곡 목록은 아래 /api/local-catalog 에서 받는다.
 *                       --firebase 를 주면 offline:false — 예전처럼 운영 Firebase 에 로그인해 곡을 읽는다(쓰기는 여전히 --writes 때만).
 *                       저장소의 정적 env.js(APP, 배포용 prod 값)보다 이 응답이 먼저다.
 *   - GET /api/local-catalog → { n, digest, source, songs: [계약 곡] } — 데이터 저장소(../eumchichi-data 또는 AZT_DATA_REPO)를
 *                       tools/sim/catalog.mjs 로 `git show origin/master:<csv>` 해 읽은 계약 곡(시뮬레이터·회귀와 같은 값). 파일을 남기지 않고
 *                       서버 메모리에 한 번 만들어 둔다(?refresh=1 이면 다시 읽음).
 *   - /api/<name>     → api/<name>.js 의 Vercel 핸들러를 그대로 부른다(gemini·soundiiz). 요청·응답 모양만 흉내 낸다
 *                       (본문 최대 1MB → 넘으면 413 · application/json 은 파싱 · 빈 본문 {} · 잘못된 JSON 400 · 예외 500 · 없는 API 404)
 *   - GET /api/health → { ok, app:"web-personal", engine_version, rules_hash, personal_version }
 *   - 정적 파일        → 쿼리 제거 · decodeURIComponent · 저장소 루트 안만 · 점 파일(.env·.git)과 .. 거부(404) · / → index.html
 *                       SPA 폴백 없음 · Cache-Control: no-store · HEAD 지원
 *
 * .env (손 파싱: KEY=VALUE, # 주석, 이미 있는 환경변수는 덮지 않음) — 찾는 순서
 *   ① --env <경로>  ② 이 저장소의 .env  ③ 그래도 GEMINI_API_KEY 가 없으면 데이터 저장소(../eumchichi-data 또는 AZT_DATA_REPO)의
 *   .env 에서 **그 키 하나만** 실행 중 메모리로 읽는다(파일로 복사하지 않는다). 키 값은 어디에도 출력하지 않는다.
 *   .env* 는 .gitignore 에 있다(공개 저장소).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { port: 5180, host: "localhost", writes: false, env: null, debug: false, firebase: false };
const BODY_MAX = 1024 * 1024;   // 1MB — Vercel 서버리스 함수 기본 본문 한도(4.5MB)보다 작게, 로컬에서 실수로 큰 본문을 막는 값
const API_TIMEOUT_MS = 60_000;  // 핸들러가 응답을 끝내지 않을 때 기다리는 최대 시간

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
};

// ── 인자 ────────────────────────────────────────────────
export function parseServerArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--writes") o.writes = true;
    else if (a === "--firebase") o.firebase = true;
    else if (a === "--debug") o.debug = true;
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--host") o.host = String(argv[++i]);
    else if (a === "--env") o.env = String(argv[++i]);
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`모르는 인자: ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error(`포트가 올바르지 않습니다: ${o.port}`);
  return o;
}

// ── .env ────────────────────────────────────────────────
/* KEY=VALUE 한 줄씩. `export ` 접두어·따옴표·따옴표 없는 값 뒤의 ` # 주석` 을 처리한다 */
export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

/* 찾는 순서대로 적용하고, 이미 있는 환경변수는 덮지 않는다. 돌려주는 것은 출처(파일 경로)뿐 — 값은 돌려주지 않는다 */
export function loadEnvFiles({ envPath = null, root = ROOT, dataRepo = process.env.AZT_DATA_REPO || path.resolve(root, "..", "eumchichi-data"), target = process.env } = {}) {
  const loaded = [], notes = [];
  let geminiFrom = target.GEMINI_API_KEY ? "환경변수" : null;
  const apply = (file, onlyKeys = null) => {
    const kv = parseDotenv(fs.readFileSync(file, "utf8"));
    let n = 0;
    for (const [k, v] of Object.entries(kv)) {
      if (onlyKeys && !onlyKeys.includes(k)) continue;
      if (target[k] !== undefined) continue;
      target[k] = v; n++;
      if (k === "GEMINI_API_KEY" && v) geminiFrom = file;
    }
    loaded.push({ file, keys: n });
  };
  if (envPath) {
    const f = path.resolve(envPath);
    if (fs.existsSync(f)) apply(f); else notes.push(`--env 파일이 없습니다: ${f}`);
  }
  const repoEnv = path.join(root, ".env");
  if (fs.existsSync(repoEnv) && !(envPath && path.resolve(envPath) === repoEnv)) apply(repoEnv);
  if (!target.GEMINI_API_KEY) {
    const dataEnv = path.join(dataRepo, ".env");
    if (fs.existsSync(dataEnv)) apply(dataEnv, ["GEMINI_API_KEY"]);   // 이 키 하나만, 메모리로만
  }
  return { loaded, notes, gemini: target.GEMINI_API_KEY ? geminiFrom : null };
}

// ── /env.js ─────────────────────────────────────────────
export function envObject(o = DEFAULTS) {
  return { app: "web-personal", env: "local", writes: !!o.writes, sw: false, personal: true, debug: !!o.debug, offline: !o.firebase };
}
export const envScript = (o = DEFAULTS) =>
  `/* server.mjs 가 만든 로컬 설정 — 저장소의 env.js(배포용)보다 먼저 응답한다 */\nwindow.AZT_ENV = ${JSON.stringify(envObject(o))};\n`;

// ── 공통 응답 ────────────────────────────────────────────
function baseHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}
function sendJson(res, status, obj, head = false) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(head ? undefined : body);
}
function sendText(res, status, text, type = "text/plain; charset=utf-8", head = false) {
  const body = Buffer.from(text);
  res.writeHead(status, { "Content-Type": type, "Content-Length": body.length });
  res.end(head ? undefined : body);
}

// ── /api/health ─────────────────────────────────────────
/* 파일 수정 시각을 주소에 붙여 import — 엔진을 고치면 서버를 다시 켜지 않아도 새 값이 나온다 */
async function importFresh(file) {
  const st = fs.statSync(file);
  return import(pathToFileURL(file).href + "?t=" + st.mtimeMs);
}
async function health(root) {
  const out = { ok: true, app: "web-personal", engine_version: null, rules_hash: null, personal_version: null };
  try { out.engine_version = (await importFresh(path.join(root, "engine", "engine.js"))).ENGINE_VERSION ?? null; }
  catch (e) { out.ok = false; out.engine_error = String(e && e.message || e); }
  try { const r = JSON.parse(fs.readFileSync(path.join(root, "rules", "rules.compiled.json"), "utf8")); out.rules_hash = r.rules_hash ?? null; out.rules_version = r.rules_version ?? null; }
  catch (e) { out.ok = false; out.rules_error = String(e && e.message || e); }
  const pf = path.join(root, "engine", "personal.js");
  if (fs.existsSync(pf)) {
    try { out.personal_version = (await importFresh(pf)).PERSONAL_VERSION ?? null; }
    catch (e) { out.ok = false; out.personal_error = String(e && e.message || e); }
  }
  return out;
}

// ── /api/local-catalog — 로컬 기본 실행(offline)의 곡 목록 ──────────
/* tools/sim/catalog.mjs 의 loadCatalog(데이터 저장소 git show, 읽기 전용)를 그대로 쓴다 — 시뮬레이터·회귀·픽스처와 같은 계약 곡.
   한 번 만든 결과는 이 서버 프로세스 메모리에만 둔다(파일 캐시 없음). */
let LOCAL_CATALOG = null;
async function localCatalog(root, refresh = false) {
  if (LOCAL_CATALOG && !refresh) return LOCAL_CATALOG;
  const mod = await import(pathToFileURL(path.join(root, "tools", "sim", "catalog.mjs")).href);
  const { songs, digest, source } = mod.loadCatalog({ quiet: true });
  LOCAL_CATALOG = { n: songs.length, digest, source: { ref: source.ref, sha: source.sha, files: source.files, n_overrides: source.n_overrides },
                    songs: songs.map(mod.contractOnly) };
  return LOCAL_CATALOG;
}

// ── /api/:name — Vercel 핸들러 흉내 ─────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > BODY_MAX) { over = true; chunks.length = 0; resolve({ over: true }); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve({ buf: Buffer.concat(chunks) }); });
    req.on("error", () => { if (!over) resolve({ buf: Buffer.alloc(0) }); });
  });
}
function parseQuery(sp) {
  const q = {};
  for (const [k, v] of sp) q[k] = k in q ? [].concat(q[k], v) : v;
  return q;
}
function decorateRes(res) {
  res.status = (n) => { res.statusCode = Number(n); return res; };
  res.json = (o) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(o));
    return res;
  };
  res.send = (b) => {
    if (b === undefined || b === null) { res.end(); return res; }
    if (Buffer.isBuffer(b)) { if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/octet-stream"); res.end(b); return res; }
    if (typeof b === "object") return res.json(b);
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(String(b));
    return res;
  };
  return res;
}
async function handleApi(req, res, name, url, root, log) {
  const file = path.join(root, "api", `${name}.js`);
  if (!fs.existsSync(file)) return sendJson(res, 404, { error: `api/${name}.js 가 없습니다` });
  const body = await readBody(req);
  if (body.over) {
    /* 남은 본문은 readBody 가 버리며 읽고, Connection: close 라 응답이 끝나면 연결을 닫는다 */
    res.setHeader("Connection", "close");
    return sendJson(res, 413, { error: "본문이 1MB 를 넘습니다" });
  }
  const text = body.buf.toString("utf8");
  const ctype = String(req.headers["content-type"] || "").toLowerCase();
  let parsed;
  if (!text.trim()) parsed = {};
  else if (ctype.includes("application/json")) {
    try { parsed = JSON.parse(text); } catch (e) { return sendJson(res, 400, { error: "잘못된 JSON 본문" }); }
  } else if (ctype.includes("application/x-www-form-urlencoded")) parsed = parseQuery(new URLSearchParams(text));
  else parsed = text;
  req.query = parseQuery(url.searchParams);
  req.body = parsed;
  req.cookies = {};
  decorateRes(res);
  let mod;
  try { mod = await importFresh(file); }
  catch (e) { log(`api/${name}.js 불러오기 실패: ${e.message}`); return sendJson(res, 500, { error: "handler load error", detail: String(e.message) }); }
  const handler = mod.default;
  if (typeof handler !== "function") return sendJson(res, 500, { error: `api/${name}.js 에 default export 함수가 없습니다` });
  try {
    await handler(req, res);
  } catch (e) {
    log(`api/${name} 예외: ${e && e.message}`);
    if (!res.headersSent) return sendJson(res, 500, { error: "handler error", detail: String(e && e.message || e) });
    if (!res.writableEnded) res.end();
    return;
  }
  /* 핸들러가 promise 를 돌려주지 않고 나중에 끝내는 경우 — 끝날 때까지(최대 60초) 기다린다 */
  if (!res.writableEnded) {
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!res.headersSent) sendJson(res, 504, { error: "handler 가 응답을 끝내지 않았습니다" });
        else if (!res.writableEnded) res.end();
        resolve();
      }, API_TIMEOUT_MS);
      res.once("close", () => { clearTimeout(t); resolve(); });
      res.once("finish", () => { clearTimeout(t); resolve(); });
    });
  }
}

// ── 정적 파일 ────────────────────────────────────────────
const WIN_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/* 요청 경로 → 저장소 안의 파일 경로. 거부해야 하면 null (404). 쿼리는 호출자가 이미 뗐다 */
export function resolveStatic(root, rawPath) {
  let p;
  try { p = decodeURIComponent(rawPath); } catch (e) { return { status: 400 }; }
  if (!p.startsWith("/") || p.includes("\0") || p.includes("\\")) return null;
  const segs = p.split("/").slice(1);
  for (const s of segs) {
    if (s === "") continue;
    if (s.startsWith(".")) return null;                 // 점 파일(.env·.git·.claude)과 . · ..
    if (s.includes(":") || WIN_DEVICE.test(s)) return null;   // 윈도 대체 데이터 스트림·장치 이름
  }
  if (p === "/") p = "/index.html";
  else if (p.endsWith("/")) p += "index.html";
  const file = path.resolve(root, "." + p);
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  if (!st.isFile()) return null;                        // 폴더 목록·SPA 폴백 없음
  try {                                                  // 링크가 저장소 밖을 가리키면 거부
    const real = fs.realpathSync(file), realRoot = fs.realpathSync(root);
    const r2 = path.relative(realRoot, real);
    if (r2.startsWith("..") || path.isAbsolute(r2)) return null;
  } catch (e) { return null; }
  return { file, size: st.size };
}
function serveStatic(req, res, pathname, root, head) {
  const r = resolveStatic(root, pathname);
  if (r && r.status === 400) return sendText(res, 400, "잘못된 경로", undefined, head);
  if (!r) return sendText(res, 404, "Not Found", undefined, head);
  const type = MIME[path.extname(r.file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Content-Length": r.size });
  if (head) return res.end();
  fs.createReadStream(r.file).on("error", () => res.destroy()).pipe(res);
}

// ── 서버 ────────────────────────────────────────────────
export function createAppServer(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const root = o.root || ROOT;
  const log = o.log || ((m) => console.log(`[server] ${m}`));
  return http.createServer(async (req, res) => {
    const t0 = performance.now();
    baseHeaders(res);
    let url;
    try { url = new URL(req.url || "/", "http://localhost"); } catch (e) { return sendText(res, 400, "잘못된 요청"); }
    const pathname = url.pathname;
    const method = req.method || "GET";
    const head = method === "HEAD";
    res.on("finish", () => {
      if (o.debug || pathname.startsWith("/api/") || res.statusCode >= 500)
        log(`${method} ${pathname} ${res.statusCode} ${(performance.now() - t0).toFixed(0)}ms`);
    });
    try {
      if (pathname === "/api/health") {
        if (method !== "GET" && !head) { res.setHeader("Allow", "GET, HEAD"); return sendJson(res, 405, { error: "GET only" }); }
        return sendJson(res, 200, await health(root), head);
      }
      if (pathname === "/api/local-catalog") {
        if (method !== "GET" && !head) { res.setHeader("Allow", "GET, HEAD"); return sendJson(res, 405, { error: "GET only" }); }
        try { return sendJson(res, 200, await localCatalog(root, url.searchParams.get("refresh") === "1"), head); }
        catch (e) { log(`로컬 카탈로그 실패: ${e && e.message}`); return sendJson(res, 500, { error: "local catalog error", detail: String(e && e.message || e) }, head); }
      }
      const m = /^\/api\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
      if (m) return await handleApi(req, res, m[1], url, root, log);
      if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "없는 API" });
      if (method !== "GET" && !head) { res.setHeader("Allow", "GET, HEAD"); return sendText(res, 405, "Method Not Allowed"); }
      if (pathname === "/env.js") return sendText(res, 200, envScript(o), MIME[".js"], head);
      return serveStatic(req, res, pathname, root, head);
    } catch (e) {
      log(`처리 중 오류 ${pathname}: ${e && e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "server error" });
      else if (!res.writableEnded) res.end();
    }
  });
}

export function startServer(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const server = createAppServer(o);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      server.off("error", reject);
      const port = server.address().port;
      resolve({ server, port, url: `http://${o.host}:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// ── CLI ─────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  let o;
  try { o = parseServerArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) {
    console.log("node server.mjs [--port 5180] [--host localhost] [--firebase] [--writes] [--env .env] [--debug]");
    console.log("  기본: 운영 Firebase 에 접속하지 않음(offline — 곡은 데이터 저장소에서, 로그인·쓰기 없음). --firebase: 운영 Firebase 로 로그인·곡 읽기");
    process.exit(0);
  }
  const env = loadEnvFiles({ envPath: o.env });
  for (const n of env.notes) console.warn(`[server] ${n}`);
  try {
    const { url, close } = await startServer(o);
    console.log(`[server] web-personal → ${url}`);
    console.log(`[server] Firebase: ${o.firebase ? "운영 프로젝트에 로그인·곡 읽기 (--firebase)" : "접속 안 함 (로컬 기본 offline — local_firebase.js 대역, 곡은 /api/local-catalog)"}`);
    console.log(`[server] Firestore 쓰기: ${o.writes ? "켜짐 (--writes) — 운영 Firestore 에 기록됩니다" : "꺼짐 (로컬 기본 — console.info·SESSION_LOG 에만)"} · 디버그 ${o.debug ? "켜짐" : "꺼짐"}`);
    console.log(`[server] GEMINI_API_KEY: ${env.gemini ? `있음 (출처: ${env.gemini === "환경변수" ? env.gemini : path.relative(ROOT, env.gemini) || env.gemini})` : "없음 — /api/gemini 는 500 을 돌려줍니다"}`);
    const stop = () => { close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (e) {
    console.error(e.code === "EADDRINUSE" ? `[server] 포트 ${o.port} 를 이미 쓰고 있습니다 — --port 로 다른 포트를 주세요` : `[server] 시작 실패: ${e.message}`);
    process.exit(1);
  }
}
