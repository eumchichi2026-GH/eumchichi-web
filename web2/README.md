# web2 — 음치치 개인화판 AZT (web-personal)

음악을 통한 대학생 맞춤형 스트레스 관리 시스템의 **개인화 실험 앱**입니다.
배포 앱(이 저장소 루트, 이하 web)과 같은 Firestore(`eumchichi-5a1cd`)를 쓰되, 로그인 사용자에게는 플레이리스트를 만드는
모든 절차(속도·곡 취향·첫 곡·곡 사이 연결·길이·도착 구간·빼는 곡·다양성 …)가 그 사람의 기록으로 조정됩니다.
설계·불변식·수용 기준은 [`docs/personalization_spec_20260927.md`](docs/personalization_spec_20260927.md)(동결 명세)가 기준입니다.

- **출처**: 로컬 저장소 `web-personal` 커밋 `c8097f5`(2026-09-30, 개인화 2차 수정 완료·재검증)를 이 폴더로 옮겼습니다.
  web 저장소 안에서 혼자 돌도록 기준 사본·데이터 저장소 찾기를 바꾸고 쓰지 않던 파일(`deam_anchors/`, `va_distribution.html` — web 루트에 그대로 있음)을 뺐습니다.
  엔진·규칙은 `c8097f5` 그대로이고, 앱은 web 배포의 하위 경로(`/web2/`)에서 운영 Firestore 에 쓰지 않도록 배포 설정 세 곳만 고쳤습니다
  (`env.js` 하위 경로 가드 · `index.html` 은 env.js 를 못 읽으면 쓰기 끔 · `manifest.webmanifest` 상대 주소 — 아래 "배포 주의").
- **web 과의 관계**: 2026-09-24 fix-web `76e8bdf`(엔진 2.5.1 · 규칙 v2.4.0)에서 갈라졌습니다.
  web main 은 그 뒤 fix-web `24c16d9`(엔진 2.6.1 · 규칙 v2.6.0)로 나아갔고, 그 변경 —
  **곡 수 상한 9 → 40·실제 길이로 재조정, 더 들을 곡 삭제, μ(pref_weight) 0 → 1.0 일괄** — 은 web2 에 **아직 반영되지 않았습니다**.
  두 쪽 설계가 부딪히는 곳(더 들을 곡·μ 방식)이 있어 합칠 방향은 팀 결정입니다.
- **불변식 I0**: 개인 정책이 없으면(익명·개인화 끔) 엔진 출력이 2.5.1 과 같습니다. 중립 정책이면 곡 순서가 같습니다(I1).
- 기록에는 `app:"web-personal"` 이 붙고, 새 사용자 상태는 `users/{uid}.wp_personal_v1` 한 필드뿐입니다(새 컬렉션·보안규칙 변경 없음).
- 시뮬레이터·데모의 모든 학습 수치는 **합성 사용자** 기준입니다. 실제 효과는 로그가 쌓인 뒤 잽니다.

## 폴더 구조

