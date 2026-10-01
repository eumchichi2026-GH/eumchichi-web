/* 엔진 단위 시험 공용 준비물 — 작은 합성 카탈로그(결정적 생성), 무작위 입력·사용자·정책, 기준 엔진(76e8bdf) 불러오기.
 *
 * 다른 engine_*.test.mjs 가 import 해서 쓴다. 이 파일을 직접 돌리면(node --test) 준비물 자체의 결정성만 확인한다.
 * 기준 엔진 2.5.1 은 기준 사본 tools/sim/baseline/engine_2.5.1.js(fix-web 76e8bdf:engine/engine.js 그대로)를
 * OS 임시 파일(.mjs)로 써서 import 한 뒤 바로 지운다(명세 §9.1). 76e8bdf 는 web 저장소에 없는 커밋이라 git show 대신 사본을 읽는다.
 * 합성 데이터만 쓴다 — 데이터 저장소·네트워크에 닿지 않는다. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import * as E from "../engine.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE_REF = "76e8bdf";   // 기준 사본의 출처 커밋
const BASE_DIR = path.join(ROOT, "tools", "sim", "baseline");

export function loadRules() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "rules", "rules.compiled.json"), "utf8"));
}
export const clone = (x) => JSON.parse(JSON.stringify(x));

let importSeq = 0;
/* 기준 엔진·규칙(2.5.1 · v2.4.0) — 기준 사본. 임시 파일은 import 직후 지운다. */
export async function loadBaseline(ref = BASE_REF) {
  if (ref !== BASE_REF) throw new Error(`기준 사본은 ${BASE_REF} 하나뿐입니다(tools/sim/baseline/) — 받은 ref: ${ref}`);
  const src = fs.readFileSync(path.join(BASE_DIR, "engine_2.5.1.js"), "utf8");
  const rules = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "rules_v2.4.0.json"), "utf8"));
  /* [2026-09-30] 곡 수 상한을 9→12 로 바꾼 것은 의도한 변경 — 기준 규칙에도 지금 규칙의 song_count 를 넣어 경로 식만 비교한다(I0). */
  { const cur = loadRules().iso; rules.iso.song_count = { ...cur.song_count }; rules.iso.song_count_evidence = cur.song_count_evidence; }
  const f = path.join(os.tmpdir(), `azt-engine-${ref}-${process.pid}-${++importSeq}.mjs`);
  fs.writeFileSync(f, src);
  try { return { engine: await import(pathToFileURL(f).href), rules }; } finally { fs.rmSync(f, { force: true }); }
}

/* 결정적 난수 — 시험 코드 전용(엔진은 seededUniform 만 쓴다). mulberry32. */
export function makeRng(key) {
  let a = E.fnv1a32(String(key)) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));   // [lo, hi]
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  next.sample = (arr, k) => { const a = arr.slice(); const out = []; while (out.length < k && a.length) out.push(a.splice(Math.floor(next() * a.length), 1)[0]); return out; };
  return next;
}

export const GENRES = ["pop", "ballad", "jazz", "hiphop", "rock", "ost", "indie", "rnb"];
const SOURCES = ["manual", "golden_set_calibrated", "golden_set_provisional", "lyric_blend", "deam", "provider", "unknown"];

/* 합성 카탈로그 n곡. 앱 toContractSong 과 같은 필드 + feature_bins(규칙 특징) + feature_bins_p(인기도, 0=모름).
   협업 표기 "A;B", 대소문자·공백만 다른 같은 가수("Band Seven"/"band seven"), 빈 값(빠르기·말 비중·연주곡 여부 모름),
   같은 V/A 값(동점)을 일부러 섞는다. */
