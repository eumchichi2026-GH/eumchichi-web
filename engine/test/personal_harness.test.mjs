/*
 * personal.js 시험 공용 준비물 — 규칙·엔진·합성 카탈로그·RawFacts 빌더. (node --test 가 이 파일도 시험으로 돌린다: 계약 확인 몇 개)
 * 합성 카탈로그만 쓴다(데이터 저장소 접근 없음). 난수는 고정 시드 LCG — 결과가 매번 같다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
const SPEC = path.join(ROOT, "docs", "personalization_spec_20260927.md");

/* 명세 §10 의 personalization JSON(전문) — 규칙 파일에 절이 없을 때의 대체이자 키 누락 검사 기준 */
export function specPersonalization() {
  const md = fs.readFileSync(SPEC, "utf8");
  const i = md.indexOf("## 10.");
  const a = md.indexOf("```json", i), b = md.indexOf("```", a + 7);
  return JSON.parse("{" + md.slice(a + 7, b) + "}").personalization;
}
export function loadRules() {
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, "rules", "rules.compiled.json"), "utf8"));
  if (!r.personalization) r.personalization = specPersonalization();
  return r;
}
export const RULES = loadRules();
export const E = await import(pathToFileURL(path.join(ROOT, "engine", "engine.js")).href);
export const P = await import(pathToFileURL(path.join(ROOT, "engine", "personal.js")).href);

export const DAY = 86400000;
export const MIN = 60000;
export const T0 = Date.UTC(2026, 8, 1, 9, 0, 0);   // 고정 기준 시각(시험용)

export function lcg(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(1664525, x) + 1013904223) >>> 0) / 4294967296);
}
const GENRES = ["발라드", "재즈", "K-pop", "힙합·랩", "인디"];
/* 합성 카탈로그 — ContractSong 모양(toContractSong 과 같은 필드) */
export function makeCatalog(n = 240, seed = 7, extra = []) {
  const r = lcg(seed);
  const songs = [];
  for (let i = 0; i < n; i++) {
    songs.push({
      song_id: "S" + String(i).padStart(4, "0"), title: "곡" + i, artist: "가수" + (i % 40),
      V: r(), A: r(), va_source: "provider", spokenness: r(), instrumental: r() < 0.2,
      genres: [GENRES[i % GENRES.length]], popularity: Math.floor(r() * 100), duration_ms: 180000 + Math.floor(r() * 120000), tempo: r(),
    });
  }
  return [...songs, ...extra];
}
export function makeIndex(songs, rules = RULES) {
  const bin = E.makeFeatureBinner(songs, rules);
  const byId = new Map(songs.map((s) => [s.song_id, { ...s, feature_bins: bin(s), feature_bins_p: {} }]));
  return { n: songs.length, digest: "test", byId, coords: E.workingCoords(songs, rules) };
}
export function song(id, o = {}) {
  return { song_id: id, title: id, artist: o.artist ?? "가수_" + id, V: o.V ?? 0.5, A: o.A ?? 0.5, va_source: "provider",
           spokenness: o.spokenness ?? 0.2, instrumental: o.instrumental ?? false, genres: o.genres ?? ["발라드"],
           popularity: 50, duration_ms: o.duration_ms ?? 200000, tempo: o.tempo ?? 0.5 };
}

/* 앱 상수(index.html MOOD_CHIPS·GOAL_CHIPS·NL_EXTRA_*·NL_K) — 시험 입력 */
export const VOCAB = {
  mood_chips: [["불안해요", 0.30, 0.72], ["짜증나요", 0.25, 0.65], ["답답해요", 0.32, 0.55], ["걱정돼요", 0.35, 0.60], ["지쳤어요", 0.30, 0.25],
               ["우울해요", 0.25, 0.32], ["나른해요", 0.50, 0.25], ["그냥 그래요", 0.50, 0.50], ["설레요", 0.75, 0.68], ["신나요", 0.82, 0.80], ["편안해요", 0.72, 0.28]],
  goal_chips: [["푹 쉬고 싶어요", 0.65, 0.15], ["차분해지고 싶어요", 0.60, 0.30], ["집중해야 해요", 0.55, 0.45], ["기분 전환하고 싶어요", 0.75, 0.65],
               ["신나고 싶어요", 0.80, 0.85], ["시원하게 털어버리고 싶어요", 0.78, 0.75]],
  nl_extra_emo: [["긴장돼요", 0.30, 0.80], ["화나요", 0.18, 0.82], ["무기력해요", 0.28, 0.15], ["슬퍼요", 0.20, 0.35], ["외로워요", 0.28, 0.38], ["기분 좋아요", 0.78, 0.55]],
  nl_extra_goal: [["위로받고 싶어요", 0.55, 0.32], ["잠들고 싶어요", 0.62, 0.08]],
  nl_k: { "1": 0.6, "2": 1, "3": 1.3 },
};

