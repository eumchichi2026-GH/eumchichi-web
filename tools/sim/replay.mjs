/*
 * 추천 로그 재현 (TOOLS · 명세 §9.3 · §11 H3) — 로그에 남긴 정책·취향 표·입력만으로 같은 시퀀스가 다시 나오는가.
 *
 *   node tools/sim/replay.mjs --recs <추천 문서 JSON> [--catalog-ref origin/master] [--data-repo <경로>]
 *        [--profile <users 문서 JSON>] [--json <결과 JSON 경로>] [--limit N] [--ignore-digest] [--ignore-versions] [--verbose] [--no-fail]
 *
 * 입력 JSON 모양(아무거나): 추천 문서 배열 · { recommendations:[…] } · RawFacts(wp-raw/1, session_log 포함) · [{ id, data:{…} }]
 *   RawFacts 에 events 가 있으면 추천 시각 기준의 싫어요 목록을 이벤트(like/dislike 의 on)로 다시 만든다.
 *   없으면 --profile 의 dislikedSongs(지금 상태)를 쓴다 — 로그에 싫어요 목록이 없어서다(§7.1). 그 차이로 어긋나면 이유에 적는다.
 *
 * 다시 만드는 엔진 입력 (index.html recommend() 와 같은 순서)
 *   풀      카탈로그 → prefer_vocal 이면 연주곡 제외 → filters.genre_applied 면 고른 장르 곡만 (퍼센타일 좌표가 풀에서 나오므로 풀까지 같아야 한다)
 *   조건    effective.{lyric, genres, minutes}(없으면 옛 필드) · relaxed(lyric/genre/both)면 그 조건을 푼 입력
 *   좌표    current_va · target_va · stress(로그 값, 없으면 deriveStress) · seed · pace(pace_user, 옛 기록 pace_mode)
 *   개인    personal = personal_policy(엔진이 쓴 정규화 정책 그대로) · user = { disliked, recent_played = exclude_ids, global_stats:{}, ...user_affinity }
 * 건너뛰는 것: 카탈로그 digest 가 다르거나 없음 · rules_hash/엔진 버전이 지금과 다름(--ignore-* 로 무시) · 시드·좌표 없음
 * 비교: 경로 곡 순서(role path) 전부 같아야 일치. 더 들을 곡(role extra)은 recommendExtras 가 있으면 따로 센다.
 * 출력: 재현한 것 중 일치 비율. 어긋난 것이 있으면 exit 1 (--no-fail 이면 0), 준비 실패 exit 2.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_REPO, loadCatalog } from "./catalog.mjs";
import { loadCurrent } from "./baseline.mjs";
import { loadAppTables, loadAppTablesAt } from "./app_tables.mjs";

export function parseArgs(argv) {
  const a = { recs: null, "catalog-ref": "origin/master", "data-repo": DATA_REPO, profile: null, json: null, limit: null,
              "ignore-digest": false, "ignore-versions": false, verbose: false, "no-fail": false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (!(k in a)) throw new Error(`모르는 인자: ${argv[i]}`);
    if (typeof a[k] === "boolean") a[k] = true; else a[k] = argv[++i];
  }
  if (!a.recs) throw new Error("--recs <추천 문서 JSON> 이 필요합니다");
  return a;
}

/* Firestore Timestamp·ISO·숫자 → epoch ms */
export function toMs(t) {
  if (t == null) return null;
  if (typeof t === "number") return t;
  if (typeof t === "string") { const x = Date.parse(t); return Number.isFinite(x) ? x : null; }
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number" || typeof t._seconds === "number") return (t.seconds ?? t._seconds) * 1000 + Math.floor((t.nanoseconds ?? t._nanoseconds ?? 0) / 1e6);
  return null;
}

