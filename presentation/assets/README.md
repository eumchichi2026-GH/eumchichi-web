# AZT 최종 발표 자료 (이미지 · 인포그래픽 · 시연 연결)

> 생성 2026-10-01 · 최종 발표 2026-10-07(수) 15:10, 발표 세션 1번 · 발표 5분 + 질의응답 3분 · 제출 10/3(토) 23:59 (ppt 또는 pdf, 16:9)

HTML로 만든 발표 자료에서 **시연까지 한 화면으로 바로 이어지도록** 쓰는 자료 모음이다.
색과 글꼴은 앱(web2 — 2026-10-01부터 저장소 루트 `index.html`의 `:root`: 먹색 `#161616`, 주황 `#E8763C`, Pretendard)과 같게 맞췄다.
그래서 마지막 슬라이드에서 앱 화면으로 넘어가도 톤이 끊기지 않는다.

| 경로 | 내용 |
|---|---|
| `svg/` | 인포그래픽 18종 (1600×800, 표지만 1000×800 · 사용 후기 문항만 1600×520) + QR 2종 |
| `png/` | 위 인포그래픽을 Pretendard로 그린 이미지 (가로 1920px). PDF 제출본이나 이미지로만 넣을 때 쓴다 |
| `screens/` | 배포된 web2 데모 모드(`?demo=P1`) 실제 화면 캡처. 데스크톱 12장(1440×810 @2x), 모바일 4장(390×844 @3x) |
| `figures.js` | 인포그래픽 전부를 담은 스크립트. `file://`로 열어도 동작한다 |
| `figures.json` | 그림 목록(제목, 추천 슬라이드, 설명, 크기) |
| `demo_slide.html` | 표지 → 시연 시나리오 → **실제 앱(iframe)** 으로 넘어가는 3장짜리 예시 덱 |
| `tools/` | 다시 만드는 스크립트 (Node 24 내장 모듈과 헤드리스 Edge만 사용) |

## 5분 발표 흐름 추천

안내문의 작성 가이드 7개 항목과 평가 기준(창의성 25 · 성과·완성도 35 · 검증·신뢰성 20 · 기대효과 20) 순서를 따랐다.

| 순서 | 시간 | 슬라이드 | 쓸 자료 |
|---|---|---|---|
| 1 | 0:00 | 표지 · 팀 소개 | `cover_path` (경로가 그려지는 애니메이션), `team_roles` |
| 2 | 0:20 | 문제 정의 | `problem_survey73` |
| 3 | 0:45 | 기존 서비스와의 차이 (ISO 원리) | `iso_concept` |
| 4 | 1:15 | 서비스 구조와 AI 활용 | `system_architecture`, `korean_valence_fix`, `data_pipeline` |
| 5 | 2:00 | 개발 과정 · 의사결정 | `version_timeline`, `survey_to_redesign`, `post_use_items` |
| 6 | 2:40 | 최종 결과물: ver2 개인화 | `web2_12_steps`, `web2_safety`, `screens/screen_model_panel.png` |
| 7 | 3:10 | **시연** | `demo_scenario` → 실제 앱 (`demo_slide.html` 3번째 장) |
| 8 | 4:10 | 검증 | `post_use_stress`(실측), `engine_reeval45`(실측 요청), `parameter_evidence`(실험), `web2_validation`(합성 사용자) |
| 9 | 4:40 | 기대효과 · 확장 | `expected_effects` |

## 쓰는 법

### 1) 인포그래픽을 HTML 덱에 넣기 — `figures.js` (권장)

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
...
<div data-azt-fig="iso_concept"></div>
...
<script src="assets/figures.js"></script>
<script>AZTFigures.mountAll();</script>
```

- SVG가 페이지 안에 직접 들어가서 덱의 Pretendard가 그대로 적용되고, 화면 크기에 맞춰 선명하게 늘어난다.
- 표지 애니메이션은 그림을 넣을 때마다 처음부터 다시 돈다. 슬라이드에 들어올 때 `AZTFigures.mount(el)`을 다시 부르면 된다(`demo_slide.html` 참고).
  인쇄할 때와 운영체제의 '동작 줄이기' 설정에서는 완성된 그림으로 보인다.
- `<img src="svg/….svg">`로 넣어도 되지만, 이 방식에서는 웹 글꼴을 못 읽어 맑은 고딕으로 보인다.

### 2) PDF 제출본 · 이미지로만 넣기 — `png/`

안내문은 html로 발표하더라도 **16:9 pdf를 따로 제출**하라고 한다. 덱을 Chrome/Edge에서 열고 인쇄 → PDF로 저장하면 된다.
`demo_slide.html`의 인쇄 스타일은 슬라이드마다 1920×1080 한 쪽씩 뽑고, 시연 장에는 iframe 대신 캡처 화면을 넣는다.
인쇄 대화상자에서 '배경 그래픽'을 켜야 한다.

### 3) 시연으로 이어지기 — `demo_slide.html`

- 마지막 장은 무대(1920×1080)가 아니라 **창 전체에 실제 앱을 iframe으로 띄운다.** 앱이 제 해상도로 그려진다.
  배포 주소는 iframe 삽입을 막지 않는다(`X-Frame-Options` 없음, 2026-10-01 확인).
- **시연 바로 앞 장에 오면 앱을 미리 불러 둔다.** 시연 장에서 로딩을 기다리지 않는다.
- 앱 안을 클릭하면 키보드 입력이 앱으로 간다. 발표로 돌아올 때는 왼쪽 아래 **「← 발표로」** 버튼을 누른다.
- `F` 키는 전체 화면이다. 인터넷이 없으면 Pretendard 대신 맑은 고딕으로 보인다.
- 시연 주소는 파일 위쪽의 `DEMO_URL` 한 줄이다.
  - 기본값 `https://eumchichi-web.vercel.app/?demo=P1`(10/1 web2 가 루트로 올라옴 — 예전 `/web2/?demo=P1` 도 여기로 넘어감): ver2 데모 프로필(합성 사용자 P1의 기록 10회로 개인화된 상태, **기록은 저장되지 않음**). 첫 화면부터 「이번 추천에 반영된 나」와 「기본 추천과 비교」를 보여 줄 수 있다.
  - 실제 계정으로 시연하려면 `?demo=P1` 을 뺀 앱 루트(`https://eumchichi-web.vercel.app/`)로 바꾼다. 로그인 창이 iframe 안에서 막힐 수 있으니 리허설에서 꼭 확인한다.