export function makeCatalog(rules, n = 300, key = "wp-fixture") {
  const r = makeRng(key);
  const artists = Array.from({ length: 70 }, (_, i) => `가수${String(i + 1).padStart(2, "0")}`);
  artists.push("Band Seven", "band seven", "IU", "iu");
  const pickArtist = () => artists[Math.min(artists.length - 1, Math.floor(Math.pow(r(), 1.6) * artists.length))];
  const songs = [];
  for (let i = 0; i < n; i++) {
    const a1 = pickArtist();
    let a2 = pickArtist(); if (a2 === a1) a2 = artists[(artists.indexOf(a1) + 3) % artists.length];
    const cluster = r.chance(0.15);
    const V = cluster ? 0.3 + Math.round(r() * 10) / 100 : Math.round(r() * 1000) / 1000;
    const A = cluster ? 0.6 + Math.round(r() * 10) / 100 : Math.round(r() * 1000) / 1000;
    const ng = r.chance(0.1) ? 0 : r.int(1, 2);
    songs.push({
      song_id: `S${String(i).padStart(4, "0")}`,
      title: `곡 ${i}`,
      artist: r.chance(0.12) ? `${a1};${a2}` : a1,
      V, A,
      va_source: r.pick(SOURCES),
      spokenness: r.chance(0.03) ? null : Math.round(r() * r() * 1000) / 1000,
      instrumental: r.chance(0.03) ? undefined : r.chance(0.22),
      genres: r.sample(GENRES, ng),
      popularity: r.chance(0.12) ? 0 : r.int(1, 100),
      duration_ms: r.chance(0.1) ? undefined : r.int(150, 320) * 1000,
      tempo: r.chance(0.08) ? null : Math.round(r() * 1000) / 1000,
    });
  }
  const fb = E.makeFeatureBinner(songs, rules);
  const xb = E.makeExtraBinner(songs, rules.personalization.taste.extra_features_available);
  for (const s of songs) { s.feature_bins = fb(s); s.feature_bins_p = xb(s); }
  return songs;
}

const REASONS = [null, "not_my_taste", "vocal_bother", "path_jump", "mood_mismatch", "too_repetitive", "arrival_mismatch", "length"];
/* 무작위 청취 항목(aggregateAffinity 입력). withVote 면 청취 표(vote) 항목도 섞는다. */
export function randomItems(r, catalog, k, { withVote = false, withExtra = false } = {}) {
  return r.sample(catalog, k).map((s) => {
    const it = { song_id: s.song_id, artist: s.artist, genres: s.genres, feature_bins: s.feature_bins, days: r.int(0, 60) };
    if (withExtra) it.feature_bins_p = s.feature_bins_p;
    const u = r();
    if (withVote && u < 0.3) it.vote = { pos: r.pick([0, 0.25, 0.5]), neg: r.pick([0, 0.25, 0.125]), pin: 0 };
    else if (u < 0.35) it.liked = true;
    else if (u < 0.5) { it.disliked = true; it.reason = r.pick(REASONS); }
    else if (u < 0.55) it.pinned = true;
    else if (u < 0.7) it.skipped = true;
    else it.completion = Math.round(r() * 100) / 100;
    if (r.chance(0.05)) it.liked = true;   // 좋아요+싫어요 겹침(싫어요가 이긴다)
    return it;
  });
}

/* 무작위 사용자(EngineUser 모양). 없음·빈 객체·벽만·기록 많음을 고루 섞는다. */
export function randomUser(r, catalog, rules, engine = E) {
  const kind = r();
  if (kind < 0.12) return undefined;
  if (kind < 0.2) return {};
  const items = kind < 0.28 ? r.sample(catalog, r.int(1, 4)).map((s) => ({ song_id: s.song_id, artist: s.artist, pinned: true }))
    : randomItems(r, catalog, r.int(1, 40));
  const user = engine.aggregateAffinity(items, rules);
  user.disliked = items.filter((it) => it.disliked).map((it) => it.song_id);
  user.recent_played = r.sample(catalog, r.int(0, 40)).map((s) => s.song_id);
  if (r.chance(0.3)) {
    user.global_stats = {};
    for (const s of r.sample(catalog, 30)) user.global_stats[s.song_id] = { pos: r.int(0, 5), neg: r.int(0, 5) };
  }
  return user;
}

