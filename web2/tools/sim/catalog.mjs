/*
 * 카탈로그 로더 (TOOLS · 명세 §9.3 · §6.2) — 시뮬레이터·회귀·재현 도구가 같이 쓴다.
 *
 * 데이터 저장소(eumchichi-data)의 카탈로그 CSV 두 개를 `git show <ref>:<path>` 로 **메모리에만** 읽어
 * 앱 toContractSong(index.html)과 같은 계약 모양(ContractSong)으로 바꾼다. 캐시 파일을 남기지 않는다.
 * 데이터 저장소의 작업 트리는 일부러 낡아 있으므로 파일을 직접 열지 않는다(항상 git show).
 *
 *   필드 규칙    eumchichi-data `scripts/analysis/azt_app.mjs` 의 loadCatalog 와 같다
 *               (V/A 는 0~1 로 자름 · 말 비중 모르면 0.5 · 길이 모르면 210초 · 빠르기 태그 없으면 null · 좌표 없는 곡은 뺀다)
 *   연주곡      앱 songIsInstrumental 과 같은 순서 — data/instrumental_overrides.json 에 있으면 그 값,
 *               없으면 v2_tag_instrumental ≥ 0.5 (Firestore 정식 칸 is_instrumental 은 CSV 에 없다)
 *   장르        앱 index.html 의 GENRE_RULES / GENRE_RULE_EXCLUDE 를 app_tables.mjs 로 앵커 추출해 같은 판정
 *   CatalogIndex §6.2 — { n, digest, byId(특징 묶음 포함), coords(엔진 workingCoords — 없으면 prepare 와 같은 ecdf) }
 *
 * 사용:
 *   import { loadCatalog } from "./tools/sim/catalog.mjs";
 *   const { songs, index, digest } = loadCatalog();                 // 동기 함수 (엔진은 모듈을 읽을 때 한 번 import)
 *   node tools/sim/catalog.mjs [--data-repo <경로>] [--ref origin/master]   → 곡 수·digest·연주곡 수 요약
 *
 * 데이터 저장소 경로 (data_repo.mjs): 인자 dataRepo(--data-repo) → 환경변수 AZT_DATA_REPO →
 *   <web2>/../eumchichi-data → <web2>/../../eumchichi-data 가운데 처음 있는 것. 못 찾으면 AZT_DATA_REPO 를 알려 주며 멈춘다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAppTables } from "./app_tables.mjs";
import { resolveDataRepo } from "./data_repo.mjs";

export { resolveDataRepo, findDataRepo, dataRepoCandidates } from "./data_repo.mjs";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CATALOG_FILES = {
  v2: "data/processed/music_catalog_v2_20260920.csv",   // 좌표·태그 (2026-09-20 4,117곡판)
  base: "data/processed/music_catalog.csv",             // 장르·인기도·길이
};
export const EXPECTED_N = 4117;   // 2026-09-20 카탈로그 곡 수 — 다르면 경고만 (데이터가 늘었을 수 있다)

// ── git · 파일 ───────────────────────────────────────────
export function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
export function gitShow(repo, ref, relPath) {
  try { return git(repo, "show", `${ref}:${relPath}`); }
  catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || e).trim().split("\n")[0];
    throw new Error(`git show 실패 — ${repo} ${ref}:${relPath} (${msg})`);
  }
}
export function revParse(repo, ref) {
  try { return git(repo, "rev-parse", ref).trim(); } catch (e) { return null; }
}

/* 따옴표·줄바꿈을 처리하는 CSV 파서 (azt_app.mjs parseCsv 와 같은 규칙: 열 수가 머리와 다른 줄은 버린다) */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^﻿/, ""));
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// ── 엔진 (모듈을 읽을 때 한 번) ──────────────────────────
/* 엔진 빌더가 engine.js 를 고치는 중이라 import 가 실패할 수 있다 — 그때는 로더 자체는 살아 있고
   특징 묶음·작업 좌표만 이 파일의 같은 식으로 계산한다(경고 1회). 호출자가 engine 을 넘기면 그것을 쓴다. */
let ENGINE = null, ENGINE_ERR = null;
try { ENGINE = await import(pathToFileURL(path.join(ROOT, "engine", "engine.js")).href); }
catch (e) { ENGINE_ERR = e; }

