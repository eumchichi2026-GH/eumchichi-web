# 기준 사본 — fix-web `76e8bdf` (2026-09-24)

회귀(I0·I1)·fix-web 쌍둥이(`twin` 팔)·엔진 단위 시험이 비교 기준으로 쓰는 **고정 파일**입니다. 고치지 마세요.

| 이 폴더 | 원본 (`76e8bdf` 트리) | 내용 | git blob id |
|---|---|---|---|
| `engine_2.5.1.js` | `engine/engine.js` | 추천 엔진 `ENGINE_VERSION` 2.5.1 | `1cb99f9fefce4dbdfafc3a475eabaaed4362e1ab` |
| `rules_v2.4.0.json` | `rules/rules.compiled.json` | 규칙 v2.4.0 (`rules_hash` 7a9dc8823c84) | `ab56a9f0770a98b37cb831cfdf631e5bb58d11af` |
| `index_76e8bdf.html` | `index.html` | 앱 상수표(감정·목표 칩, `PACE_TP`, 장르 규칙)·컬렉션 이름 | `27aa876e40de996fc78e7959c38621b54ce4be92` |

## 출처

- 커밋 `76e8bdfbe20feea78316b3b7e592634fe834327d` — fix-web(`github.com/eumchichi2026-GH/fix-web`) main, 2026-09-24 22:45 (+09:00).
  web-personal(개인화판)은 이 커밋을 복제해 시작했고, 명세(`docs/personalization_spec_20260927.md`)의 줄 번호·불변식 I0 이 모두 이 커밋 기준입니다.
- 이 커밋은 web 저장소(`eumchichi-web`)에는 없습니다. 그래서 web2 로 옮기면서 `git show 76e8bdf:…` 대신 이 사본을 읽게 바꿨습니다(2026-09-30).
- 옮긴 방법 — web-personal 클론에서 blob 을 그대로 꺼냈습니다(줄바꿈 LF):

  ```bash
  git -C <web-personal 클론> cat-file blob 76e8bdf:engine/engine.js          > engine_2.5.1.js
  git -C <web-personal 클론> cat-file blob 76e8bdf:rules/rules.compiled.json > rules_v2.4.0.json
  git -C <web-personal 클론> cat-file blob 76e8bdf:index.html                > index_76e8bdf.html
  ```

## 누가 읽나

- `tools/sim/baseline.mjs` — `loadBaseline()`: 엔진 사본을 OS 임시 파일(`.mjs`)로 써서 import 한 뒤 바로 지웁니다. 규칙은 JSON 으로 읽습니다.
- `tools/sim/app_tables.mjs` — `loadAppTablesAt("76e8bdf")`: `index_76e8bdf.html` 에서 앱 상수표를 앵커로 떼어 옵니다(격자·쌍둥이·회귀 pace 검사).
- `tools/sim/lib_env.mjs` — `baseline.mjs` 를 못 부를 때의 대체 로더(같은 사본).
- `tools/sim/check.mjs` — `collections`(새 컬렉션 0) 검사와 `baseline-copy` 검사. 후자는 세 파일의 git blob id 가 위 표와 같은지 봅니다
  (CRLF 는 LF 로 맞춰 계산하므로 윈도 체크아웃에서도 같은 값).
- `engine/test/engine_fixture.test.mjs` — 엔진 단위 시험의 기준 엔진(I0 시험).