const DURS = [5, 10, 12, 15, 18, 20, 25, 30, 34, 40, 45, 60, 90];
/* 무작위 추천 입력. 가까운 여정(곡 수 3), 지금 = 목표, 빈 후보(서로 배타 게이트)도 섞는다. */
export function randomInputs(r, catalog, rules, engine = E) {
  const now = { V: Math.round(r() * 1000) / 1000, A: Math.round(r() * 1000) / 1000 };
  let target;
  const t = r();
  if (t < 0.08) target = { ...now };
  else if (t < 0.2) target = { V: Math.min(1, now.V + (r() - 0.5) * 0.1), A: Math.min(1, Math.max(0, now.A + (r() - 0.5) * 0.1)) };
  else target = { V: Math.round(r() * 1000) / 1000, A: Math.round(r() * 1000) / 1000 };
  const inputs = { now, target };
  if (!r.chance(0.05)) inputs.duration_min = r.pick(DURS);
  if (r.chance(0.25)) inputs.genres = r.sample(GENRES, r.int(1, 2));
  if (r.chance(0.3)) inputs.gates = r.sample(["exclude_spoken", "exclude_instrumental", "instrumental_only"], r.int(1, 2));
  if (r.chance(0.2)) inputs.load = r.int(0, 4);
  if (r.chance(0.7)) inputs.seed = `u${r.int(1, 9)}:2026-09-${r.int(10, 28)}:${r.int(1, 5)}`;
  const user = randomUser(r, catalog, rules, engine);
  if (user !== undefined) inputs.user = user;
  return inputs;
}

/* 비교에서 빼는 필드(I0): engine_version · rules_version · rules_hash(최상위와 각 행 trace.rules_hash). */
export function stripVersions(res) {
  const o = clone(res);
  delete o.engine_version; delete o.rules_version; delete o.rules_hash;
  for (const row of o.sequence || []) if (row.trace) delete row.trace.rules_hash;
  return o;
}

/* 중립 정책 — 명세 §6.5 '중립(I1)' 열. personal.neutralPolicy(rules) 와 같은 값이어야 한다(ENGINE-personal 담당). */
export function neutralPolicy(rules) {
  const ZA = rules.personalization.adjacency;
  return {
    v: 1, schema: "wp-policy/1", digest: "neutral", model_digest: null,
    stress: null, high_stress: false,
    tp: null, quit_frac: null, start_offset: 0, start_min_journey: rules.personalization.start.min_journey,
    hold_radius: 0, hold_min_songs: rules.personalization.hold.min_songs, hold_order: "fit", hold_min_pool: 0, hold_cluster: false, hold_path_q: false,
    corridor_bands: null, j_move: null, j_hold: null, pers_bucket: null, hold_break: null, pers_jitter: null,
    mu: Number(rules.preference.pref_weight || 0), taste_features: null,
    adj_w: { tempo: 0, vocal: 0, spoken: 0, genre: 0 },
    bpm_scale: ZA.bpm_scale, spoken_scale: ZA.spoken_scale, half_double_fold: false,
    lambda: Number(rules.path.jump_weight || 0), discovery_u: null,
    soft_gates: [], soft_min_pool: rules.personalization.gates.soft_min_pool,
    artist_cap: rules.diversity.max_per_artist, artist_cap_by_key: false,
    exclude_ids: null, replay_ids: [], replay_max: 0,
  };
}