const TE = new TextEncoder();
/* engine.js fnv1a32 와 같은 식 (엔진이 export 하면 그것을 쓴다) */
function fnv1a32Local(text) {
  let h = 2166136261;
  for (const b of TE.encode(text)) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export const fnvHex = (text, eng = ENGINE) => ((eng && typeof eng.fnv1a32 === "function" ? eng.fnv1a32 : fnv1a32Local)(String(text)) >>> 0).toString(16).padStart(8, "0");

/* §6.2 카탈로그 digest — 곡마다 'song_id:V:A'(원좌표, JS 기본 숫자 표기)를 만들어 정렬하고 줄바꿈으로 이은 뒤 fnv1a32, 8자리 hex.
   앱(contractWithBins 로 만든 계약 곡)도 같은 식을 써야 replay.mjs 가 로그의 catalog_digest 와 맞춰 볼 수 있다. */
export function catalogDigest(songs, eng = ENGINE) {
  return fnvHex(songs.map((s) => `${s.song_id}:${s.V}:${s.A}`).sort().join("\n"), eng);
}

/* 엔진 prepare() 의 ecdf 와 같은 식 — engine.workingCoords 가 없을 때만 쓴다 */
function ecdfSorted(sorted, x) {
  const n = sorted.length;
  if (!n) return 0.5;
  let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
  let l2 = lo, h2 = n; while (l2 < h2) { const m = (l2 + h2) >> 1; if (sorted[m] <= x) l2 = m + 1; else h2 = m; }
  return (lo + (l2 - lo) / 2) / n;
}
export function workingCoordsLocal(catalog, rules) {
  const sv = catalog.map((s) => Number(s.V)).sort((a, b) => a - b);
  const sa = catalog.map((s) => Number(s.A)).sort((a, b) => a - b);
  const pct = rules && rules.coordinate_space === "percentile";
  const out = new Map();
  for (const s of catalog) { const v = Number(s.V), a = Number(s.A); out.set(s.song_id, pct ? [ecdfSorted(sv, v), ecdfSorted(sa, a)] : [v, a]); }
  return out;
}

export function readRules(file = path.join(ROOT, "rules", "rules.compiled.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function readOverrides(overrides) {
  if (!overrides) return {};
  if (typeof overrides === "object") return overrides.overrides || overrides;
  const f = path.isAbsolute(overrides) ? overrides : path.join(ROOT, overrides);
  return JSON.parse(fs.readFileSync(f, "utf8")).overrides || {};
}
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn(msg); } };

/**
 * @param {object} [o]
 * @param {string} [o.dataRepo]   데이터 저장소 경로 (없으면 data_repo.mjs 순서: AZT_DATA_REPO → ../eumchichi-data → ../../eumchichi-data)
 * @param {string} [o.ref]        데이터 저장소 ref (기본 origin/master)
 * @param {string|object|null} [o.overrides]  연주곡 판정 뒤집기 목록 (기본 이 저장소 data/instrumental_overrides.json)
 * @param {object} [o.rules]      특징 묶음·작업 좌표에 쓸 규칙 (기본 이 저장소 rules/rules.compiled.json)
 * @param {object} [o.engine]     makeFeatureBinner·workingCoords·makeExtraBinner 를 가진 엔진 모듈 (기본 engine/engine.js)
 * @param {object} [o.tables]     loadAppTables() 결과 (기본 이 저장소 index.html 에서 추출)
 * @returns {{ songs: object[], index: { n, digest, byId: Map, coords: Map }, digest: string, source: object }}
 */
