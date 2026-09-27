# 음치치 데모 웹앱 — web-personal (개인화판)

음악을 통한 대학생 맞춤형 스트레스 관리 시스템 — fix-web 을 복제한 **개인화 실험 앱**.
같은 Firestore(`eumchichi-5a1cd`)를 쓰되, 로그인 사용자에게는 플레이리스트를 만드는 모든 절차가 그 사람의 기록으로 조정된다.
설계·불변식·수용 기준은 [`docs/personalization_spec_20260927.md`](docs/personalization_spec_20260927.md)(동결 명세)가 기준이다.

## 구조

- `index.html` — 데모 전체 (Firebase Auth/Firestore + 추천 + Spotify 연속재생). Firestore 쓰기는 모두 `fsWrite` 한 곳을 지난다
- `engine/engine.js` — 추천 엔진(2.6.0-wp). `inputs.personal` 이 없으면 2.5.1 과 같은 출력(I0)
- `engine/personal.js` — 로그 → 개인 모델 → 정책 (순수 ESM, 앱과 시뮬레이터가 같은 코드를 쓴다)
- `rules/rules.compiled.json` — 규칙(숫자는 전부 여기, `personalization` 절에 근거 문자열과 함께)
- `api/gemini.js` · `api/soundiiz.js` — Vercel 서버리스 함수. **API 키는 이 저장소에 없다**
- `server.mjs` — 로컬 개발 서버 (아래)
- `tools/sim/` — 카탈로그 로더·회귀·정적 검사·재현·시뮬레이터 (Node 24 내장 모듈만, `package.json` 없음)

## 로컬 실행 — `server.mjs`

```bash
node server.mjs                      # http://localhost:5180/  (Firestore 쓰기 꺼짐)
node server.mjs --port 5181 --debug  # 다른 포트, 요청마다 로그
node server.mjs --writes             # ⚠ 운영 Firestore 에 실제로 쓴다 — 필요할 때만
node server.mjs --env ../my.env      # .env 파일 직접 지정
```

- `localhost` 에만 묶인다(Firebase 인증 승인 도메인 기본값). 포트 5180 은 fix-web 과 달라 서비스워커·캐시를 공유하지 않는다.
- `GET /env.js` 가 `window.AZT_ENV = { app:"web-personal", env:"local", writes:false, sw:false, personal:true, debug:false }` 를 준다.
  **로컬은 기본으로 쓰기 끔** — 쓰기는 `console.info` 와 메모리(`SESSION_LOG`)에만 쌓인다. `--writes` 를 줄 때만 `writes:true`.
  저장소의 정적 `env.js` 는 배포용(`env:"prod"`) 값이다.
- `/api/gemini` · `/api/soundiiz` 는 `api/*.js` 핸들러를 그대로 부른다(본문 1MB 상한). `GET /api/health` 로 엔진·규칙·personal 버전 확인.
- 정적 파일은 저장소 루트 안만, 점 파일(`.env`·`.git`·`.claude`)과 `..` 는 404, 캐시 없음(`no-store`).
- `GEMINI_API_KEY` 찾는 순서: `--env` 파일 → 이 저장소 `.env` → 데이터 저장소(`../eumchichi-data/.env`)에서 그 키 하나만 실행 중 메모리로.
  키 값은 어디에도 출력하지 않는다. `.env*` 는 `.gitignore` 에 있다(공개 저장소).
- Claude Code 미리보기: `.claude/launch.json` 의 `web-personal` 설정(`node server.mjs`, 포트 5180).
- 끄기: 터미널에서 `Ctrl+C`.

## 시험 · 회귀 · 정적 검사 (저장소 루트에서)

```bash
node --test engine/test/                                   # 엔진·personal 단위 시험 (작은 합성 카탈로그)
node tools/sim/regress.mjs --grid all --check all          # I0·I1·속도·취향 집계 회귀 (§11 A1–A4)
node tools/sim/regress.mjs --grid iso1224 --check i0 --limit 100   # 빠른 확인
node tools/sim/check.mjs                                   # 데이터 안전 정적 검사 (§11 I) — 매 병합 전
node tools/sim/check.mjs --quick                           # 엔진 실행이 필요한 검사 빼고
node tools/rules_hash.mjs --write                          # 규칙을 고친 뒤 해시 갱신 (ENGINE)
```

- **회귀** `regress.mjs` — 기준은 `76e8bdf` 의 engine 2.5.1 + rules v2.4.0(`git show` → 임시 파일 import → 바로 삭제).
  격자: `iso1224`(감정 17 × 목표 8 × 15·30·60분 × 시드 3) · `adj660`(지금 칩 11 × 목표 칩 6 × 15·30분 × 시드 5) · `probe`(가상 사용자 5 × μ 3 × 시드 5).
  검사: `i0`(personal 없음·null — 버전·해시 필드만 빼고 JSON 동일) · `i0off`(personalization.enabled=false 면 정책을 넣어도 동일) ·
  `pace`(inputs.pace fast/slow = 옛 앱 PACE_TP 규칙 사본) · `i1`(neutralPolicy — 곡 순서·2.5.1 trace 값 동일) · `affinity`(aggregateAffinity 2인자, 무작위 항목 200).
  **불일치 1건이면 멈추고 첫 차이를 출력, exit 1.** 돌릴 수 없는 검사(export 없음)는 이름으로 요청하면 exit 2, `--check all` 이면 경고 후 건너뛴다.
  여러 스레드로 돈다(`--workers N`, 기본 코어 수 − 2). 전체는 엔진 약 1.8만 회 — 이 노트북(4코어)에서 15~20분(i0·pace·affinity 만 약 14분).