/* 여러 모양의 입력 → { recs:[{ id, doc }], events:[…]|null, profile|null } */
export function normalizeInput(raw) {
  const unwrap = (x) => (x && x.data && typeof x.data === "object" && !x.input ? { id: x.id, ...x.data } : x);
  let recs = [], events = null, profile = null;
  if (Array.isArray(raw)) recs = raw.map(unwrap);
  else if (raw && typeof raw === "object") {
    recs = (raw.recommendations || []).map(unwrap);
    if (raw.session_log && Array.isArray(raw.session_log.recommendations)) recs = recs.concat(raw.session_log.recommendations.map(unwrap));
    if (Array.isArray(raw.events)) events = raw.events.concat((raw.session_log && raw.session_log.events) || []);
    if (raw.profile) profile = raw.profile;
  }
  const seen = new Set();
  const out = [];
  recs.forEach((d, i) => {
    const id = d.id || d.rec_id || (d.input && d.input.client_id) || `#${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, doc: d });
  });
  return { recs: out, events, profile };
}

/* 추천 시각 기준 싫어요 목록 — 곡마다 그 시각 이전의 마지막 like/dislike 이벤트로 판단 (싫어요 켬 = 목록에 있음, 좋아요 켬·싫어요 끔 = 없음) */
export function dislikedAt(events, atMs) {
  const last = new Map();
  for (const e of events || []) {
    const t = toMs(e.created_at_ms ?? e.created_at), sid = e.payload && e.payload.song_id;
    if (!sid || t == null || (atMs != null && t >= atMs)) continue;
    if (e.type !== "like" && e.type !== "dislike") continue;
    const on = e.payload.on !== false;
    const state = e.type === "dislike" ? on : on ? false : null;   // 좋아요 끔은 싫어요 상태를 바꾸지 않는다
    if (state === null) continue;
    const prev = last.get(sid);
    if (!prev || prev.t <= t) last.set(sid, { t, state });
  }
  return [...last].filter(([, v]) => v.state).map(([k]) => k);
}

const rulesHashOf = (doc) => {
  const m = doc.input && doc.input.personal_meta;
  if (m && m.rules_hash) return m.rules_hash;
  const av = String(doc.algorithm_version || "").split("+");
  return av.length >= 2 ? av[1] : null;
};
const engineVersionOf = (doc) => {
  const m = doc.input && doc.input.personal_meta;
  if (m && m.engine_version) return m.engine_version;
  const e = String(doc.algorithm_version || "").split("+").find((x) => /^e\d/.test(x));
  return e ? e.slice(1) : null;
};

/* 로그 문서 → { songsPool, inputs } 또는 { skip } */
export function rebuildInputs(doc, ctx) {
  const inp = doc.input || {};
  const now = inp.current_va, tgt = inp.target_va;
  if (!now || !tgt || typeof now.v !== "number" || typeof tgt.v !== "number") return { skip: "좌표 없음" };
  if (!inp.seed) return { skip: "시드 없음(옛 기록)" };
  const eff = inp.effective || {};
  const lyric = eff.lyric ?? inp.lyric_preference ?? "no_preference";
  const genresSel = eff.genres ?? inp.genres ?? [];
  const minutes = Number(eff.minutes ?? inp.recommend_minutes ?? 30);
  const genreApplied = !!(inp.filters && inp.filters.genre_applied);
  let pool = ctx.songs;
  if (lyric === "prefer_vocal") pool = pool.filter((s) => !s.instrumental);
  if (genreApplied && genresSel.length) pool = pool.filter((s) => (s.genres || []).some((g) => genresSel.includes(g)));
  let gates = lyric === "instrumental_only" ? ["instrumental_only"] : lyric === "prefer_vocal" ? ["exclude_instrumental"] : [];
  let genres = genreApplied ? genresSel : [];
  if (inp.relaxed === "lyric" || inp.relaxed === "both") gates = [];
  if (inp.relaxed === "genre" || inp.relaxed === "both") genres = [];
  const P = inp.personal_policy || null;
  const at = toMs(doc.created_at_ms ?? doc.created_at) ?? (inp.personal_meta && inp.personal_meta.as_of_ms) ?? null;
  const disliked = [...new Set([...(inp.disliked || []), ...(ctx.events ? dislikedAt(ctx.events, at) : ctx.profileDisliked)])];
  const user = { disliked, recent_played: (P && P.exclude_ids) || inp.recent_played || [], global_stats: {}, ...(inp.user_affinity || {}) };
  const pace = inp.pace_user ?? (inp.pace_mode === "fast" || inp.pace_mode === "slow" ? inp.pace_mode : null);
  const inputs = {
    now: { V: now.v, A: now.e }, target: { V: tgt.v, A: tgt.e },
    stress: Number.isFinite(inp.stress) ? inp.stress : ctx.tables.deriveStress(now), load: null,
    genres, duration_min: minutes, seed: inp.seed, gates, user,
    ...(pace ? { pace } : {}), ...(P ? { personal: P } : {}),
  };
  return { pool, inputs, minutes };
}

export function replayOne(entry, ctx, opt) {
  const doc = entry.doc, inp = doc.input || {};
  const meta = inp.personal_meta || null;
  if (!opt["ignore-digest"]) {
    if (!meta || !meta.catalog_digest) return { id: entry.id, status: "skipped", reason: "카탈로그 digest 없음(personal_meta 없음 — 익명·옛 기록)" };
    if (meta.catalog_digest !== ctx.index.digest) return { id: entry.id, status: "skipped", reason: `카탈로그 digest 다름 (${meta.catalog_digest} ≠ ${ctx.index.digest})` };
  }
  if (!opt["ignore-versions"]) {
    const rh = rulesHashOf(doc), ev = engineVersionOf(doc);
    if (rh && rh !== ctx.rules.rules_hash) return { id: entry.id, status: "skipped", reason: `rules_hash 다름 (${rh} ≠ ${ctx.rules.rules_hash})` };
    if (ev && ev !== ctx.engine.ENGINE_VERSION) return { id: entry.id, status: "skipped", reason: `엔진 버전 다름 (${ev} ≠ ${ctx.engine.ENGINE_VERSION})` };
  }
  const r = rebuildInputs(doc, ctx);
  if (r.skip) return { id: entry.id, status: "skipped", reason: r.skip };
  const rows = Array.isArray(doc.sequence) ? doc.sequence : [];
  const logPath = rows.filter((x) => (x.role || "path") === "path").sort((a, b) => a.position - b.position).map((x) => x.song_id);
  const logExtra = rows.filter((x) => x.role === "extra").sort((a, b) => a.position - b.position).map((x) => x.song_id);
  let res;
  try { res = ctx.engine.recommend(r.pool, ctx.rules, r.inputs); }
  catch (e) { return { id: entry.id, status: "error", reason: `엔진 예외: ${e.message}` }; }
  const got = (res.sequence || []).map((x) => x.song_id);
  const same = got.length === logPath.length && got.every((x, i) => x === logPath[i]);
  const posMatch = logPath.filter((x, i) => got[i] === x).length;
  const out = { id: entry.id, status: same ? "match" : "mismatch", n_path: logPath.length, pos_match: posMatch };
  if (!same) {
    const k = logPath.findIndex((x, i) => got[i] !== x);
    out.first_diff = { position: (k < 0 ? Math.min(got.length, logPath.length) : k) + 1, log: logPath[k] ?? null, replay: got[k] ?? null };
    out.log = logPath; out.replay = got;
    const dis = new Set(r.inputs.user.disliked);
    if (logPath.some((x) => dis.has(x))) out.hint = "로그 경로에 지금 싫어요 목록의 곡이 있음 — 싫어요 상태가 그때와 다름";
    else if (!ctx.events && !ctx.profileDisliked.length) out.hint = "싫어요 목록을 알 수 없음(events·--profile 없음)";
  }
  if (logExtra.length && r.inputs.personal && typeof ctx.engine.recommendExtras === "function") {
    try {
      const ex = ctx.engine.recommendExtras(r.pool, ctx.rules, r.inputs, res, {});
      const gotX = ((ex && ex.extras) || []).map((x) => x.song_id);
      out.extras = { n: logExtra.length, same: gotX.length === logExtra.length && gotX.every((x, i) => x === logExtra[i]) };
    } catch (e) { out.extras = { n: logExtra.length, error: e.message }; }
  }
  return out;
}

async function main() {
  let opt;
  try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const C = await loadCurrent();
  if (!C.engine || !C.rules) { console.error(`엔진·규칙을 불러오지 못했습니다: ${(C.errors.engine || C.errors.rules || {}).message}`); process.exit(2); }
  let tables;
  try { tables = loadAppTables(); } catch (e) { console.warn(`index.html 앵커 추출 실패 → 76e8bdf 표 사용 (${e.message.split("\n")[0]})`); tables = loadAppTablesAt("76e8bdf"); }
  const { songs, index } = loadCatalog({ dataRepo: opt["data-repo"], ref: opt["catalog-ref"], engine: C.engine, rules: C.rules, tables, quiet: true });
  const raw = JSON.parse(fs.readFileSync(path.resolve(opt.recs), "utf8"));
  const { recs, events, profile } = normalizeInput(raw);
  const prof = opt.profile ? JSON.parse(fs.readFileSync(path.resolve(opt.profile), "utf8")) : profile;
  const ctx = { engine: C.engine, rules: C.rules, songs, index, tables, events, profileDisliked: (prof && prof.dislikedSongs) || [] };
  const list = opt.limit ? recs.slice(0, Number(opt.limit)) : recs;
  console.log(`추천 ${list.length}건 · 카탈로그 ${index.n}곡 digest ${index.digest} (${opt["catalog-ref"]}) · 엔진 ${C.engine.ENGINE_VERSION} · 규칙 ${C.rules.rules_version}/${C.rules.rules_hash}` +
              ` · 싫어요 출처 ${events ? "이벤트(추천 시각 기준)" : prof ? "프로필(지금 상태)" : "없음"}`);
  const results = list.map((e) => replayOne(e, ctx, opt));
  const tried = results.filter((r) => r.status === "match" || r.status === "mismatch");
  const matched = tried.filter((r) => r.status === "match");
  const skipped = {};
  for (const r of results) if (r.status === "skipped" || r.status === "error") skipped[r.reason] = (skipped[r.reason] || 0) + 1;
  const withX = tried.filter((r) => r.extras && "same" in r.extras);
  for (const r of results) if (r.status === "mismatch" || (opt.verbose && r.status !== "match")) {
    console.log(`  ${r.status === "mismatch" ? "✗" : "–"} ${r.id} ${r.status === "mismatch" ? `위치 ${r.first_diff.position}: 로그 ${r.first_diff.log} / 재현 ${r.first_diff.replay} (${r.pos_match}/${r.n_path} 위치 같음)${r.hint ? ` — ${r.hint}` : ""}` : r.reason}`);
    if (opt.verbose && r.status === "mismatch") console.log(`      로그 ${r.log.join(" ")}\n      재현 ${r.replay.join(" ")}`);
  }
  const rate = tried.length ? matched.length / tried.length : null;
  console.log(`재현 ${tried.length}건 중 경로 일치 ${matched.length}건${rate != null ? ` (${(rate * 100).toFixed(1)}%)` : ""}` +
              (withX.length ? ` · 더 들을 곡 일치 ${withX.filter((r) => r.extras.same).length}/${withX.length}` : "") +
              (Object.keys(skipped).length ? ` · 건너뜀 ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(" · ")}` : ""));
  if (!tried.length) console.warn("⚠ 재현한 추천이 없습니다 — 건너뛴 이유를 확인하세요");
  if (opt.json) {
    const f = path.resolve(opt.json);
    fs.writeFileSync(f, JSON.stringify({ catalog_digest: index.digest, engine_version: C.engine.ENGINE_VERSION, rules_hash: C.rules.rules_hash,
                                         tried: tried.length, matched: matched.length, rate, skipped, results }, null, 1));
    console.log(`→ ${f}`);
  }
  process.exitCode = tried.length > matched.length && !opt["no-fail"] ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) await main();
