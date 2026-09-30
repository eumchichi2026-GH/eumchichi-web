/*
 * 시나리오 격자 (TOOLS · 명세 §9.3 · §11 A·B·C) — 회귀·스윕·봉투 측정이 같은 입력을 쓰게 한 곳에 둔다.
 *
 *   iso1224()  감정 17(MOOD_CHIPS + NL_EXTRA_EMO) × 목표 8(GOAL_CHIPS + NL_EXTRA_GOAL) × 15·30·60분 × 시드 3 = 1,224
 *              eumchichi-data `scripts/analysis/iso_path_quality.mjs` 와 같은 순서·시드(`guest-Q{k}:demo:1`) — 봉투 수치를 그대로 비교할 수 있다
 *   adj660()   지금 칩 11 × 목표 칩 6 × 15·30분 × 시드 5 = 660
 *              `scripts/analysis/adjacent_similarity.mjs` 와 같은 순서·시드(`adjacent-similarity:{k}`) — 인접 구성 수치(28.3 BPM 등) 기준
 *   probe()    가상 사용자 5명 × μ 3(0 · 0.5 · 1) = 15 사례, 사례마다 시드 5 → 75회
 *              `scripts/analysis/personalization_probe.mjs` 와 같은 입력(긴장돼요 → 차분해지고 싶어요, 30분)·같은 기록 뽑기(고정 LCG 12345)
 *
 * 시나리오 모양: { grid, id, case, now_label, goal_label, now:{v,e}, target:{v,e}, minutes, seed, inputs, rules_patch, meta }
 *   now·target  원좌표 {v,e}(앱 CUR_VA/TGT_VA 모양) — 시뮬레이터가 ctx 를 만들 때 쓴다
 *   inputs      recommend(catalog, rules, inputs) 에 그대로 넣는 엔진 입력 (index.html recommend() 의 engineInput 모양, 신규 사용자)
 *   rules_patch 규칙에 덮어쓸 부분(probe 의 μ) — applyRulesPatch(rules, patch) 로 적용. 없으면 null
 * 앱 표는 기본으로 기준 커밋(76e8bdf)의 index.html(기준 사본 tools/sim/baseline/index_76e8bdf.html)에서 읽는다 — APP 가 index.html 을 고치는 중이어도 격자가 흔들리지 않게.
 * 지금 앱의 표로 돌리려면 { tables: loadAppTables() } 를 넘긴다.
 */
import { loadAppTablesAt } from "./app_tables.mjs";
import { BASELINE_REF } from "./baseline.mjs";

export const GRID_NAMES = ["iso1224", "adj660", "probe"];
const defaultTables = () => loadAppTablesAt(BASELINE_REF);

/* index.html recommend() 가 엔진에 넘기는 입력 (azt_app.mjs engineInput 과 같다). user 를 안 주면 신규 사용자 */
export function engineInput(tables, x, { seed, user = null } = {}) {
  return {
    now: { V: x.nowVA.v, A: x.nowVA.e }, target: { V: x.tgtVA.v, A: x.tgtVA.e },
    stress: tables.deriveStress(x.nowVA), load: null, genres: x.genres || [], duration_min: x.minutes, seed,
    gates: x.lyric === "instrumental_only" ? ["instrumental_only"] : x.lyric === "prefer_vocal" ? ["exclude_instrumental"] : [],
    user: user || { disliked: [], recent_played: [], global_stats: {} },
  };
}

/* 규칙 사본에 부분 덮어쓰기(객체는 재귀, 배열·값은 교체). 원본은 건드리지 않는다 */
export function applyRulesPatch(rules, patch) {
  if (!patch) return rules;
  const merge = (a, b) => {
    if (!b || typeof b !== "object" || Array.isArray(b)) return b;
    const out = { ...(a && typeof a === "object" && !Array.isArray(a) ? a : {}) };
    for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
    return out;
  };
  return merge(rules, patch);
}

export function iso1224({ tables = defaultTables(), durations = [15, 30, 60], seeds = 3 } = {}) {
  const out = [];
  for (const e of tables.NL_EMO) for (const g of tables.NL_GOALS) for (const minutes of durations) for (let k = 1; k <= seeds; k++) {
    const x = { nowVA: { v: e.v, e: e.e }, tgtVA: { v: g.v, e: g.e }, minutes, lyric: "no_preference" };
    const seed = `guest-Q${k}:demo:1`;
    out.push({ grid: "iso1224", id: `iso:${e.label}>${g.label}:${minutes}m:s${k}`, case: `${e.label}>${g.label}:${minutes}m`,
               now_label: e.label, goal_label: g.label, now: x.nowVA, target: x.tgtVA, minutes, seed,
               inputs: engineInput(tables, x, { seed }), rules_patch: null,
               meta: { now_label: e.label, goal_label: g.label, minutes, seed_k: k, now: x.nowVA, target: x.tgtVA } });
  }
  return out;
}