// ── RawFacts 빌더 ────────────────────────────────────────
let EVN = 0;
export function ev(recId, at, type, payload = {}, id = null) {
  EVN++;
  return { id: id ?? "ev" + EVN, created_at_ms: at, rec_id: recId, type, payload: { app: "web-personal", env: "local", client_id: `${recId}|${type}|${payload.song_id ?? ""}|${EVN}`, ...payload } };
}
export function legacyEv(recId, at, type, payload = {}, id = null) {
  EVN++;
  return { id: id ?? "lev" + EVN, created_at_ms: at, rec_id: recId, type, payload };
}
/* web-personal 추천 문서. path: [song_id] 또는 [{ id, phase, pmarg, discovery, replay }] */
export function wpRec(id, at, { path = [], extras = [], input = {}, holdFrom = null } = {}) {
  const rows = path.map((p, i) => {
    const o = typeof p === "string" ? { id: p } : p;
    const phase = o.phase ?? (holdFrom !== null && i + 1 >= holdFrom ? "hold" : "move");
    return { song_id: o.id, position: i + 1, role: "path", phase, p_pmarg: o.pmarg ?? 0, discovery: !!o.discovery, replay: !!o.replay, soft_relaxed: false };
  });
  extras.forEach((x, j) => {
    const o = typeof x === "string" ? { id: x } : x;
    rows.push({ song_id: o.id, position: path.length + j + 1, role: "extra", phase: "extra", p_pmarg: o.pmarg ?? 0, replay: !!o.replay });
  });
  return {
    id, created_at_ms: at,
    input: {
      app: "web-personal", env: "local", current_va: { v: 0.3, e: 0.72 }, target_va: { v: 0.6, e: 0.3 },
      labels: { current: { mode: "chip", chip: "불안해요" }, target: { mode: "chip", chip: "차분해지고 싶어요" } },
      table_point: { current: { v: 0.3, e: 0.72 }, target: { v: 0.6, e: 0.3 } }, nudged: { current: false, target: false },
      effective: { lyric: "no_preference", genres: [], minutes: 30 }, recommend_minutes: 30, pace_user: null, ...input,
    },
    sequence: rows,
  };
}
/* fix-web(옛) 추천 문서 — app·labels·phase·p_* 없음 */
export function fwRec(id, at, { path = [], extras = [], input = {} } = {}) {
  return {
    id, created_at_ms: at,
    input: { lyric_preference: "no_preference", genres: [], recommend_minutes: 30, current_va: { v: 0.3, e: 0.72 }, target_va: { v: 0.6, e: 0.3 },
             input_mode: { current: "chip", target: "chip" }, pace_mode: "auto", ...input },
    sequence: [...path.map((s, i) => ({ song_id: s, position: i + 1, role: "path" })),
               ...extras.map((s, j) => ({ song_id: s, position: path.length + j + 1, role: "extra" }))],
  };
}
/* 재생 순서대로 track_exit — { song, pos, c, cause, dur, listened, role, preview, started } */
export function plays(recId, at0, list) {
  const out = [];
  let prev = null;
  list.forEach((p, k) => {
    const dur = p.dur ?? 200;
    const cause = p.cause ?? (p.c >= 0.99 ? "complete" : "next");
    const listened = p.listened ?? Math.round(p.c * dur * 1000) / 1000;
    out.push(ev(recId, at0 + (k + 1) * MIN, "track_exit", {
      song_id: p.song, position: p.pos ?? k + 1, queue_pos: k + 1, role: p.role ?? "path", instance: p.instance ?? 1,
      started: p.started ?? cause !== "autoplay_fail", listened_s: cause === "autoplay_fail" ? 0 : listened, duration_s: dur, catalog_s: p.catalog_s ?? dur,
      completion: cause === "autoplay_fail" ? 0 : p.c, preview: p.preview ?? false, cause,
      prev_song_id: prev ? prev.song : null, prev_completion: prev ? prev.c : null, bg_credit_s: 0, seek_fwd_s: 0, liked: false, disliked: false,
    }));
    prev = p;
  });
  return out;
}
export function postChange(recId, at, o = {}) {
  return ev(recId, at, "post_change", {
    change: o.change ?? 0, touched: o.touched ?? true, pace_answer: o.pace_answer ?? null, length_dir: o.length_dir ?? null, rec_id: recId,
    misfit_reasons: o.reasons ? Object.keys(o.reasons) : [], reasons_source: o.reasons ?? {}, ai_codes_removed_by_user: o.removed ?? [],
    note_ai: o.positions ? { echo: "", codes: [], other: false, positions: o.positions, tone: null, liked: null } : null,
  });
}
export function rawOf({ recs = [], events = [], profile = {}, vocab = VOCAB, as_of_ms = T0 + 30 * DAY, session_log = null } = {}) {
  return {
    schema: "wp-raw/1", uid: "u-test", as_of_ms, env: { app: "web-personal", env: "local" },
    profile: { likedSongs: [], dislikedSongs: [], playlists: [], favorite_tracks: [], wallMeta: {}, pinned_artists_resolved: [], recommend_minutes: null,
               wp_personal_v1: null, ...profile },
    recommendations: [...recs].sort((a, b) => b.created_at_ms - a.created_at_ms),   // 최신순 (앱과 같음)
    events: [...events].sort((a, b) => b.created_at_ms - a.created_at_ms),
    listening_history: null, session_log: session_log || { recommendations: [], events: [] }, vocab, context: { global_stats_digest: null },
  };
}
/* raw → 모델 (한 번에) */
export function modelOf(raw, idx, rules = RULES, as_of_ms = raw.as_of_ms) {
  const norm = P.normalizeLogs(raw, idx, rules);
  return { norm, model: P.buildPersonalModel(norm, idx, rules, { as_of_ms }) };
}
export const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} ≉ ${b} (±${eps})`);

// ── 계약 확인 (이 파일을 직접 돌릴 때만 — 다른 시험 파일이 import 할 때 중복 실행하지 않는다) ──
const MAIN = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
const t = MAIN ? test : () => {};
t("엔진이 personal.js 가 쓰는 export 를 모두 낸다 (§9.2)", () => {
  for (const n of ["fnv1a32", "seededUniform", "aggregateAffinity", "artistKeys", "makeFeatureBinner", "makeExtraBinner", "workingCoords",
                   "songCount", "transitionAt", "adjFeatures", "sanitizePersonal", "median"]) assert.equal(typeof E[n], "function", n);
});

t("personal.js 가 §9.2 export 를 모두 낸다", () => {
  assert.equal(P.PERSONAL_VERSION, "p1.0.0");
  assert.deepEqual(P.SCHEMAS, { raw: "wp-raw/1", model: "wp-model/1", policy: "wp-policy/1", meta: "wp-meta/1" });
  for (const n of ["emptyModel", "normalizeLogs", "buildPersonalModel", "stressOf", "tablePoint", "calibratePoint", "suggestMinutes", "resolvePolicy",
                   "neutralPolicy", "pathMetrics", "safetyCheck", "buildRecLog", "validateEvent", "listenVote", "transitionLabel", "explainPolicy",
                   "explainModel", "digest"]) assert.equal(typeof P[n], "function", n);
});

t("규칙 파일의 personalization 절이 §10 키를 모두 가진다 (§11 I)", () => {
  const spec = specPersonalization();
  const missing = [];
  const walk = (a, b, pre) => {
    for (const k of Object.keys(a)) {
      if (!(k in (b || {}))) { missing.push(pre + k); continue; }
      if (a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) walk(a[k], b[k], pre + k + ".");
    }
  };
  walk(spec, RULES.personalization, "");
  assert.deepEqual(missing, []);
});

t("I7 — personal.js 에 비결정 난수·현재 시각 읽기가 없다", () => {
  const src = fs.readFileSync(path.join(ROOT, "engine", "personal.js"), "utf8");
  assert.equal(/Math\.random|Date\.now/.test(src), false);
  assert.match(src, /from "\.\/engine\.js"/);
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./engine.js"]);   // engine.js 만 import 한다(§2.1)
});