| 경로 | 내용 |
|---|---|
| `index.html` | 앱 전체 (Firebase Auth/Firestore · 추천 · 내 방 「내 취향 모델」 패널 · Spotify 연속재생). Firestore 쓰기는 모두 `fsWrite` 한 곳을 지난다 |
| `env.js` | 배포용 실행 설정(`env:"prod"`, `writes:true`, `sw:true`). 로컬 주소나 하위 경로(`/web2/` 등)에서 열리면 스스로 쓰기·서비스워커를 끈다 |
| `local_firebase.js` | 로컬 기본 실행의 Firebase 대역 — 로그인·Firestore 없이 곡은 `/api/local-catalog` 에서 |
| `engine/engine.js` | 추천 엔진 2.6.0-wp — `inputs.personal` 이 없으면 2.5.1 과 같은 출력 |
| `engine/personal.js` | 로그 → 개인 모델 → 정책 (p1.0.0, 순수 ESM — 앱과 시뮬레이터가 같은 코드) |
| `engine/test/` | 단위 시험 177개 (작은 합성 카탈로그 — 데이터 저장소 없이 돈다) |
| `rules/rules.compiled.json` | 규칙 v2.5.0-wp · `rules_hash` 60a437141e39. 숫자는 전부 여기(`personalization` 절, 값마다 근거 문자열) |
| `api/gemini.js` · `api/soundiiz.js` | Vercel 서버리스 함수 (API 키는 저장소에 없다) |
| `server.mjs` | 로컬 개발 서버 (아래) |
| `data/` | 연주곡 판정 뒤집기 목록 · 내보내기용 곡 표기 |
| `demo/personas/` | 데모 프로필 P0–P13 (합성 사용자 10세션 기록, `?demo=<id>`) |
| `tools/sim/` | 카탈로그 로더 · 회귀 · 정적 검사 · 재현 · 시뮬레이터 (Node 24 내장 모듈만, `package.json` 없음) |
| `tools/sim/baseline/` | **기준 사본** — fix-web `76e8bdf` 의 엔진 2.5.1 · 규칙 v2.4.0 · index.html ([출처](tools/sim/baseline/README.md)) |
| `tools/sim/fixtures/` | 브라우저·Node 일치 확인용 픽스처 20개 (`?fixture=<이름>`) |
| `tools/rules_hash.mjs` 외 | 규칙 해시 · 정성 피드백 내려받기·분류 (fix-web 에서 온 도구) |
| `docs/` | 명세 · 평가 보고서 |
| `change.md` | 수정 기록 (맨 위가 최신) |
| `sw.js` · `pwa.js` · `manifest.webmanifest` · `icons/` | PWA — 서비스워커 캐시 이름 `azt-personal-v1`(web 의 `azt-v9` 와 따로) · manifest `id` `/web-personal`(web 의 `/` 와 따로), `start_url`·`scope` 는 상대 주소 |

## 준비

- **Node 24** — 내장 모듈만 씁니다(`npm install` 없음). 아래 명령은 모두 **이 폴더(`web2/`)에서** 실행합니다.
- **데이터 저장소 `eumchichi-data` 클론** — 로컬 서버의 곡 목록·시뮬레이터·회귀·`check.mjs` 가 카탈로그 CSV 를
  `git -C <eumchichi-data> show origin/master:data/processed/…` 로 **메모리에만** 읽습니다(파일을 남기지 않음, 작업 트리는 일부러 낡아 있음).
  찾는 순서(`tools/sim/data_repo.mjs`):
  1. `--data-repo <경로>` → 환경변수 `AZT_DATA_REPO`
  2. `<web2>/../eumchichi-data` (옛 단독 배치 — `구글캡디/web-personal` 옆)
  3. `<web2>/../../eumchichi-data` (web 저장소 안 — `구글캡디/eumchichi-web/web2` 에서 `구글캡디/eumchichi-data`)

  못 찾으면 `AZT_DATA_REPO` 를 알려 주며 멈춥니다. 다른 곳에 두었다면:

  ```powershell
  $env:AZT_DATA_REPO = "C:\Users\<사용자>\Desktop\구글캡디\eumchichi-data"
  ```

## 로컬 실행 — `server.mjs`

```bash
node server.mjs                      # http://localhost:5180/  운영 Firebase 접속 안 함 · Firestore 쓰기 꺼짐
node server.mjs --port 5181 --debug  # 다른 포트, 요청마다 로그
node server.mjs --firebase           # 운영 Firebase 에 로그인해 곡을 읽는다(쓰기는 여전히 꺼짐)
node server.mjs --firebase --writes  # ⚠ 운영 Firestore 에 실제로 쓴다 — 필요할 때만
node server.mjs --data-repo <경로>   # 데이터 저장소 직접 지정
node server.mjs --help
```

- **기본은 운영 Firebase 미접속·쓰기 끔**: `/env.js` 가 `{ app:"web-personal", env:"local", writes:false, sw:false, personal:true, offline:true }` 를 준다.
  앱은 `local_firebase.js` 대역을 써서 로그인 없이 돌고, 곡 목록은 `/api/local-catalog`(데이터 저장소 4,117곡)에서 받는다.
  쓰기는 `console.info` 와 메모리(`SESSION_LOG`)에만 쌓인다. `--firebase` 는 `offline:false`, `--writes` 는 `writes:true`.