- **정적 검사** `check.mjs` — engine/*.js 에 `Math.random`·`Date.now` 없음 · rules_hash 일치 · `personalization` 절이 명세 §10 키를 모두 가짐 ·
  trace_keys ⊇ p_* 키 · index.html 의 모든 Firestore 쓰기가 `fsWrite` 안(계정 삭제 batch 만 예외) · 새 컬렉션 없음 · `song_stats` 키 7개 안 ·
  앱에 규칙 숫자 사본 없음 · `sw.js` VERSION ≠ `azt-v9` · env.js 로드 순서·로컬 서버 `writes:false` · 외부 패키지 없음.
  앱과 도구의 곡 계약값 비교: 앱 콘솔 `AZT_DEBUG.dumpContract(ids)` 결과를 JSON 으로 저장해 `--app-contract <파일>`.

## 시뮬레이터 · 스윕 · 재현 (합성 사용자)

```bash
node tools/sim/run.mjs --personas all --sessions 10 --reps 5 --arms wp,twin,frozen   # → docs/personal_eval_YYYYMMDD.md
node tools/sim/run.mjs --grid                                                       # 신규 사용자 기본 정책의 ISO 봉투·구성(§11 B·C)
node tools/sim/sweep.mjs --param adjacency.scale --values 0,0.5,1,1.5,2 --grid adj660,iso1224
node tools/sim/replay.mjs --recs <내보낸 추천 JSON> --catalog-ref origin/master      # 로그 재현 일치율 (§11 H3)
node tools/sim/catalog.mjs                                                          # 카탈로그 요약(곡 수·digest)
```

- 시뮬레이터 수치는 전부 **"합성 사용자"** 기준이다. 실제 효과는 로그가 쌓인 뒤(5단계) 잰다.
- 팔: `wp`(web-personal 학습) · `twin`(fix-web 76e8bdf 재현) · `frozen`(web-personal, 늘 빈 모델). 페르소나 숫자는 `tools/sim/personas.mjs` 한 곳.
- **카탈로그**는 데이터 저장소를 `git -C <eumchichi-data> show origin/master:data/processed/…` 로 **메모리에만** 읽는다(캐시 파일 없음, 작업 트리는 일부러 낡아 있음).
  경로 기본값은 이 저장소 옆 `../eumchichi-data`, 바꾸려면 `--data-repo <경로>` 또는 환경변수 `AZT_DATA_REPO`.
  연주곡 판정은 앱과 같게 `data/instrumental_overrides.json` → `v2_tag_instrumental ≥ 0.5`, 장르는 index.html 의 `GENRE_RULES` 를 앵커로 읽어 쓴다.
- **재현** `replay.mjs` — 추천 문서의 `personal_policy` · `user_affinity` · 입력으로 다시 돌려 경로 곡 순서가 같은지 본다.
  카탈로그 digest(`personal_meta.catalog_digest`)·rules_hash·엔진 버전이 지금과 다르면 건너뛴다(`--ignore-digest` · `--ignore-versions`).
  로그에 싫어요 목록이 없으므로 RawFacts 의 이벤트(추천 시각 기준) 또는 `--profile <users 문서 JSON>` 을 쓴다.

## 데모 모드

```bash
node tools/sim/demo_personas.mjs          # 페르소나 10세션 → demo/personas/<id>.json (합성 RawFacts)
node server.mjs                           # 그다음 http://localhost:5180/?demo=<페르소나 id>
```

- 상단에 "데모 프로필(합성 사용자)" 띠가 뜨고, **모든 Firestore 쓰기는 꺼진다**(결과는 메모리에만 쌓여 모델이 바로 다시 만들어진다).
- `?personal=0` 은 개인화를 끈 화면(기본 추천과 같은 경로, I0).

## 배포 (Vercel)

1. 이 저장소를 **fix-web 과 별도의** Vercel 프로젝트로 Import
2. Settings → Environment Variables 에 `GEMINI_API_KEY` 등록
3. 배포 도메인을 Firebase 콘솔 → Authentication → 승인된 도메인에 추가

`master`(또는 `main`)에 push 하면 자동으로 재배포된다. 배포본은 저장소의 정적 `env.js`(`env:"prod"`, `writes:true`, `sw:true`)를 쓴다.

## 보안 메모

- Firebase 설정값(apiKey 등)은 공개되어도 되는 값 — 실제 접근 제어는
  Firestore 보안규칙 + Authentication 이 담당
- Gemini 키는 서버에만 존재. 프록시는 허용 action 2개, 서버 고정 프롬프트,
  입력 길이 제한으로 도용을 방지
- 로컬 `.env*` 는 커밋하지 않는다(`.gitignore`). `server.mjs` 는 키를 출력하지 않고, 점 파일 요청은 404
- web-personal 이 쓰는 새 사용자 상태는 `users/{uid}.wp_personal_v1` 한 필드뿐이다(새 컬렉션·보안규칙 변경 없음)