export function loadCatalog({
  dataRepo = null, ref = "origin/master", overrides = "data/instrumental_overrides.json",
  rules = null, engine = null, tables = null, files = CATALOG_FILES, expectN = EXPECTED_N, quiet = false,
} = {}) {
  dataRepo = resolveDataRepo(dataRepo);
  const eng = engine || ENGINE;
  if (!eng && ENGINE_ERR) warnOnce("engine", `[catalog] engine/engine.js import 실패 — 특징 묶음은 비우고 작업 좌표는 같은 식으로 계산합니다 (${ENGINE_ERR.message})`);
  const R = rules || readRules();
  const T = tables || loadAppTables();
  const OV = readOverrides(overrides);

  const nfc = (s) => String(s ?? "").normalize("NFC");
  const num = (x) => (x === "" || x == null || Number.isNaN(Number(x)) ? null : Number(x));
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const base = new Map(parseCsv(gitShow(dataRepo, ref, files.base)).map((x) => [x.song_id, x]));
  const songs = [];
  let skipped = 0, overridden = 0;
  for (const x of parseCsv(gitShow(dataRepo, ref, files.v2))) {
    const b = base.get(x.song_id) || {};
    const V = num(x.v2_valence), A = num(x.v2_arousal);
    if (V === null || A === null) { skipped++; continue; }
    const tempo = num(x.v2_tag_tempo), instr = num(x.v2_tag_instrumental), spoken = num(x.v2_tag_spokenness);
    let instrumental;
    if (Object.prototype.hasOwnProperty.call(OV, x.song_id)) { instrumental = !!OV[x.song_id]; overridden++; }   // 앱과 같은 우선순위
    else instrumental = instr !== null && instr >= 0.5;
    const genresRaw = [...new Set(nfc(b.genre).split(/[,;|]/).map((g) => g.trim()).filter(Boolean))];
    songs.push({
      song_id: x.song_id, title: nfc(x.title), artist: nfc(x.artist),
      V: clamp01(V), A: clamp01(A), va_source: x.v2_valence_source || "provider",
      spokenness: spoken ?? 0.5, instrumental,
      genres: T.toGenreLabels(genresRaw),
      popularity: num(b.popularity) ?? 0, duration_ms: num(b.duration_ms) ?? 210000,
      tempo: tempo === null ? null : clamp01(tempo),
    });
  }
  if (songs.length !== expectN && !quiet) console.warn(`[catalog] 곡 수 ${songs.length} ≠ ${expectN} — 카탈로그가 바뀌었는지 확인하세요 (${ref}:${files.v2})`);

  /* 특징 묶음 — 반드시 전체 카탈로그로 만든다(엔진 makeFeatureBinner 주석 참고) */
  let bin = null, binP = null;
  if (eng && typeof eng.makeFeatureBinner === "function") bin = eng.makeFeatureBinner(songs, R);
  else warnOnce("binner", "[catalog] 엔진에 makeFeatureBinner 가 없어 feature_bins 를 비워 둡니다");
  /* 개인 전용 추가 특징(§4.7.5) — 켤 수 있는 목록(extra_features_available)을 모두 묶어 둔다. 엔진은 정책의 taste_features 에 있는 것만 읽는다 */
  const taste = (R.personalization && R.personalization.taste) || {};
  const extraSpecs = [...(taste.extra_features_available || []), ...(taste.extra_features || [])]
    .filter((f, i, a) => f && a.findIndex((g) => g && g.id === f.id) === i);
  if (extraSpecs.length) {
    if (eng && typeof eng.makeExtraBinner === "function") binP = eng.makeExtraBinner(songs, extraSpecs);
    else warnOnce("extra", "[catalog] 엔진에 makeExtraBinner 가 아직 없어 feature_bins_p 를 비워 둡니다");
  }
  for (const s of songs) { s.feature_bins = bin ? bin(s) : {}; s.feature_bins_p = binP ? binP(s) : {}; }

  const coords = eng && typeof eng.workingCoords === "function" ? eng.workingCoords(songs, R) : workingCoordsLocal(songs, R);
  const digest = catalogDigest(songs, eng);
  const index = { n: songs.length, digest, byId: new Map(songs.map((s) => [s.song_id, s])), coords };
  return {
    songs, index, digest,
    source: { dataRepo, ref, sha: revParse(dataRepo, ref), files, n_skipped: skipped, n_overrides: overridden,
              engine_version: eng ? eng.ENGINE_VERSION ?? null : null, rules_version: R.rules_version, coords_from: eng && eng.workingCoords ? "engine.workingCoords" : "local-ecdf" },
  };
}

/* ContractSong 필드만 남긴 사본 — check.mjs 가 앱 AZT_DEBUG.dumpContract 결과와 비교할 때 쓴다 */
export const CONTRACT_FIELDS = ["song_id", "title", "artist", "V", "A", "va_source", "spokenness", "instrumental", "genres", "popularity", "duration_ms", "tempo"];
export const contractOnly = (s) => Object.fromEntries(CONTRACT_FIELDS.map((k) => [k, s[k]]));

// ── CLI: 요약만 ──────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const t0 = performance.now();
  let cat;
  try { cat = loadCatalog({ dataRepo: opt("--data-repo", null), ref: opt("--ref", "origin/master") }); }
  catch (e) { console.error(e.message); process.exit(2); }
  const { songs, index, source } = cat;
  const inst = songs.filter((s) => s.instrumental).length, noGenre = songs.filter((s) => !s.genres.length).length;
  console.log(`카탈로그 ${index.n}곡 · digest ${index.digest} · 연주곡 ${inst} (overrides ${source.n_overrides}) · 장르 없음 ${noGenre} · 좌표 없음 제외 ${source.n_skipped}`);
  console.log(`데이터 ${source.dataRepo} ${source.ref} (${(source.sha || "?").slice(0, 7)}) · 엔진 ${source.engine_version} · 규칙 ${source.rules_version} · 작업 좌표 ${source.coords_from} · ${(performance.now() - t0).toFixed(0)}ms`);
}