- `localhost` 에만 묶인다(Firebase 인증 승인 도메인 기본값). 포트 5180 은 web·fix-web 과 달라 서비스워커·캐시를 공유하지 않는다.
- `GET /api/health` — 엔진·규칙·personal 버전. `/api/gemini` · `/api/soundiiz` 는 `api/*.js` 핸들러를 그대로 부른다(본문 1MB 상한).
- 정적 파일은 이 폴더 안만, 점 파일(`.env`·`.git`)과 `..` 는 404, 캐시 없음(`no-store`).
- `GEMINI_API_KEY` 찾는 순서: `--env` 파일 → 이 폴더의 `.env` → 데이터 저장소의 `.env` 에서 그 키 하나만 실행 중 메모리로.
  키 값은 어디에도 출력·복사하지 않는다. `.env*` 는 `.gitignore` 에 있다(공개 저장소).
- **데모 모드** `http://localhost:5180/?demo=P1` — `demo/personas/P1.json`(합성 사용자 10세션)을 메모리에 올려 「데모 프로필(합성 사용자)」로 보여 준다.
  P0–P13 을 고를 수 있다(P1 재즈·빠르게 · P2 연주곡·천천히·보컬 전환 민감 · P3 K-발라드·가사 거슬림 · P5 벽 아이유 · P13 옛 기록만 …, 이름은 `tools/sim/personas.mjs`).
  **모든 Firestore 쓰기가 꺼지고**, 새 추천·응답은 메모리에만 쌓여 모델이 바로 다시 만들어진다.
- `?personal=0` 은 개인화를 끈 화면(기본 추천과 같은 경로, I0). `?fixture=P1_s06` 은 개발 픽스처 페이지(H2).
- 끄기: 터미널에서 `Ctrl+C`.

## 시험 · 회귀 · 정적 검사

```bash
node --test "engine/test/*.test.mjs"                               # 단위 시험 177개 (약 40초, 데이터 저장소 불필요)
node tools/sim/check.mjs                                           # 데이터 안전·정적 검사 12개 — 매 병합 전
node tools/sim/check.mjs --quick                                   # 엔진 실측(trace 키) 빼고
node tools/sim/regress.mjs --grid all --check all                  # 회귀 I0·I1 전부 — 1,959 시나리오, 이 노트북 약 12분
node tools/sim/regress.mjs --grid iso1224 --check i0 --limit 100   # 빠른 확인
node tools/rules_hash.mjs                                          # 규칙 해시 확인 (규칙을 고친 뒤에는 --write)
```

- **회귀** `regress.mjs` — 기준은 [기준 사본](tools/sim/baseline/README.md)의 엔진 2.5.1 + 규칙 v2.4.0(임시 파일로 import → 바로 삭제),
  대상은 이 폴더의 엔진 2.6.0-wp + 규칙 v2.5.0-wp + `personal.js`. 두 엔진에 같은 4,117곡을 넣는다.
  - 격자: `iso1224`(감정 17 × 목표 8 × 15·30·60분 × 시드 3) · `adj660`(지금 칩 11 × 목표 칩 6 × 15·30분 × 시드 5) · `probe`(가상 사용자 5 × μ 3 × 시드 5).
  - 검사: `i0`(personal 없음·null — 버전·해시 필드만 빼고 JSON 동일) · `i0off`(personalization.enabled=false 면 정책을 넣어도 동일) ·
    `pace`(속도 버튼 = 옛 앱 PACE_TP 규칙 사본) · `i1`(neutralPolicy — 곡 순서·2.5.1 trace 값 동일) · `affinity`(aggregateAffinity 2인자, 무작위 항목 200).
  - **불일치 1건이면 멈추고 첫 차이를 출력, exit 1.** 여러 스레드로 돈다(`--workers N`, 기본 코어 수 − 2).
