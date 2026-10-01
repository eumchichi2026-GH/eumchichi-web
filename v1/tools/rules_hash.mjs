/* rules.compiled.json 의 rules_hash 를 재계산한다.
 *
 * 왜 필요한가 —
 *   rules_hash 는 모든 추천 로그(`recommendations.algorithm_version`)에 박히는 값이라,
 *   규칙 내용이 바뀌었는데 해시가 그대로면 "어떤 규칙으로 뽑힌 추천인지" 구분이 사라진다.
 *   원래는 규칙 컴파일러가 찍던 값인데 컴파일러가 저장소에 없어서, 규칙을 손으로 고칠 때
 *   해시가 내용과 어긋나는 문제가 있었다. 이 스크립트가 그 자리를 메운다.
 *
 * 해시 정의 (2026-08-16 이후) —
 *   sha256( JSON.stringify(규칙, 키 정렬, rules_hash 필드 제외) ) 의 앞 12자리 hex.
 *   같은 내용이면 누가 언제 돌려도 같은 값이 나온다.
 *   ※ 그 이전 값(76edd8a3013c, 3347a588511c)은 옛 컴파일러가 찍은 것이라 이 정의로
 *      재현되지 않는다. 정의가 바뀐 시점을 CHANGES 에 남겨 둘 것.
 *
 * 사용:
 *   node tools/rules_hash.mjs           → 현재 해시와 계산된 해시를 비교만 (CI 용, 불일치면 exit 1)
 *   node tools/rules_hash.mjs --write   → 파일의 rules_hash 를 계산값으로 갱신
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "rules", "rules.compiled.json");

/* 키 순서·공백에 흔들리지 않게 정규화한다 — 배열 순서는 의미가 있으므로 보존한다. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === "rules_hash") continue;
      out[k] = canonical(v[k]);
    }
    return out;
  }
  return v;
}

const raw = fs.readFileSync(FILE, "utf8");
const rules = JSON.parse(raw);
const computed = crypto.createHash("sha256")
  .update(JSON.stringify(canonical(rules)), "utf8")
  .digest("hex").slice(0, 12);

const current = rules.rules_hash;
const write = process.argv.includes("--write");

if (current === computed) {
  console.log("rules_hash 일치: %s", computed);
  process.exit(0);
}
if (!write) {
  console.error("rules_hash 불일치 — 파일: %s / 계산: %s", current, computed);
  console.error("규칙을 고쳤다면 `node tools/rules_hash.mjs --write` 로 갱신하세요.");
  process.exit(1);
}
/* 원본 서식을 보존하기 위해 해당 줄만 치환한다 (JSON 재직렬화로 diff 를 키우지 않는다) */
const next = raw.replace(/("rules_hash"\s*:\s*")[^"]*(")/, `$1${computed}$2`);
if (next === raw) { console.error("rules_hash 필드를 찾지 못했습니다."); process.exit(1); }
fs.writeFileSync(FILE, next, "utf8");
console.log("rules_hash 갱신: %s → %s", current, computed);