**시연 전에 확인할 것**
- 발표장 Wi-Fi에서 Gemini 해석(「AI로 읽기」)이 응답하는지. 당일 12~14시 확인 시간을 쓴다. 휴대폰 테더링을 예비로 준비한다.
- 앱은 열 때마다 운영 Firestore에서 곡 4,117개를 읽는다(무료 한도로 하루 약 12회). **발표 당일 리허설은 2~3번으로 줄인다.** 덱은 시연 직전 장에서 한 번만 불러온다.
- 인터넷이 끊기면 `screens/`의 캡처로 대신한다(`screen_input.png` → `screen_result_compare.png` → `screen_emotion_map.png` → `screen_model_panel.png` 순서).
- 시나리오 문장: 「내일 발표라 너무 떨리고 긴장돼요. 차분해지고 싶어요.」 → Gemini가 「긴장돼요(아주) → 차분해지고 싶어요」로 읽는다(10/1 실측).
  `demo_scenario`의 「8곡 중 7곡이 바뀜」은 10/1 실행 결과라 당일 숫자는 다를 수 있다(그림에 '예시'로 적어 둠).

## 숫자 출처

| 그림 | 숫자 | 출처 |
|---|---|---|
| `problem_survey73`, `expected_effects` | 77 · 61 · 62 · 84 · 56 · 78% | 사전 설문 n=73 (2026.8) — 포스터 |
| `post_use_stress`, `post_use_items` | 5.8 → 3.7, 22명 중 20명, 문항 평균 | Drive 「AZT(아지트) 사용 후기 설문 (2분) (응답)」 22건에서 다시 계산 (9/15–21) |
| `engine_reeval45` | −38% · −37% · −10%, −63%, 20% → 0% | 포스터 · Drive 「포스터전시」 초안 |
| `korean_valence_fix` | 0.399/0.495 · 0.323/0.474 · 0.764, 보정식 | Drive 「포스터전시」 초안 |
| `parameter_evidence` | μ 실험 표, λ 실험 | Drive 「포스터전시」 초안 (팀원 Colab `azt_mu_sweep` · `azt_full_sweep`) |
| `data_pipeline` | 245 → 2,398 → 4,117곡, 골드셋 249곡·964쌍, 가사 점수 1,768곡 | eumchichi-data 저장소 기록 |
| `web2_12_steps`, `web2_safety`, `web2_validation` | 12가지 절차, 52/65, 177/177, 1,959, 140/140, P1·P2 | `docs/personalization_spec_20260927.md` · `README.md`(10/1 부터 저장소 루트) (**합성 사용자**) |
| `team_roles` | 역할 | 회의록 8/11 · 9/14 · 9/20 — **발표 전에 팀원 확인 후 문구를 고칠 것** |

`web2_validation`의 수치는 모두 합성 사용자 시뮬레이션이다. 그림 맨 위에도 그렇게 적었다. 실사용 효과처럼 말하지 않는다.

## 다시 만들기

이 폴더(`presentation/assets/`)의 상위 저장소 루트에서:

```bash
node presentation/assets/tools/make_qr.mjs           # svg/qr_*.svg
node presentation/assets/tools/build_figures.mjs     # svg/*.svg · figures.js · figures.json
node presentation/assets/tools/render_png.mjs        # png/*.png (Pretendard를 받으려면 인터넷 필요)
node presentation/assets/tools/capture_screens.mjs   # screens/*.png (운영 Firestore를 2번 읽음)
```

헤드리스 Edge 경로가 다르면 `AZT_EDGE`, 캡처할 주소가 다르면 `AZT_URL`을 지정한다.
숫자를 고칠 때는 `build_figures.mjs`의 해당 그림 블록만 고치고 위 두 번째·세 번째 명령을 다시 돌린다.