/* 모집단 기본 정책 P0 — 명세 §6.5 'P0' 열(빈 모델). */
export function p0Policy(rules, exclude_ids = []) {
  const Z = rules.personalization, band = Number(rules.preference.band);
  const adj_w = {};
  for (const [f, b] of Object.entries(Z.adjacency.base_weights_bands)) adj_w[f] = band * b * Z.adjacency.scale;
  return {
    ...neutralPolicy(rules), digest: "p0",
    hold_radius: Z.hold.p0_radius, hold_order: Z.hold.order, hold_min_pool: Z.hold.min_pool ?? 0, hold_cluster: Z.hold.cluster === true, hold_path_q: Z.hold.quantize_path === true,
    corridor_bands: Z.safety.corridor_bands, j_move: Z.safety.j_move_bands * band, j_hold: Z.safety.j_hold,
    pers_bucket: Z.safety.pers_bucket_bands == null ? null : Z.safety.pers_bucket_bands * band,
    hold_break: Z.hold.cluster_break === "j_hold" ? Z.safety.j_hold : null,
    pers_jitter: Z.safety.pers_mode === "perturb" && Z.safety.pers_bucket_bands != null ? Z.safety.pers_bucket_bands * band : null,
    mu: 0, adj_w, artist_cap_by_key: true, exclude_ids,
  };
}

/* 무작위 정책 — 경계 안팎을 고루. 코리도어·J 는 규칙 기본값(정리 조건) 또는 무작위. */
export function randomPolicy(r, rules, catalog, { spec = true } = {}) {
  const Z = rules.personalization, band = Number(rules.preference.band);
  const P = p0Policy(rules, r.sample(catalog, r.int(0, 60)).map((s) => s.song_id));
  P.mu = r() * 0.6;
  for (const f of Object.keys(P.adj_w)) P.adj_w[f] = r() * 2.2 * band;
  P.lambda = 0.05 + r() * 0.25;
  P.hold_radius = r.pick(Z.hold.arms);
  P.hold_order = r.pick(["fit", "last_fixed_progress", "last_fixed_turn", "last_fixed_smooth"]);
  P.hold_min_pool = r.pick([0, 0, 6, 12, 24]);
  P.hold_cluster = r.chance(0.5);
  P.hold_path_q = r.chance(0.5);
  P.pers_bucket = r.pick([null, 0, band / 8, band / 4, band / 2]);
  P.hold_break = r.pick([null, null, Z.safety.j_hold, r() * Z.safety.j_hold]);   // 묶음 깨기 비용(20260929)
  P.pers_jitter = r.pick([null, null, 0, band / 8, band / 4]);                    // 개인 비용 흔들기(20260929)
  if (!spec) { P.corridor_bands = r.pick([null, 0, 1, 2, 1.5]); P.j_move = r.chance(0.2) ? null : r() * 1.6 * band; P.j_hold = r.chance(0.2) ? null : r() * 0.013; }
  if (r.chance(0.4)) P.discovery_u = r();
  if (r.chance(0.3)) P.tp = 0.5 + r() * 0.5;
  if (r.chance(0.2)) P.quit_frac = r();
  if (r.chance(0.3)) P.start_offset = r.pick(Z.start.arms);
  if (r.chance(0.3)) P.soft_gates = ["exclude_spoken"];
  if (r.chance(0.3)) P.artist_cap = 1;
  if (r.chance(0.3)) { P.replay_ids = P.exclude_ids.slice(0, 3); P.replay_max = 1; }
  if (r.chance(0.2)) P.taste_features = Z.taste.extra_features_available;
  if (r.chance(0.2)) { P.stress = r.int(0, 4); }
  if (r.chance(0.1)) P.high_stress = true;
  return P;
}

/* 이 파일을 직접 돌릴 때만(다른 시험 파일이 import 할 때는 등록하지 않는다) */
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  test("합성 카탈로그는 결정적이고 필드가 앱 계약 모양이다", () => {
    const rules = loadRules();
    const a = makeCatalog(rules), b = makeCatalog(rules);
    assert.deepEqual(a, b);
    assert.equal(a.length, 300);
    assert.ok(a.some((s) => s.artist.includes(";")), "협업 표기");
    assert.ok(a.some((s) => s.tempo === null) && a.some((s) => s.popularity === 0));
    assert.ok(a.every((s) => s.feature_bins && s.feature_bins_p));
    assert.ok(a.every((s) => !s.popularity || s.feature_bins_p.popularity), "인기도가 있으면 묶임");
    assert.ok(a.every((s) => s.popularity || s.feature_bins_p.popularity === undefined), "0 은 모름");
  });
}
