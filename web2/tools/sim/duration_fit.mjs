/*
 * 요청 시간 vs 실제 목록 길이 (2026-09-30 — Firestore songs 전곡 duration_ms 반영 후)
 *
 * 기본 앱(저장소 루트 engine/engine.js) : 경로가 곧 전체 목록. 곡 수를 곡 길이 합으로 재조정.
 *   - "길이 없음" : duration_ms 를 지운 카탈로그(데이터 반영 전 앱 상태 — 곡 수 = round(분/3.73))
 *   - "옛"        : --old-root 로 준 엔진(2.6.1 — 마지막 재조정 결과를 그대로)
 *   - "새"        : 작업 트리 엔진(2.6.2 — 가장 가까운 결과)
 * web2(이 폴더 engine/engine.js) : 경로(≤ 9곡) + 더 들을 곡(recommendExtras, 개인 모드 — 중립 정책).
 *   - "옛" : --old-web2-engine · --old-web2-rules (fill 0.85, 12곡, 목표에 닿을 때까지)
 *   - "새" : 작업 트리 (fill 1.0, 30곡, 넘는 양 > 모자란 양이면 멈춤)
 *
 * 실행 (web2 폴더에서, 데이터 저장소는 catalog.mjs 규칙대로 찾거나 --data-repo):
 *   node tools/sim/duration_fit.mjs --old-root <옛 루트 engine.js> --old-web2-engine <옛 web2 engine.js> --old-web2-rules <옛 web2 rules.json> [--per 40]
 * 옛 파일은 git show HEAD~:<경로> > 임시파일 로 만든다(옛 web2 엔진은 같은 폴더의 personal.js 를 import 하므로 engine/ 안에 둔다).
 */
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadCatalog, readRules } from "./catalog.mjs";
import { u01 } from "./lib_rng.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB2 = path.resolve(HERE, "..", "..");
const REPO = path.resolve(WEB2, "..");

const args = { per: 40, "data-repo": null, "old-root": null, "old-web2-engine": null, "old-web2-rules": null };
for (let i = 2; i < process.argv.length; i++) args[process.argv[i].replace(/^--/, "")] = process.argv[++i];
const per = Number(args.per);
const imp = (p) => import(pathToFileURL(path.resolve(p)).href);

const rootNew = await imp(path.join(REPO, "engine", "engine.js"));
const rootOld = args["old-root"] ? await imp(args["old-root"]) : null;
const rootRules = JSON.parse(fs.readFileSync(path.join(REPO, "rules", "rules.compiled.json"), "utf8"));
const w2New = await imp(path.join(WEB2, "engine", "engine.js"));
const w2Rules = readRules();
const w2Old = args["old-web2-engine"] ? await imp(args["old-web2-engine"]) : null;
const w2OldRules = args["old-web2-rules"] ? JSON.parse(fs.readFileSync(args["old-web2-rules"], "utf8")) : null;
const personal = await imp(path.join(WEB2, "engine", "personal.js"));

const { songs } = loadCatalog({ dataRepo: args["data-repo"], quiet: true });
const noDur = songs.map((s) => ({ ...s, duration_ms: null }));
const lenMs = new Map(songs.map((s) => [s.song_id, s.duration_ms]));
const withDur = songs.filter((s) => s.duration_ms > 0 && s.duration_ms !== 210000).length;
console.log(`카탈로그 ${songs.length}곡 · 실제 길이 있는 곡 ${withDur}`);

const minOf = (ids) => ids.reduce((a, id) => a + (lenMs.get(id) || 0), 0) / 60000;
const DURS = [10, 15, 20, 30, 45, 60, 90];
const rows = [];
let ri = 0;
const r = () => u01(`duration-fit:${ri++}`);
for (const dur of DURS) {
  for (let k = 0; k < per; k++) {
    const inp = { now: { V: r(), A: r() }, target: { V: 0.15 + r() * 0.7, A: 0.15 + r() * 0.7 }, duration_min: dur, seed: `d${dur}:${k}` };
    const row = { dur };
    const ids = (res) => res.sequence.map((x) => x.song_id);
    row.root_nodur = minOf(ids(rootNew.recommend(noDur, rootRules, inp)));
    if (rootOld) row.root_old = minOf(ids(rootOld.recommend(songs, rootRules, inp)));
    row.root_new = minOf(ids(rootNew.recommend(songs, rootRules, inp)));
    const w2 = (E, R) => {
      const pin = { ...inp, personal: personal.neutralPolicy(R) };
      const res = E.recommend(songs, R, pin);
      const X = R.personalization.extras;
      const ex = E.recommendExtras(songs, R, pin, res, { target_sec: dur * 60 * X.fill_ratio });
      return minOf([...ids(res), ...ex.extras.map((x) => x.song_id)]);
    };
    if (w2Old) row.w2_old = w2(w2Old, w2OldRules);
    row.w2_new = w2(w2New, w2Rules);
    rows.push(row);
  }
  process.stderr.write(`${dur}분 완료\n`);
}

const cols = Object.keys(rows[0]).filter((k) => k !== "dur");
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x) => (x >= 0 ? "+" : "") + x.toFixed(1);
console.log("\n요청 시간별 (실제 − 요청, 분) 중앙값 [10%·90%] · |오차| ≤ 2분 비율");
console.log(["요청", ...cols].join("\t"));
for (const dur of [...DURS, "전체"]) {
  const rs = rows.filter((x) => dur === "전체" || x.dur === dur);
  console.log([String(dur), ...cols.map((c) => {
    const e = rs.map((x) => x[c] - x.dur);
    const ok = e.filter((v) => Math.abs(v) <= 2).length / e.length;
    return `${f(q(e, 0.5))} [${f(q(e, 0.1))}·${f(q(e, 0.9))}] ${Math.round(ok * 100)}%`;
  })].join("\t"));
}