- **정적 검사** `check.mjs` — engine/*.js 에 `Math.random`·`Date.now` 없음 · rules_hash 일치 · `personalization` 절이 명세 §10 키를 모두 가짐 ·
  trace_keys ⊇ p_* 키(엔진 실측) · 모든 Firestore 쓰기가 `fsWrite` 안 · 새 컬렉션 없음 · 기준 사본 3개가 `76e8bdf` 원본과 같은 blob ·
  `song_stats` 키 7개 안 · 앱에 규칙 숫자 사본 없음 · `sw.js` VERSION ≠ `azt-v9` · env.js 로드 순서·로컬 서버 `writes:false`·`offline:true` ·
  정적 env.js 를 주소별로 실행해 쓰기가 배포 루트에서만 켜지는지(localhost·`/web2/` 하위 경로는 끔) · 외부 패키지 없음.
  앱과 도구의 곡 계약값 비교: 앱 콘솔 `AZT_DEBUG.dumpContract(ids)` 결과를 JSON 으로 저장해 `--app-contract <파일>`.

## 시뮬레이터 (합성 사용자)

```bash
node tools/sim/catalog.mjs                                         # 카탈로그 요약 — 4,117곡 · digest 33252b24
node tools/sim/run.mjs --personas P1,P2 --sessions 2 --reps 1 --arms wp,twin --h5-demo 0 --out <임시 폴더>/smoke.md   # 짧은 점검(약 30초)
node tools/sim/run.mjs --personas all --sessions 10 --reps 5 --arms wp,twin,frozen --grid --json         # 공식 실행 → docs/personal_eval_<날짜>.md
node tools/sim/replay.mjs --recs demo/personas/P1.json             # 추천 로그 재현 일치율 (§11 H3)
```

- 팔: `wp`(web-personal 학습) · `twin`(fix-web `76e8bdf` 재현 — 기준 사본 엔진 + 옛 앱 규칙) · `frozen`(학습 없이 P0 정책 고정).
  페르소나 숫자는 `tools/sim/personas.mjs` 한 곳에 있다.
- `--out` 을 주지 않으면 보고서가 `docs/personal_eval_<날짜>.md` 로 쓰인다(`--json` 원자료는 크고 `.gitignore` 대상). 점검 실행은 OS 임시 폴더로 보내 저장소에 남기지 않는다.
  `--out` 은 이 폴더 안이나 OS 임시 폴더만 받는다.
- 짧은 점검은 표 대부분이 "측정 안 됨"으로 불합격인 것이 정상이다(세션 기록 오류 0 인지만 본다). `--h5-demo 0` 을 빼면
  판정 밖 B8 진단(데모 프로필 P0–P13 × 입력 24개)이 붙어 이 노트북에서 약 12분 더 걸린다.
- 공식 실행은 전체 격자·H5 측정·B8 진단까지 해 30분 넘게 걸린다. 스윕(`sweep.mjs`)·데모 프로필 다시 만들기(`demo_personas.mjs`)·
  외부 측정 합치기(`external.mjs`)·진단(`diag_*.mjs`, `bench_h5.mjs`)은 각 파일 머리 주석에 사용법이 있다.
- **재현** `replay.mjs` — 추천 문서의 `personal_policy`·`user_affinity`·입력으로 다시 돌려 경로 곡 순서가 같은지 본다.
  카탈로그 digest·rules_hash·엔진 버전이 지금과 다르면 건너뛴다(`--ignore-digest` · `--ignore-versions`).

## 현재 상태 (2026-09-30, `c8097f5` 기준 · 모든 수치 합성 사용자)

- 단위 시험 177/177 · 회귀 1,959 시나리오 모두 일치(I0·I1 초록) · `check.mjs` 모두 통과 · H3 재현 140/140.
- **합성 사용자 공식 5반복(65행): 합격 52 · 불합격 13** (1차 평가 49 · 16). 불합격 D3 · D4 · D5·P3 · D5·P5 · D6 · D7 · D8 · D10 · E1 · E6 · E7 · F4 · J.
  자세한 표는 [`docs/personal_eval_20260928.md`](docs/personal_eval_20260928.md)(평가자 요약 2026-09-30 재측정 — 평가자 판정은 D2 를 명세 반복 수로 봐 51 · 14),
  원인은 [`change.md`](change.md) 맨 위.
- 남은 문제 (`change.md` 맨 위 요약):
  - **경계**: D6 '높음' 5.2%(≤ 5%, 10반복 4.7%) · E7 대조군 Δ넘김 +0.043(≤ 0.03, 10반복 +0.024) — 5반복은 추첨에 흔들려 D·E 판정은 10반복을 권함.
  - **D10** 첫 곡 넘김: 오프셋 자체는 효과가 있지만 기대값으로도 문턱과 거의 같다. 방향 없는 `mood_mismatch`("덜 멀다")를 "너무 멀다"로 읽는 해석이 팀 결정.
  - **F4** 교차 오염: 10세션 뒤 장르 배수 1.6–2.0 이 켜진다(F2 는 92.7% 로 통과하지만 세션이 늘면 커질 수 있음). q 재계산 또는 θ_m 재적합은 명세 결정.
  - **E1·E6** 조기 넘김(지금 ×0.92–0.95, 목표 ×0.85): 참 취향을 엔진에 줘도 ×0.834 라 여지가 작다. 취향 없는 페르소나의 넘김은 대부분 완주율 추첨에서 나온다.
  - **D3·D7·D8** 은 합성 시험의 자극 부족(큰 빠르기 변화 쌍 부족 · 최근 창 60 이 반복을 미리 막음 · 다시 넣을 곡이 코리도어 밖), **D4 ↔ D5·P2** 는 서로 충돌,
    D5·P3 은 경계(68–71%, 필요 73–74%), D5·P5 는 아이유 곡이 코리도어 안에 드물다.
  - 팀 결정 목록: `adjacency.scale` 0.25 / 0.5 절충 · D4 와 D5·P2 · D3·D7·D8 시험 설계 · D11 판정 폭 · E1 목표 · F4 · `vocal_bother_min` 2 → 1 · J(배포 전 사람이 하는 수동 점검).

## 페르소나 체험 기록 (P1·P2, 2026-09-30)

`server.mjs` 데모 모드(운영 Firebase·기록 저장 없음)에서 합성 사용자 P1(재즈 선호·빠르게)과 P2(연주곡 선호·천천히·보컬↔연주 전환 민감)로
가입 직후부터 6번씩 써 봤습니다(감상 30분, 청취 반응은 `tools/sim/behavior.mjs` 가 만든 합성 기록). 두 사람 모두 속도는 두 번의 답 만에 배워
(P1 π 0 → 0.55, 5회부터 도착 5번째 곡 · P2 π 0 → −0.52, 3회부터 7번째 곡) 6회 내내 안전 폴백이 없었습니다. P2 는 연주곡 취향(경로의 연주곡 1회 2/8 → 4회 8/8)과
보컬↔연주 전환 배수(×2.0)까지 배웠지만, P1 은 6회 48곡 중 재즈가 한 곡도 나오지 않아 취향을 참값과 다르게(빠르기 중간·록·메탈) 잡았습니다 —
들려준 적 없는 취향은 배울 수 없어, 좋아할 만한 장르를 가끔 떠보는 탐색이 필요합니다. 같은 입력의 1회 → 6회 결과는 둘 다 나아지지 않았습니다
(P1 초반 넘김 4 → 3곡·평균 청취 44 → 33%, P2 1 → 3곡·62 → 58%). 고칠 것으로 드러난 것: 기록이 없는 새 사용자에게도 "비슷한 후보 N곡 중 취향에 맞춰 골랐어요"가 뜸 ·
P2 의 거짓 장르 전환 배수(×1.70, F4 와 같은 문제)와 연주/보컬 재즈가 한 장르 묶음으로 섞임 · 속도 칩("7번째 곡")과 감정 지도 문구("6번째 곡부터") 불일치 ·
패널 진단 줄의 소수 그대로 표기("근거량 E 20.35858013").

## 배포 주의 (Vercel)

- web2 는 web 저장소의 **하위 폴더**입니다. 배포하려면 **별도 Vercel 프로젝트**를 만들고 **Root Directory = `web2`** 로 두세요.
  그래야 `web2/api/*.js` 가 서버리스 함수로 동작하고(Vercel 은 루트의 `api/` 만 함수로 본다), 앱이 도메인 루트에서 돌아
  `/sw.js`·`/api/…`·manifest scope `/` 가 web 의 것과 겹치지 않습니다.
- ⚠ web 의 기존 Vercel 프로젝트(main push = 즉시 배포)는 저장소 루트를 배포하므로, 이 폴더가 main 에 들어가면 `/web2/` 아래에도 정적 파일로 올라갑니다.
  그 주소에서는 API(`/api/…`)·서비스워커(`/sw.js`)가 web 의 것이라, 이 폴더는 스스로 **읽기 전용 미리보기**로만 돕니다:
  - `env.js` 가 도메인 루트(`/`, `/index.html`)가 아닌 경로에서 열리면 Firestore 쓰기·서비스워커를 끕니다(`subpath:true`, 콘솔 경고).
    web 의 서비스워커 등록은 건드리지 않습니다.
  - 슬래시 없는 `/web2` 로 열려 상대 주소가 web 루트를 가리키면(env.js 를 못 읽음) `index.html` 이 쓰기·서비스워커를 끈 채로 돕니다.
  - manifest 는 `id` 가 `/web-personal` 이고 `start_url`·`scope` 가 상대 주소라, `/web2/` 에서 설치해도 web 앱(`id` `/`)과 섞이지 않고 `/web2/` 를 엽니다.
  
  그래도 이 경로는 운영용이 아닙니다(로그인·곡 읽기는 운영 Firebase 에서 일어남). 아예 올리지 않으려면 web 쪽 배포에서 `web2/` 를 빼는 설정을 팀과 정하세요.
  `node tools/sim/check.mjs` 의 `env` 검사가 이 가드를 주소별로 확인합니다.
- `env.js` 는 운영값(`env:"prod"`, `writes:true`, `sw:true`)입니다. 도메인 루트에 배포하면 web 과 **같은 Firestore 에 `app:"web-personal"` 로 기록**됩니다
  (추천 문서·이벤트, `users/{uid}.wp_personal_v1`). 로컬 주소(localhost 등)·하위 경로에서 열리면 스스로 쓰기·서비스워커를 끕니다.
- Settings → Environment Variables 에 `GEMINI_API_KEY` 를 등록하세요(`api/gemini.js`).
- 배포 도메인을 Firebase 콘솔 → Authentication → **승인된 도메인**에 추가하세요.
- 수용 기준 J(앱 수동 점검)는 배포 전에 사람이 합니다.

## 문서

- [`docs/personalization_spec_20260927.md`](docs/personalization_spec_20260927.md) — 구현 명세(동결). 줄 번호는 `76e8bdf` 기준 = [`tools/sim/baseline/index_76e8bdf.html`](tools/sim/baseline/index_76e8bdf.html)
- [`docs/personal_eval_20260928.md`](docs/personal_eval_20260928.md) — 합성 사용자 평가 보고서(도구 출력 + 2026-09-30 평가자 요약)
- [`change.md`](change.md) — 수정 기록(1차·2차 수정, 재검증, 팀 결정 목록)
- [`tools/sim/baseline/README.md`](tools/sim/baseline/README.md) — 기준 사본의 출처

## 보안 메모

- Firebase 설정값(apiKey 등)은 공개되어도 되는 값 — 실제 접근 제어는 Firestore 보안규칙 + Authentication 이 담당합니다.
- Gemini 키는 서버에만 있습니다. 프록시는 허용 action 2개, 서버 고정 프롬프트, 입력 길이 제한으로 도용을 막습니다.
- 로컬 `.env*` 는 커밋하지 않습니다(`.gitignore`). `server.mjs` 는 키를 출력하지 않고, 점 파일 요청은 404 입니다.