export function adj660({ tables = defaultTables(), durations = [15, 30], seeds = 5 } = {}) {
  const out = [];
  for (const [nowLabel, nv, ne] of tables.MOOD_CHIPS) for (const [goalLabel, gv, ge] of tables.GOAL_CHIPS)
    for (const minutes of durations) for (let k = 0; k < seeds; k++) {
      const x = { nowVA: { v: nv, e: ne }, tgtVA: { v: gv, e: ge }, minutes, lyric: "no_preference" };
      const seed = `adjacent-similarity:${k}`;
      out.push({ grid: "adj660", id: `adj:${nowLabel}>${goalLabel}:${minutes}m:s${k}`, case: `${nowLabel}>${goalLabel}:${minutes}m`,
                 now_label: nowLabel, goal_label: goalLabel, now: x.nowVA, target: x.tgtVA, minutes, seed,
                 inputs: engineInput(tables, x, { seed }), rules_patch: null,
                 meta: { now_label: nowLabel, goal_label: goalLabel, minutes, seed_k: k, now: x.nowVA, target: x.tgtVA } });
    }
  return out;
}

/**
 * 개인화 탐침 — 기록이 다른 가상 사용자 5명 × μ(규칙 preference.pref_weight 덮어쓰기) 3 × 시드 5.
 * @param {object} o
 * @param {object[]} o.songs   loadCatalog().songs (feature_bins 포함, **CSV 순서 그대로** — 기록 뽑기가 순서에 기댄다)
 * @param {object} o.engine    aggregateAffinity 를 가진 엔진 (회귀에서는 기준 엔진 — 두 엔진에 같은 user 를 넣는다)
 * @param {object} o.rules     그 엔진의 규칙
 */
export function probe({ songs, engine, rules, tables = defaultTables(), seeds = 5, mus = [0, 0.5, 1] } = {}) {
  if (!songs || !engine || !rules) throw new Error("probe() 에는 { songs, engine, rules } 가 필요합니다");
  const E = tables.nlByLabel(tables.NL_EMO, "긴장돼요"), G = tables.nlByLabel(tables.NL_GOALS, "차분해지고 싶어요");
  if (!E || !G) throw new Error("탐침 입력 단어(긴장돼요 / 차분해지고 싶어요)가 앱 표에 없습니다");
  const X = { nowVA: { v: E.v, e: E.e }, tgtVA: { v: G.v, e: G.e }, minutes: 30, lyric: "no_preference" };

  /* 결정적 난수 — personalization_probe.mjs 와 같은 LCG·같은 호출 순서 */
  let rs = 12345; const rnd = () => ((rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296);
  const pick = (list, n) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
  const item = (s, extra) => ({ song_id: s.song_id, artist: s.artist, genres: s.genres, feature_bins: s.feature_bins, days: 1, ...extra });
  const has = (g) => (s) => s.genres.includes(g);
  const artistCount = new Map(); for (const s of songs) artistCount.set(s.artist, (artistCount.get(s.artist) || 0) + 1);
  const wallArtist = ["아이유", "잔나비", "검정치마"].find((a) => artistCount.get(a) >= 5) || [...artistCount].sort((a, b) => b[1] - a[1])[0][0];
  const users = [
    { id: "신규", items: [] },
    { id: "재즈", items: [...pick(songs.filter(has("재즈")), 10).map((s, i) => item(s, { liked: i < 8 })), ...pick(songs.filter(has("K-pop")), 10).map((s) => item(s, { liked: false }))] },
    { id: "K-pop·발라드", items: [...pick(songs.filter((s) => has("K-pop")(s) && has("발라드")(s)), 10).map((s, i) => item(s, { liked: i < 8 })), ...pick(songs.filter(has("재즈")), 10).map((s) => item(s, { liked: false }))] },
    { id: "연주곡", items: [...pick(songs.filter((s) => s.instrumental), 10).map((s, i) => item(s, { liked: i < 8 })), ...pick(songs.filter((s) => !s.instrumental), 10).map((s) => item(s, { liked: false }))] },
    { id: `벽:${wallArtist}`, items: pick(songs.filter((s) => s.artist === wallArtist), 5).map((s) => item(s, { pinned: true, liked: true })) },
  ];
  const out = [];
  for (const u of users) {
    const user = { disliked: [], recent_played: [], global_stats: {}, ...engine.aggregateAffinity(u.items, rules) };
    for (const mu of mus) for (let k = 1; k <= seeds; k++)
      out.push({ grid: "probe", id: `probe:${u.id}:mu${mu}:s${k}`, case: `${u.id}:mu${mu}`,
                 now_label: "긴장돼요", goal_label: "차분해지고 싶어요", now: X.nowVA, target: X.tgtVA, minutes: X.minutes, seed: `guest-${u.id}:demo:${k}`,
                 inputs: engineInput(tables, X, { seed: `guest-${u.id}:demo:${k}`, user }),
                 rules_patch: { preference: { pref_weight: mu } },
                 meta: { user: u.id, mu, seed_k: k, items: u.items, now: X.nowVA, target: X.tgtVA, minutes: X.minutes } });
  }
  return out;
}

/* 이름으로 격자 만들기 — ctx 는 probe 에만 필요({ songs, engine, rules }) */
export function gridByName(name, ctx = {}) {
  if (name === "iso1224") return iso1224(ctx);
  if (name === "adj660") return adj660(ctx);
  if (name === "probe") return probe(ctx);
  throw new Error(`모르는 격자: ${name} (${GRID_NAMES.join(" | ")})`);
}
