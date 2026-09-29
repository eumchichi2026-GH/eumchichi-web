# web-personal 개인화 구현 명세

> 작성 2026-09-27 · 대상: web-personal 구현 3인(ENGINE · APP · TOOLS) · 상태: **구현 기준 문서(동결)**
> 기준 코드: fix-web main `76e8bdf` (engine 2.5.1, rules v2.4.0). **이 문서의 줄 번호는 전부 `76e8bdf` 기준**이다.
> 근거 자료(읽기 전용, `git -C <eumchichi-data> show <ref>:<path>`):
> `origin/analysis/nl-path-personal:docs/iso_path_quality_20260926.md` · `…/hold_segment_proposal_20260925.md` ·
> `…/personalization_probe_20260926.md` · `…/scripts/analysis/azt_app.mjs` · `origin/master:docs/adjacent_similarity_20260925.md`.
> 합성 사용자(시뮬레이터)로 낸 모든 수치에는 **"합성 사용자"** 라고 적는다. 실제 효과는 로그가 쌓인 뒤 5단계(재생 평가)에서 잰다.

---

## 0. 한눈에 보기

### 0.1 무엇을 만드는가

`web-personal` 은 fix-web 을 복제한 **별도 웹 서버·앱**이다. 같은 Firestore(`eumchichi-5a1cd`)를 쓰되, 로그인 사용자에게는
플레이리스트를 만드는 **모든 절차**가 그 사람의 기록으로 조정된다.

| # | 절차 | 개인화되는 값 | 무엇으로 배우나 | 이 문서 |
|---|---|---|---|---|
| 1 | 입력 해석 (칩·자연어 → 지금 좌표) | 감정 단어별 좌표 보정 δ | 사용자가 **직접 끌어 옮긴** 좌표 | §4.1 |
| 2 | 목표 해석 (목표 칩·자연어 → 목표 좌표) | 목표 단어별 좌표 보정 δ | 같은 방식 (자동으로 목표를 옮기는 일은 없음) | §4.2 |
| 3 | ISO 경로 — 도착 시점 | 속도 π → 전환점 tp | 속도 버튼 선택, 「듣고 난 뒤」 한 번 누르기 답(더 빨리/딱/더 천천히), 조기 이탈 지점 | §4.3 |
| 4 | ISO 경로 — 시작점 | 시작 오프셋 s | 첫 곡 거절률(나머지 곡 대비, 취향 통제) + `mood_mismatch` | §4.4 |
| 5 | 곡 수 / 길이 | 기본 감상 시간 제안 | `length` + 방향(길었어요/짧았어요), 최근 선택 시간 | §4.5 |
| 6 | 도착 후 머묾 구간 | 반경 r, 머묾 순서 | `arrival_mismatch`, 머묾 구간 `too_repetitive` | §4.6 |
| 7 | 곡 취향 | 묶음별 좋아요 비율, 강도 μ, 새 가수 발견 칸 | 좋아요·싫어요(이유)·벽·**청취 시간 표(9/20 합의)** | §4.7 |
| 8 | 곡과 곡 사이 연결 (빠르기·목소리·말 비중·장르·V/A 거리) | 전환 비용 배수 m_f, λ | 전환 직후 거절, `path_jump` 위치 (취향으로 설명되는 몫은 빼고) | §4.8 |
| 9 | 후보 게이트 | 말 많은 곡 자동 제외(끌 수 있음) | `vocal_bother`, 말 비중 묶음 비율 | §4.9 |
| 10 | 다양성 | 가수 상한, 최근 곡 쉬는 폭, 좋아요 곡 다시 넣기 | `too_repetitive`, 노출 기록(기기 무관) | §4.10 |
| 11 | 더 들을 곡 | 엔진이 목표 근처에서 취향·연결까지 보고 고름 | 위 모든 값 | §4.11 |
| 12 | 조건 완화 순서 · 시드 · 설명 | 완화 순서, 기기 무관 세션 번호, "이번 추천에 반영된 나" | 위 모든 값 | §4.12 |

기하의 뼈대(좌표계·영역 풀·빔·band·진행 페널티·장르 우선 정책)는 **일부러 개인화하지 않는다** — 이유는 §4.13.

### 0.2 설계 선택

세 설계안(A 학습 · B 제품 · C 안전)을 심사 3건이 평가했다(우승: A 1표, C 2표 — 셋째 심사는 "C 를 바탕으로 B 의 제품·시연 층").
이 명세는 **C 의 안전 골격**(불변식·결합 제한·고긴장 안전 집합·자동 목표 이동 금지·쓰기 보호)을 바탕으로,
**B 의 제품 층**(기본 추천과 비교, 내 취향 모델 패널, 방향 있는 한 번 누르기 신호, 데모 모드, 기존 기록으로 따뜻한 시작)과
**A 의 학습 규율**(신호×학습기 신용 할당 행렬, 사후 안전 봉투, 취향 통제 공변량, 반사실 귀속)을 붙이고,
심사가 지적한 치명 결함을 전부 고쳤다(§0.3).

핵심 결정 다섯 가지:

1. **밴딧·톰슨 샘플링을 쓰지 않는다.** 캡스톤 규모(사용자당 1~10세션)에서는 사전값을 벗어나지 못하고(심사 A-6), 평평한 사전분포는
   요청하지 않은 사용자의 경로를 무작위로 바꾼다(심사 C-4). 대신 **방향이 있는 명시 신호**(속도 답, 길이 방향, 직접 끈 좌표)를
   가우스 축소 추정으로 모으고, 확률적 탐색은 취향의 "새 가수 한 칸"(시드 고정·고긴장 금지) 하나만 둔다.
2. **개인 비용은 한 번에 묶어 제한한다.** 걸음마다 `개인비용 = clamp(μ·취향여백 + 전환비용, −J, +J)`,
   이동 구간 J = 1.5 band, 머묾 구간 J = 0.0125. 음(−)의 가점은 **코리도어 안**(이동: 최선 밴드+1 이내, 머묾: 반경 r 이내)에서만.
   이것으로 "개인화가 고른 곡은 기하가 허용하는 최선보다 한 밴드 넘게 나쁘지 않다"가 **정리로** 보장된다(§3.8).
3. **경로 모수는 경로 신호로만 배운다.** 취향으로 생기는 넘김(스킵)은 속도·시작점·길이·반경을 움직이지 않는다.
   전환 학습은 곡마다 로그에 남긴 취향 여백으로 "취향만으로 예상되는 거절률"을 빼고 남는 몫만 쓴다(§3.4, §4.8).
4. **목표는 자동으로 옮기지 않는다.** 좌표는 사용자가 과거에 직접 옮긴 만큼만 보정되고, 화면에 보이며, 한 번에 되돌릴 수 있다.
5. **`inputs.personal` 이 없으면 엔진 출력은 2.5.1 과 바이트 단위로 같다**(I0). 익명 사용자·개인화 끔·규칙 스위치 끔은 모두 이 경로.

### 0.3 심사 치명 결함 → 이 명세의 처리

| 출처 | 지적 | 처리 |
|---|---|---|
| A-1 | μ 밴딧 보상이 선택 편향(μ 가 작을수록 T 곡 성공률이 높게 나옴), `not_my_taste` 를 μ 실패로 셈 | μ 는 **증거량으로 정하는 결정식** `μ = 0.5·E/(E+8)`(§4.7.3). 보상 학습 없음. 반사실 집합은 설명·진단에만 |
| A-2 | 반사실 집합 T(μ=0 재실행)가 연쇄 효과까지 취향 탓으로 셈 | 재실행 없이 **걸음별 기하 최선곡(`p_geo_best`)** 과 비교해 그 걸음에서 무엇이 순위를 바꿨는지 기록(§6.8). 학습에 쓰지 않음 |
| A-3 | 전환 배수 `E[w]/w0` 가 작은 분모로 잡음 증폭 | 결합 곱셈 모형 + 로그 척도 축소 + **80% 구간이 1 을 벗어날 때만 적용**, 배수 [0.5, 2](§4.8.3) |
| A-4, C-6 | 청취 30% 미만이면 종료 원인과 무관하게 부정 표 | **실제 넘김(next/jump)** 일 때만 부정. 탭 닫힘·새 추천·세션 종료·자동재생 실패는 표 없음(§3.2) |
| A-5 | 완주율 대리 보상이 경로 모수에 들어감 | 경로 모수에는 완주율을 쓰지 않는다. `post_change.change` 도 학습에 쓰지 않고 **평가 지표로만** 쓴다(§5) |
| A-6 | 탐색 칸 1개로 대부분 모수가 10세션 안에 사전값을 못 벗어남, 시험은 21~40세션 | 방향 신호 학습기로 교체. 수용 기준은 **1~10세션**(§11) |
| A-7, 심사2·3 | 머묾 재배열 "진행 방향 순"(제안 B)은 마지막 곡이 가장 가깝지 않은 비율 46% | **마지막 곡 고정(최소 fit) + 나머지 진행 방향 순**(`last_fixed_progress`). 지그재그 0% 를 수용 기준에 넣음(§4.6, §11) |
| A 구현성 | 3회 실행·라플라스·몬테카를로 성향·SNIPS·200명×40세션 | 추천당 2회 실행(개인 A + 기준 R), 필요할 때만 3회. 결정식 학습기뿐. 14명×10세션×5반복 |
| A 저장 | `users/{uid}` 에 200KB 모델 | 모델은 로그에서 매번 재구성(≤50ms). 저장은 작은 필드 `wp_personal_v1`(≤64KB) 하나(§7.4) |
| A, B, C 공통 | 화살표 키는 데스크톱 전용 → 보정 학습기에 모바일 데이터가 거의 없음 | **지금·목표 점 끌기(pointer drag)** 를 새로 만든다(§4.1.4) |
| B-1 | 목표 오프셋 τ 가 비례 제어기라 수렴 못 함 + 선언한 목표를 자동으로 옮김 | 목표 자동 제어 없음. 목표 보정은 사용자가 끈 좌표로만(§4.2). 끝 기분 탭은 P2 로그 전용 |
| B-2, C-2 | 시작 오프셋이 한 방향으로만 올라감(래칫) | 나머지 곡 대비 비율 + **모집단 첫 곡 기저비 1.2 로 나눔** + `mood_mismatch` 명시 확인 + 내림 규칙 + 이력 현상(§4.4) |
| B-3, C-5 | 전환 배수가 특징별 주변 비율, 취향 통제 없음, 공선성 무시, 스킵 이중 계산 | 취향 기대 거절률 q 를 오프셋으로 둔 **결합 곱셈 모형**, 5특징 동시 적합. 취향 표는 전환 귀속분 a 만큼 줄임(§4.8) |
| B-4 | 속도 신호의 방향을 추측(`arrival_mismatch`·이탈 → 더 빨리) | 속도는 **버튼 선택과 속도 답**만. 이탈은 별도 "이탈 가드"(상한)로만(§4.3.4) |
| B-5 | 소프트 게이트 해제 조건이 게이트 때문에 영영 안 옴 | 마지막 근거로부터 30일 뒤 자동 만료 + 칩에서 끄기(§4.9) |
| B-6, 심사2·3 | 코리도어가 전환 비용을 묶지 못함 | 취향+전환을 **한 번에 clamp**, 코리도어 밖은 가점 0(§3.8 정리) |
| B-7 | 고긴장 안전 집합 없음 | I5 고긴장 규칙(§1) |
| B-8 | 인기도를 전역 특징에 추가(모름=0 이 '낮음'으로 묶임) | 개인 전용 추가 특징(`feature_bins_p`), 0 = 모름. P2, 기본 꺼짐(§4.7.5) |
| C-1 | 보정 추정량이 잔차 평균이라 참값의 절반에 수렴 | 관측은 **항상 원래 표 좌표 기준** `o = 최종 − 표`(§4.1.2) |
| C-3 | 길이 계수를 도달 비율(스킵 포함)로 배움 → 취향이 경로로 샘 | 길이는 `length` + 방향만. 이탈 가드는 "재생을 멈춘 지점"만 봄(넘김은 도달을 늘릴 뿐 멈춤이 아님)(§4.5) |
| C-4 | 평평한 사전 Beta 로 톰슨 샘플링 | 없음(0.2 결정 1) |
| C-7 | 옛 칩 추론(0.10 이내 최근접)이 화살표 이동을 잘못 읽음 | 옛 기록은 **칩 좌표와 정확히 같을 때만**(받아들임 관측), 나머지는 버림(§4.1.2) |
| C-8, 심사3 | 도착 오차 기준(≤0.010)이 r=0.035 와 모순 | 기준을 측정값과 맞춤: 중앙 ≤ 0.025, 90% ≤ 0.040(§11) |
| C-9, 심사3 | 콜드스타트가 fix-web 과 같아 "같은 곡으로 끝남 100%" 그대로 | 곡 수 ≥ 5 이면 신규 사용자부터 r = 0.035 + 마지막 곡 고정 순서(§4.6) |
| 심사2 C | `orderHold` 가 λ>0 이라 중립에서 2.5.1 순서가 아님 | 중립 정책의 `hold_order = "fit"`(2.5.1 정렬 그대로)(§6.5) |
| 심사2 C | 설명 조건 `≠ null` 을 렌더러가 표현 못 함 | 설명용 **불리언 trace 키**(`p_smooth` 등)(§6.8) |
| 심사2 C | `dislike_scope` 를 규칙 기본 절에서 바꾸면 P=null 경로가 달라짐 | 규칙 기본 절은 그대로, `personalization.taste.dislike_scope_add` 를 `aggregateAffinity(items, rules, opts)` 로 전달(§6.6) |
| 심사2 C | 취향 표가 로그에 없어 실제 로그 재현 불가 | 추천 문서에 **정규화한 정책 + 압축 `user_affinity`** 를 함께 기록(§7.1) |
| 심사2·3 | 이벤트가 늘어 운영 앱의 400건 창을 잠식 | `track_milestone`·`track_transition_trace` 끔(디버그 때만), 곡당 `track_exit` 1건(§7.2) |
| 심사2 A | 장르 핀만 있는 사용자는 `hasPins` 가 못 봄 | `preferred_genres` 는 취향 증거로 쓰지 않음(오염됨, D3) |
| 심사2 B·A | 로컬 개발이 운영 Firestore 에 그대로 씀 | `fsWrite` 한 곳으로 모으고 로컬 기본값은 쓰기 끔(§7.5, §9.3) |

### 0.4 우선순위 (10/3 시연 기준)

| 등급 | 항목 |
|---|---|
| **P0** (시연 필수) | I0 회귀 · 로그 수정(`track_exit`, 동기 rec id, like `on`, 시퀀스 위치) · 청취 표 + μ + 코리도어/clamp · 인접 전환 기본 비용 + 개인 배수 · 머묾 반경·순서 · 속도 π + 속도 답 · 기기 무관 최근 창 · 엔진 extras(큐 포함) · 기본 추천과 비교 · 내 취향 모델 패널(최소) · 개인화 끄기 · `server.mjs` · 시뮬레이터·회귀 |
| **P1** | 좌표 끌기 + 입력·목표 보정 + 안내 · 소프트 말 많은 곡 게이트 · 가수 상한 · 좋아요 곡 다시 넣기 · 새 가수 발견 칸 · 시작 오프셋 · 이탈 가드 · 감상 시간 제안 · 데모 모드 |
| **P2** | 인기도 특징 · 자연어 단어 치환·강도 편향 · 끝 기분 탭 · `lab.html` · 머묾 `last_fixed_smooth` · `listeningHistory` 흡수 |

P0 가 끝나지 않으면 P1 을 시작하지 않는다. 등급과 무관하게 **§1 불변식은 첫날부터** 지킨다.

---

## 1. 불변식

| ID | 불변식 | 확인 |
|---|---|---|
| **I0** | `inputs.personal` 이 없거나(`undefined`/`null`) `rules.personalization.enabled !== true` 이면, `recommend(catalog, rules, inputs)` 의 출력은 엔진 2.5.1 의 출력과 **JSON 직렬화가 같다**. 비교에서 빼는 필드는 `engine_version`, `rules_version`, `rules_hash`(최상위와 각 행 `trace.rules_hash`)뿐. `inputs.pace ∈ {"fast","slow"}` 도 같다 — 2.5.1 에 "전환점을 `[{up_to:999, at:0.5 또는 1.0}]` 로 바꾼 규칙 사본"을 준 결과와 같아야 한다(지금 앱의 `PACE_TP` 경로). `aggregateAffinity(items, rules)`(인자 2개, `vote` 없는 항목)도 같다. | `tools/sim/regress.mjs` — 기준 엔진·규칙은 `git show 76e8bdf:engine/engine.js`·`…:rules/rules.compiled.json`. 격자 1,224(ISO) + 660(인접) + 개인화 탐침 5명×μ3 + 무작위 항목 집합 200. **100% 일치** |
| **I1** | 중립 정책 `personal.neutralPolicy(rules)` 를 넣으면 `sequence` 의 곡 순서와 2.5.1 trace 키 값이 I0 결과와 같다(새 `p_*` 키만 추가). 각 모듈은 중립값에서 항등이다. | 같은 격자, 100% |
| **I2** | 신규 회원의 기본 정책 P0(= 빈 모델의 `resolvePolicy`)는 §11 의 ISO 봉투와 구성 목표를 지킨다. P0 가 2.5.1 과 다른 것은 모집단 변경(머묾 반경·순서, 기본 전환 비용, 가수 키 상한, 기기 무관 최근 창, 엔진 extras)뿐이며 차이는 보고서에 적는다. | `tools/sim/run.mjs --grid` |
| **I3** | **두 레인.** 취향·전환·게이트·다양성은 곡을 고를 뿐 경유지를 바꾸지 않는다. 경유지(`wp_V`,`wp_A`)를 바꾸는 것은 경로 모수(tp·s·이탈 가드)와 앱 쪽 좌표 보정뿐이고, 모두 로그에 남는다. | 경로 모수가 P0 와 같은 정책이면 경유지 100% 동일 |
| **I4** | **사용자 선언이 이긴다.** 속도 버튼·가사·장르·감상 시간은 모델보다 우선한다. 좌표는 사용자 본인이 과거에 끌어 옮긴 만큼만 보정되고, 화면에 원래 위치와 함께 보이며, 한 번에 되돌릴 수 있다. 샘플링이나 제어기가 목표를 옮기는 일은 없다. | 단위 시험 |
| **I5** | **고긴장 보수성.** `stressOf(지금 좌표) ≥ 3` 이면: 새 가수 발견 칸 없음 · 자동 속도는 기본보다 빠를 수 없음(사용자가 '빠르게'를 직접 누른 경우만 예외) · 반경 r ≤ 0.035 · 시작 오프셋 s ≤ 0.075 · 전환 배수 ≥ 1(더 엄격하게만). 엔진 `sanitizePersonal` 이 한 번 더 강제한다. | 고긴장 페르소나 100% |
| **I6** | **개인 비용 결합 제한.** 걸음마다 `pers = clamp(취향 + 전환, −J, +J)`, 이동 J = 1.5·band, 머묾 J = 0.0125. 음수(가점)는 코리도어 안에서만. §3.8 정리가 성립한다. | 단위 시험(정리) 위반 0 |
| **I7** | **결정성.** `engine/*.js` 에 `Math.random`·`Date.now` 없음. 기준 시각 `as_of_ms` 는 인자로 받는다. 같은 (RawFacts, as_of_ms, ctx, seed) → 같은 모델 digest · 정책 digest · 시퀀스. | 반복 100회, `check.mjs` |
| **I8** | **숫자는 규칙 파일에.** 새 숫자는 전부 `rules.compiled.json` 의 `personalization` 절에 근거 문자열(`*_evidence`)과 함께 둔다. `PACE_TP`·extras 0.85·`RECENT_MAX` 도 옮긴다. 규칙을 바꿀 때마다 `node tools/rules_hash.mjs --write`. | `check.mjs` |
| **I9** | **데이터 안전.** 새 컬렉션·보안규칙 변경·새 복합 색인 없음. 새 사용자 상태는 `users/{uid}.wp_personal_v1` 한 필드(≤64KB). 모든 Firestore 쓰기는 `fsWrite` 한 곳을 지나며 `app:"web-personal"` 표시가 붙는다. `song_stats` 는 기존 7개 키만. 로컬 실행은 기본 쓰기 끔. | `check.mjs`, 코드 리뷰 |
| **I10** | **회원 전용.** 익명 사용자는 `inputs.personal` 을 받지 않는다(9/17 결정) — I0 경로. `users/*`·`listeningHistory` 에 쓰지 않는다. | 앱 시험 |
| **I11** | **끄는 스위치 3개.** `rules.personalization.enabled`, 주소 `?personal=0`, 사용자별 `wp_personal_v1.opt_out`. 어느 것이든 켜지면 I0 경로. | 앱 시험 |
| **I12** | **싫어요 = 후보 제외**(9/20 합의). 이유 코드와 무관. | 기존 |

**I0 을 비트 단위로 지키는 구현 규칙**: `P === null` 인 분기는 2.5.1 식을 글자 그대로(덧셈 순서 포함) 둔다. 새 항은 `if (P)` 안에서만 더한다.
빔 상태 객체에 새 필드(`prevSong` 등)를 더하는 것은 출력에 나오지 않으므로 허용한다. 새 설명(`rules.explanations`)은 전부 `when` 을 가지며
그 `trace_key` 는 P 모드에서만 존재한다(없으면 `undefined !== true` 로 건너뜀).

---

## 2. 구조와 흐름

### 2.1 모듈

```
index.html (APP) ── Firestore 읽기·쓰기(fsWrite), UI, 재생·로그 ──┐
                                                                   │ RawFacts, CatalogIndex, ctx
engine/personal.js (ENGINE, 순수 ESM, DOM·Firebase 없음) ◄──────────┘
   normalizeLogs → buildPersonalModel → calibratePoint / suggestMinutes → resolvePolicy
   → (엔진 2회 실행) → safetyCheck → buildRecLog / explainPolicy / explainModel
engine/engine.js 2.6.0-wp (ENGINE) ── inputs.personal(PersonalPolicy) 를 소비. 배우지 않고, 샘플링하지 않는다
rules/rules.compiled.json v2.5.0-wp (ENGINE) ── 새 personalization 절 + trace_keys + explanations
server.mjs, tools/sim/* (TOOLS) ── 로컬 서버, 카탈로그 로더(git show), 회귀, 시뮬레이터, 스윕, 재현, 정적 검사
```

`personal.js` 는 `engine.js` 의 export 만 import 한다. 앱은 엔진과 같은 방식(`import("./engine/personal.js?v=300")`)으로 불러오고,
Node 도구는 파일을 직접 import 한다 — **앱과 시뮬레이터가 같은 코드로 모델·정책·로그 문서를 만든다.**

### 2.2 추천 1회 흐름 (APP `recommend()`, 지금의 L3387–3556 을 대체)

1. **입력 확정.** 칩·자연어·끌기로 정해진 `CUR_VA`/`TGT_VA` 는 이미 보정이 적용된 값이다(§4.1). 표 좌표·라벨·끌었는지를 함께 든다.
2. **ctx 구성**: `{ now, target, now_table, target_table, labels, nudged, minutes, lyric, genres, pace_user: PACE_MODE, seed, global_stats, session_no }`.
3. **정책**: 회원이고 스위치가 모두 켜져 있으면 `out = personal.resolvePolicy(MODEL, ctx, RULES)` → `{ policy, user, explain, meta }`,
   기준 정책 `ref = personal.resolvePolicy(MODEL, ctx, RULES, { mode: "p0" })`. 아니면 둘 다 없음(I0 경로).
4. **실행 A**: `engine.recommend(contract, RULES, { ...engineInput, user: out.user, pace: PACE_MODE, personal: out.policy })`.
5. **실행 R(기준)**: 같은 입력에 `user: ref.user, personal: ref.policy`. "개인 기록이 전혀 없을 때 web-personal 이 줄 추천"이다.
6. **조건 완화**(§4.12.1)는 A 에 적용하고, R 은 A 가 최종적으로 쓴 입력(풀린 조건)으로 한 번만 돌린다.
7. **안전 확인** `personal.safetyCheck(A, R, RULES)`. 위반이면 A′ = 경로 모수(tp·s·이탈 가드·r)를 P0 로 되돌린 정책으로 재실행 → 다시 확인 → 그래도 위반이면 R 을 쓴다.
   무엇으로 떨어졌는지 `fallback ∈ {null, "geometry", "p0"}` 로 기록.
   > **변경 (2026-09-29, 1차 수정)** — 기준을 둘로 나눈다(두 레인 I3 의 거울). A 가 R 에 대해 위반이고 경로 모수(`PATH_PARAM_KEYS` = tp·quit_frac·start_offset·hold_radius·hold_min_pool)가
   > P0 와 다르면 **R_path**(`resolvePolicy(..., { mode: "path" })` — 곡 레인 P0 + A 의 경로 모수, 경유지가 A 와 같다)를 한 번 더 돌려
   > `safetyCheck(A, R, RULES, { resRp })` 로 다시 판정한다: ① R_path 가 R 에 대해 봉투 안인가(경로 레인 — 최대 전환은 경유지 걸음이 늘어난 만큼 × `envelope.path_wp_step_allow` 허용,
   > 밖이면 위반 이름 앞에 `path_`, lane `"path"` → A′), ② A 가 R_path 에 대해 봉투 안인가(곡 레인 — 밖이면 lane `"song"`). 학습된 빠른 속도의 의도된 긴 걸음이
   > max_jump 로 잡혀 개인화를 버리던 문제(데모 P1 추천 3번 중 2번 폴백) 수정. 경로 모수가 P0 와 같으면 A′ ≡ A 라 곧바로 R. 역행 허용은 0(`envelope.reversal_tol`).
   > 근거 숫자는 `safety.envelope.reference_evidence`.
8. **더 들을 곡**: `engine.recommendExtras(contract, RULES, 최종입력, 최종결과, { target_sec })`(§4.11).
9. **로그**: `personal.buildRecLog(...)` 가 만든 문서를 `fsWrite("rec", …)` 로 **동기 문서 ID** 와 함께 기록(§7.1).
10. **화면**: 경로·곡별 설명(엔진 trace) · "이번 추천에 반영된 나" 칩 ≤3(`explainPolicy`) · "기본 추천과 비교" 토글(R 경로 점선, 바뀐 곡 표시 "N곡 중 M곡이 나에게 맞게 바뀌었어요").

비용: 엔진 1회 ≈ 77ms(4,117곡 실측) → 보통 2회 ≈ 160ms, 폴백 시 3회.

### 2.3 모델 빌드 흐름 (APP 가 부르고 ENGINE 이 구현)

- **언제**: 회원 로그인 직후(`handleUserChange`, L1403) 한 번 읽고, 세션이 닫힐 때마다(「기록하고 나가기」, 다음 추천, `pagehide`) 메모리에서 다시 만든다.
- **읽기**(기존 색인 `user_id ==, created_at desc` 재사용 — `loadPersonalFeedback` 의 `queryRecent`, L2186):
  `recommendations` 최근 100 · `context_events` 400건×3쪽(`startAfter`) · `users/{uid}`(이미 읽음) ·
  `users/{uid}/listeningHistory` 300(선택, 보안규칙이 막으면 조용히 건너뜀).
- **이 탭이 방금 쓴 것**은 `SESSION_LOG`(메모리)에 같은 모양으로 쌓아 합친다(서버 시각 확정 전에도 모델이 자기 기록을 본다). 중복은 문서 ID·`client_id` 로 제거.
- `raw → personal.normalizeLogs(raw, CATALOG_INDEX, RULES) → personal.buildPersonalModel(norm, CATALOG_INDEX, RULES, { as_of_ms })` — 목표 ≤ 50ms.
- **모델은 저장하지 않는다.** 매번 로그에서 다시 만든다. fix-web 시절 기록(같은 uid)도 그대로 읽어 **첫 세션부터 따뜻하게 시작**한다.
- 익명 사용자: 읽지도 만들지도 않는다.

---

## 3. 공통 정의

모든 숫자는 `rules.personalization.*` 의 값이다(§10). 아래 괄호 안은 기본값.

### 3.1 노출(Exposure) — 곡 한 번 재생의 결과

web-personal 은 곡을 한 번 틀 때마다 `track_exit` 이벤트 하나를 쓴다(§7.2). 옛 기록(fix-web·운영 앱)은 이벤트에서 재구성한다.

| 항목 | 정의 |
|---|---|
| `started` | 그 곡에서 위치가 0.2초 넘게 움직인 재생 표본이 한 번이라도 있었나 |
| `listened_s` | 실제 재생 누적 초 + 백그라운드 보정 `bg_credit_s`(§7.3, B12) |
| `duration_s` / `catalog_s` | 임베드가 알려 준 길이 / 카탈로그 `duration_ms/1000` |
| `completion` c | `min(1, listened_s / duration_s)` (길이를 모르면 `catalog_s`) |
| `preview` | `duration_s ≤ outcome.preview_max_duration_s(31) && catalog_s ≥ outcome.preview_catalog_min_s(45)` — 30초 미리듣기 |
| `cause` | `complete · next · prev · jump · new_rec · pagehide · session_end · autoplay_fail` |
| **노출됨** | `started && listened_s ≥ outcome.exposure_min_s(3) && cause ≠ autoplay_fail`. 점프로 건너뛴 곡은 노출이 아니다 |
| **들음** | `listened_s ≥ outcome.heard_min_s(10)` (좋아요 버튼이 열리는 기준과 같음, `HEARD_MIN_SECONDS`) |
| **조기 넘김** | 노출됨 ∧ `cause ∈ {next, jump}` ∧ `c < outcome.skip_below(0.30)` |
| **끝까지** | `c ≥ outcome.keep_from(0.70)` |

**옛 기록 재구성** (`source:"legacy"`): `track_complete{completion_rate}` → c · `track_skip{direction}` → cause(next/prev/jump), c 는 그 곡의
`track_milestone` 최댓값/100(없으면 0.1) · `track_autoplay_failed` → autoplay_fail. 곡·추천 연결은 **`(rec_id, song_id)` 로만** 한다
(옛 `position` 은 재생 큐 위치라 시퀀스 위치와 어긋난다, B14). `rec_id` 가 null 이면 같은 사용자의 `created_at` 이 그 이전이면서
`load.orphan_window_h(3)` 시간 이내인 가장 최근 추천에 붙이고, 없으면 버린다. 옛 노출에서 나온 표는 `outcome.legacy_factor(0.5)` 배.

### 3.2 청취 표 (9/20 합의)

곡마다(좋아요·싫어요·벽이 없는 곡만) 노출 e 하나가 주는 표:

| 조건 | 표 |
|---|---|
| 끝까지(c ≥ 0.70) | `pos += 0.25 · φ` |
| 조기 넘김(c < 0.30, cause next/jump) | `neg += 0.25 · φ · (1 − a_e)` — a_e 는 전환 귀속분(§4.8.4, 콜드스타트 0) |
| c < 0.30 이지만 cause ∈ {prev, pagehide, new_rec, session_end, autoplay_fail} | **표 없음** — 취향 때문에 멈춘 것이 아니다 |
| 0.30 ≤ c < 0.70 | 표 없음 (분자·분모 모두 0) |

- φ = `outcome.preview_factor(0.5)`(미리듣기) · `outcome.legacy_factor(0.5)`(옛 기록) · 둘 다 아니면 1.
- 한 곡의 암묵 표는 세션을 통틀어 `pos + neg ≤ listen_vote.per_song_cap(1.0)` — 시간순으로 더하다가 1 에 닿으면 멈춘다(자주 나온 곡이 과대표되지 않게).
- **명시가 이긴다**: 좋아요(pos 1), 취향 싫어요(neg 1, 범위는 이유), 벽(pin 1, 감쇠 없음)이 있으면 그 곡의 청취 표는 쓰지 않는다.
- 합의 원문: "청취 시간 30%↓ 약한 −, 30~70% 0, 70%↑ +, 크기는 좋아요의 1/4쯤." `unit = 0.25`.

### 3.3 전환 라벨

같은 추천 안에서 **재생 순서로** 이어진 두 노출 (a → b) 가 학습 대상이 되려면(`track_exit.prev_song_id` 로 잇는다):

- a 가 몰입 상태였다: `a.completion ≥ outcome.engaged_prev_min(0.5)` 또는 `a.cause = complete`.
- b 가 시작됐고 `b.cause ≠ autoplay_fail`, b 는 자동 넘김(complete 다음) 또는 `next` 로 도달(점프·이전 곡으로 온 것 제외).
- b 가 취향 싫어요(`not_my_taste`·이유 없음)가 아니다(취향으로 이미 설명됨).

라벨 y(b): **1** = 조기 넘김, 또는 b 에 `dislike_reason: path_jump`, 또는 세션 `path_jump` 코드의 위치(`note_ai.positions`)에 b 가 있음
(출처 `user` 가중 1, AI 가 고르고 사용자가 지우지 않은 것 가중 0.5, `ai_codes_removed_by_user` 에 있으면 버림).
**0** = b 가 끝까지 들렸거나 좋아요. 그 외(30~70%)는 **제외**. 위치 없는 세션 `path_jump` 는 전환 라벨을 만들지 않는다(어느 전환인지 모름).

### 3.4 취향 기대 거절률 q

전환 학습과 시작점 학습에서 "그 곡이 취향에 안 맞아서 넘겼을" 몫을 빼기 위해, 추천 당시 로그에 남긴 곡별 취향 여백
`p_pmarg = 내 중립점 − 선호 점수`(양수일수록 취향 밖)를 쓴다:

`q_b = σ(adjacency.theta0 + adjacency.theta_margin · p_pmarg_b)`, 기본 θ0 = −1.73(= logit 0.15), θ_m = 3.0.
여백을 모르는 옛 기록은 `p_pmarg = 0`. θ 값은 사전값이고, 실제 web-personal 로그가 쌓이면 TOOLS 가 모집단 적합으로 다시 정한다(§12 위험).

### 3.5 스트레스와 고긴장

`stressOf(p) = round(4 · clamp((1 − p.v)·safety.stress_w_v(0.6) + p.e·safety.stress_w_a(0.4), 0, 1))` — 앱의 `deriveStress`(L838)와 같은 식.
`p` 는 보정이 적용된 지금 좌표(원좌표). **고긴장 = stress ≥ `safety.high_stress_min(3)`**.
확인값: 불안해요 3 · 짜증나요 3 · 답답해요 3 · 걱정돼요 3 · 우울해요 2 · 지쳤어요 2. 엔진의 `inputs.stress` 는 여전히 읽지 않는다(스트레스·부하 분리 유지).

### 3.6 감쇠와 세션 가중

- 취향: 기존 `preference.decay.half_life_days(14)` 를 그대로 쓴다(항목의 `days`).
- 방향 신호(속도·길이): 세션 단위 `decay.session_gamma(0.85)` — j 세션 전의 표는 0.85^j.
- 좌표 보정: `decay.calib_half_life_days(60)`. 전환: `decay.transition_half_life_days(45)`.
- 규칙 기반 학습기(반경·다양성·게이트·시작점)는 `decay.lookback_sessions(10)` 창만 본다.
- 초기화(`resets[procedure]`) 이전의 근거는 그 학습기에서 모두 무시한다.

### 3.7 시드 난수

`seededUniform(seed, ...keys)` = xorshift32(fnv1a32(`${seed}|§${keys.join("|")}`) || 0x9e3779b9) / 2³² — 엔진 `jitterOf` 와 같은 계열,
`§` 접두어로 곡 단위 지터와 겹치지 않는다. `seed` 가 없으면 0.5. 이 문서에서 무작위는 새 가수 발견 칸(§4.7.4) 한 곳뿐이다.

### 3.8 개인 비용의 결합 제한 — 코리도어 정리

P 모드에서 걸음마다 각 후보 x 에 대해(`bestBand` 는 그 빔 상태 후보들의 최소 밴드, `r` 은 그 세션의 유효 반경):

```
taste  = isDiscoveryStep ? 0 : P.mu · pmarg
adj    = state.prevSong ? adjCost(state.prevSong, x, P) : 0     // §4.8, 항상 ≥ 0
bonusOK = P.corridor_bands == null ? true
        : arrival ? (fit ≤ r) : (bandIdx ≤ bestBand + P.corridor_bands)
pers   = taste + adj
if (!bonusOK && pers < 0) pers = 0                              // 코리도어 밖은 가점 없음(감점은 어디서나)
J      = arrival ? P.j_hold : P.j_move
pers   = J == null ? pers : R9(clamp(pers, −J, +J))              // 중립 정책(J·corridor = null)은 clamp 없음 → 2.5.1 과 같은 값
key    = R9(distCost + pers)
cost  += distCost + pw·prog + P.lambda·jump + pers
```

**정리 (이동 구간).** J = 1.5·band, `corridor_bands` = 1 이면, `bandIdx ≥ bestBand + 2` 인 후보의 key 는 최선 밴드의 **모든** 후보 key 보다 크다.
증명: 밖의 후보 key ≥ (bestBand+2)·band. 최선 밴드 후보 key ≤ bestBand·band + 1.5·band < (bestBand+2)·band. ∎
**정리 (머묾 구간).** 반경 r > J 이고 반경 안 후보가 하나라도 있으면, 반경 밖 후보는 선택 키에서 반경 안 후보를 이기지 못한다
(밖: key ≥ fit > r ≥ 0.02 > 0.0125 ≥ 안의 key). r = 0 이면 가점은 없고 감점만 최대 0.0125 까지 작용한다.

빔은 경로 전체 비용(진행·전환 λ 포함)으로 고르므로 2.5.1 에서도 최선 밴드 밖 곡이 뽑힐 수 있다 — 정리는 "개인 항이 더하는 이탈"의 상한이다.
단위 시험: 무작위 후보 목록·μ·배수 10만 조합에서 위 부등식 위반 0.

> **변경 (2026-09-29, 1차 수정) — 개인 비용 양자화.** clamp 다음에 `pers = trunc(pers / P.pers_bucket) · P.pers_bucket`
> (`pers_bucket = safety.pers_bucket_bands(0.25) · band`, 0 쪽 자름, 중립 정책은 null = 자르지 않음). 걸음 키와 빔 경로 비용이 같은 값을 쓴다.
> 연속값이면 동률이 없어 시드 변이가 첫 곡 뒤로 한 번도 쓰이지 않았다(같은 곡으로 끝남 92.8%, 서로 다른 곡 480). 0 쪽 자름은 |pers| 를 줄이기만 하고
> J(6칸·2칸)가 칸 폭의 정수배라 위 두 정리가 그대로 성립한다(단위 시험에 무작위 pers_bucket 추가). 머묾 걸음의 진행·λ 전환 비용 양자화는 §4.6.1 변경 참고.
>
> **변경 (2026-09-30, 2차 수정) — 이동 걸음은 양자화 대신 흔들기** `safety.pers_mode = "perturb"`. 이동 걸음의 키와 빔 경로 비용에
> `kp = clamp(taste + adj + pj, −J, +J)` 를 쓴다 — `pj = pers_jitter · jitter`(그 걸음·곡의 시드 지터 0~1, `pers_jitter = pers_bucket_bands · band`),
> 코리도어 밖은 `kp ≥ 0`. 기록·설명(`p_pers`)은 흔들지 않은 `clamp(taste + adj)`. 머묾 걸음은 1차의 양자화를 그대로 두고 `pj` 로 동률을 가른다.
> 이유: 양자화(0 쪽 자름)는 한 특징 전환 비용(0.15–0.2 band < 칸 0.25 band)을 통째로 0 으로 만들어 P0 의 전환 구성과 개인 전환 배수(< 1.67)가
> 순위에 닿지 못했다. 흔들기는 칸보다 작은 차이만 시드에 맡기고 큰 차이는 확률적으로 지킨다. `kp ∈ [−J, J]` 라 두 정리의 한계는 흔들기 전과 같다
> (단위 시험에 무작위 `pers_jitter` 추가, 경계 `bounds.pers_jitter_bands [0, 0.25]` — 머묾 정리 여유 j_hold + 폭 < 0.02 와 이동 J + 폭 < 2 band 를 둘 다 지킴).
> 측정(P0 격자): B5 같은 곡으로 끝남 40.1 → 34.7%(§4.6.1 의 묶음 깨기와 함께 33.5%), C1a 19.0/53.1 → 11.7/43.0, C1d 638 → 814. 표는 `safety.pers_mode_evidence`.

---

## 4. 절차별 개인화

각 절은 같은 틀을 따른다: **신호 → 식 → 기본값(규칙 키) → 훅 → 경계 → 콜드스타트 → 설명 문구 → 오프라인 시험**.
"훅"의 줄 번호는 `76e8bdf` 기준. 앱 쪽 좌표·시간 보정은 엔진 밖에서 끝나고, 엔진은 확정된 입력만 받는다.

### 4.1 입력 해석 — 지금 감정 단어의 좌표 보정 (P1)

#### 4.1.1 신호

| 신호 | 지금 | 변경 |
|---|---|---|
| 칩·자연어로 정한 뒤 사용자가 점을 옮겼나, 어디로 | 기록 안 됨(화살표 L2868–2878 이 `CUR_VA` 만 바꿈) | 새 끌기(§4.1.4) + `input.nudged`, 최종 좌표 `input.current_va`(기존) |
| 어느 단어였나 | 칩은 기록 안 됨, 자연어는 `nl_v2.final.current` | 새 `input.labels.current = {mode:"chip", chip:"불안해요"}` 또는 `{mode:"nl", nl:[{label,intensity}]}` |
| 보정 전 표 좌표 | 없음 | 새 `input.table_point.current = {v,e}` (칩 좌표 또는 `nlCurrentPoint(final.current)`) |
| 이번에 적용한 보정 | 없음 | 새 `input.calib_applied.current = {dv,de}` 또는 null |
| `mood_mismatch` | 세션 코드, `dislike_reason{position}` | 좌표를 움직이지 않음 — 안내(§4.1.5)에만 |

#### 4.1.2 학습식 (필드 f = current, 축 V·A 각각 독립)

관측은 **항상 보정 전 표 좌표 기준**이다(자기 참조 없음 — 심사 C-1 수정):

`o_i = final_i − table_i`,  가중 `w_i = (nudged_i ? calib.w_edit(1.0) : calib.w_accept(0.25)) · 0.5^(age_i / 60일)`

- 끌어 옮기지 않고 받아들인 경우도 관측이다(가중 0.25): 보정된 점을 받아들이면 그 보정을 약하게 강화하고, 표 좌표를 받아들이면 0 쪽으로 당긴다.
- 자연어 기분이 2개면 같은 o 를 각 단어에 `강도_j / Σ강도` 비율의 가중으로 나눠 준다(`nlCurrentPoint` 와 같은 비율).
- 탭(`mode:"tap"`)은 표 좌표가 없으므로 관측이 아니다.
- **옛 기록**: `input_mode.current == "chip"` 이고 `current_va` 가 어느 `MOOD_CHIPS` 좌표와 **정확히 같으면**(|Δ| < 1e−6) 그 단어의 받아들임 관측(o = 0).
  자연어면 `nl_v2.final.current` 로 표 좌표를 다시 계산해 같을 때만. 다르면 버린다(화살표로 옮긴 건지 알 수 없음 — 심사 C-7).

두 층 축소(단어 → 필드 전체):

```
g_f  = Σ_{i∈f} w_i·o_i / (Σ_{i∈f} w_i + calib.k_user(4))                      // 이 사람의 전반적 치우침
δ_ℓ  = (Σ_{i∈ℓ} w_i·o_i + calib.k_label(2)·g_f) / (Σ_{i∈ℓ} w_i + calib.k_label(2))
```

**적용 조건**: 그 단어의 "옮김" 관측(`nudged` 이고 |o| ≥ `calib.edit_eps(0.01)`)이 `calib.min_edits_label(2)` 이상이거나,
필드 전체 옮김이 `calib.min_edits_global(4)` 이상. 아니면 δ = 0.

**경계**: 축마다 |δ| ≤ `calib.max_axis(0.10)`. 표 좌표가 0.5 한쪽에 있을 때 보정이 0.5 를 넘기려면 그 단어에 같은 방향 옮김이
`calib.cross_neutral_min_edits(4)` 번 이상 있어야 한다(아니면 0.5 에서 멈춤). 마지막에 `nlClamp` [0.04, 0.96].

**계산 예**: 「불안해요」(0.30, 0.72)를 세 번 모두 활력 −0.10 쪽으로 끌었다(가중 1, 다른 단어 기록 없음).
g = −0.30/(3+4) = −0.0429, δ = (−0.30 + 2·(−0.0429))/(3+2) = **−0.077** → 다음엔 (0.30, 0.643)에서 시작.

> **변경 (2026-09-29, 1차 수정)** — `calib.w_edit` 1.0 → **3.0**(직접 옮김 1번 = 받아들임 12번). 끌기가 드문 사용자(P7: 10세션에 1–3번)는 사전 축소와 받아들임이
> 0 쪽으로 당겨 오차가 끌기 허용치 근처에서 멈췄다(D2 60% → 80%). 위 계산 예는 g = −0.90/(9+4) = −0.0692, δ = (−0.90 + 2·(−0.0692))/(9+2) = **−0.094** → (0.30, 0.626).

#### 4.1.3 적용

`personal.calibratePoint(MODEL, "current", labels, tablePoint, RULES)` → `{ point, applied:{dv,de}|null, basis:{label, n_edit}|null, prompt:string|null }`.
칩 클릭(L3044–3050)과 자연어 적용(`applyNLToState`, L3155–3171)에서 **표 좌표를 만든 직후** 부르고, 반환한 `point` 를 `CUR_VA` 로 쓴다.
자연어 두 단어: `δ = Σ_j (강도_j/Σ강도)·δ_{ℓ_j}`. 화면: 원래 표 좌표에 옅은 고리, 보정된 점, 캡션 "내 기준으로 살짝 옮겼어요 · 원래 위치로".
"원래 위치로"를 누르면 점을 표 좌표로 옮기고 `nudged = true`(0 방향 옮김 관측 — 올바른 신호다).
엔진 훅 없음(엔진은 확정 좌표만 받는다).

#### 4.1.4 끌기 — 새 입력 수단 (APP, 모든 기기)

지금은 칩을 고른 뒤 좌표를 고칠 방법이 데스크톱 화살표 키뿐이고, 목표까지 정한 뒤의 탭은 전체 초기화다(L2859–2866).
새 동작: `pointerdown` 위치가 이미 찍힌 '지금'/'목표' 점에서 18px(화면 기준) 이내면 **그 점을 끄는 모드**로 들어가
`pointermove` 로 좌표를 갱신하고 `pointerup` 에서 끝낸다(`touch-action: none`, 포인터 캡처). 이때 `CUR_MODE`/`TGT_MODE` 는
바꾸지 않고(`chip`/`nl` 유지 — 자연어 카드도 유지) `NUDGED.current|target = true`. 화살표 키도 같은 플래그를 세운다.
점에서 먼 곳의 탭은 지금과 같다. 안내 문구 "점을 끌어서 미세 조정할 수 있어요".

#### 4.1.5 안내 (방향 없는 불만은 좌표를 움직이지 않는다)

최근 `decay.lookback_sessions(10)` 세션에서 같은 지금 단어에 `mood_mismatch`(위치 ≤ 2 이거나 위치 없음)가
`calib.prompt_after_mismatch(2)` 번 이상이면, 그 단어를 다시 고를 때 한 번 안내한다:
"지난번 첫 곡이 기분과 달랐다고 하셨어요. 점을 끌어서 지금 기분에 맞춰 볼까요?" — 사용자가 끌면 그것이 정상 관측이 된다.
같은 안내는 `wp_personal_v1.calib_prompt_seen` 에 적어 7일 안에 반복하지 않는다.

- **콜드스타트**: δ = 0, 치환·편향 없음 → fix-web 과 같은 좌표.
- **설명**: "‘불안해요’를 고르시면 보통 조금 더 가라앉은 쪽(활력 −0.08)으로 옮기셔서 여기서 시작해요 — 직접 옮기신 3번 기준. [원래 위치로]"
- **P2(선택)**: 자연어 단어 치환(`nl_v2.corrections` 에서 같은 치환 ≥ 3회 · 비율 ≥ 0.6 → 미리 바꿔 두고 되돌리기 제공),
  강도 편향(강도 수정 합의 부호가 일관되면 Gemini 의 강도 2 만 ±1). 둘 다 `calib.nl` 하위 키, 기본 꺼짐.
- **시험**: (단위) 계산 예 −0.077 ± 1e−9 · 0.5 넘기 보호 · 탭은 관측 아님 · 받아들임 가중 · 옛 기록 정확 일치만.
  (합성 사용자 P7) 「불안해요」 참값 (−0.05, +0.08), 보여 준 점이 참값에서 0.05 넘게 벗어나면 확률 0.5 로 참값 + N(0, 0.02) 로 끌기.
  **합격**: 10세션 뒤 |δ̂ − δ*| ≤ 0.04 인 반복 비율 ≥ 80% · 대조군(P0·P11) |δ| ≤ 0.02 ≥ 90%.

### 4.2 목표 해석 — 목표 단어의 좌표 보정 (P1)

4.1 과 **같은 학습기**를 필드 `target`(`GOAL_CHIPS`·`NL_GOALS`)에 적용한다. 신호도 같다(`input.labels.target`, `input.table_point.target`,
`input.calib_applied.target`, `input.nudged.target`). 목표 칩 좌표도 사람이 어림으로 찍은 값(`GOAL_CHIPS` 주석 "문구·위치는 팀에서 자유롭게")이므로,
사람마다 "차분해지고 싶어요"의 위치가 다른 것을 본인이 옮긴 만큼만 반영한다.

- **목표를 자동으로 옮기지 않는다**(I4). 끝 기분(`end_va`)이나 `post_change` 로 목표를 당기는 제어기는 두지 않는다(심사 B-1).
- `arrival_mismatch`(방향 없음)가 같은 목표 단어로 2회 이상이면 안내: "지난번 끝 분위기가 원한 것과 달랐다고 하셨어요. 목표 점을 끌어서 맞춰 볼까요?"
- **P2**: 「듣고 난 뒤」 접힌 칸의 선택 입력 "끝났을 때 기분은 어디쯤이에요?"(작은 평면 탭) → `post_change.end_va{v,e}`, `end_va_touched`. **학습에 쓰지 않고 기록만** 한다(나중 분석용).
- **설명**: "‘차분해지고 싶어요’ 목표를 평소 옮기시던 곳(기분 +0.04)에 두었어요. [원래 위치로]"
- **시험**: 4.1 과 같음(목표 필드 버전) + "목표 좌표는 사용자 옮김 관측 없이는 절대 바뀌지 않는다"(무작위 세션 1,000개 속성 시험).

### 4.3 ISO 경로 — 속도(도착 시점) π → 전환점 tp (P0, 이탈 가드는 P1)

#### 4.3.1 신호 (방향이 있는 것만)

| 신호 | 표 v | 가중 w |
|---|---|---|
| 속도 버튼 '빠르게'/'천천히'를 그 세션에 직접 누름(`pace_choice` 이벤트·`input.pace_user`, 옛 기록은 `input.pace_mode`) | +1 / −1 | `pace.w_chip(1.5)` |
| **새 한 번 누르기 답**(「듣고 난 뒤」 카드, 늘 보이는 한 줄): "더 빨리 도착했으면" / "딱 좋았어요" / "더 천천히" (`post_change.pace_answer ∈ {faster, ok, slower}`) | `π_used + 0.5` / `π_used` / `π_used − 0.5` (±1 로 자름) | `pace.w_answer(1.0)` |

- `π_used` = 그 추천에 실제로 쓴 π(로그 `input.personal_meta.params.pi_used`). 버튼을 눌렀으면 +1/−1, 자동이면 그때 적용한 π(적용 문턱 미만이면 0), 옛 기록은 0.
- `arrival_mismatch`·조기 이탈·`post_change.change` 는 **속도 표가 아니다**(방향을 모른다 — 심사 B-4).

#### 4.3.2 추정 (가우스 축소 = 사전 N(0) 에 무게 k0)

`π = clamp( Σ_j γ^j·w_j·v_j / (Σ_j γ^j·w_j + pace.k0(1.0)), −1, 1 )`, j = 몇 세션 전(0 = 가장 최근), γ = `decay.session_gamma(0.85)`.

적용: |π| ≥ `pace.apply_abs(0.15)` 일 때만. 아니면 π_used = 0(규칙 표 그대로).

> **변경 (2026-09-29, 1차 수정)** — `pace.apply_abs` 0.15 → **0.3**. "딱 좋았어요" 표가 그때 쓴 π_used 에 투표하므로 잡음 한 번이 적용되면 스스로 굳었다
> (대조 P11 F1 π 위반 11/50세션). 문턱 0.3 에서 F1 76 → 84%, D1 P1 100%·P2 80%. `k0` 2 안(F1 80%)은 E1·E3 이 나빠 채택하지 않음.

#### 4.3.3 π → tp, 우선순위

`at_def = transitionAt(rules, 분)` (15분 이하 1.0 · 25분 이하 0.75 · 그 이상 0.6)
- π ≥ 0: `tp = at_def − π·(at_def − pace.tp_fast(0.5))`
- π < 0: `tp = at_def + |π|·(pace.tp_slow(1.0) − at_def)`
- 곡 수 n ≤ `pace.small_n_max(3)` 이면 `tp ≥ pace.small_n_min_tp(0.75)` (n=3 에서 t = 0,1,1 퇴화 방지 — rules 의 min_step_span_evidence).
- 고긴장이면 `tp ≥ at_def`(자동은 기본보다 빠를 수 없음, I5).

**우선순위(엔진, L517)**: `inputs.pace` 가 있으면 `rules.personalization.pace.manual_tp[pace]`(fast 0.5 / slow 1.0 — 앱의 `PACE_TP` 를 옮긴 값) →
없고 P 가 있으면 `P.tp`(null 이면 표) → 둘 다 없으면 `transitionAt(rules, dur)`(2.5.1 식 그대로).
앱 L3477–3483 의 "규칙 사본" 방식은 지우고 **모든 사용자(익명 포함)** 가 `inputs.pace` 를 쓴다 — 값이 같아 결과가 같다(I0 에 포함해 검증).
`inputs.pace` 처리는 `personalization.enabled` 와 **무관**하다(개인화가 아니라 사용자의 선택이므로 끄는 스위치가 켜져도 동작).

**계산 예**: 30분(n = 8, at_def 0.6). 한 번 '빠르게'를 눌렀다(v = +1, w 1.5) → π = 1.5/(1.5+1) = **0.60** →
다음 세션 자동이면 tp = 0.6 − 0.6·0.1 = 0.54 → 도착 곡 = ceil(0.54·7)+1 = **5번째**(기본 6번째). 감정 변화 지도에서 도착 표시가 한 칸 앞당겨진다.
그 세션에 "딱 좋았어요"(v = 0.60, w 1) → π = (0.85·1.5 + 0.60)/(0.85·1.5 + 1 + 1) = 0.57.

#### 4.3.4 이탈 가드 (P1) — "목표에 닿기 전에 늘 멈춘다면 더 일찍 닿게"

- 도달 비율 `f = (재생이 시작된 마지막 경로 위치) / n_path`. 곡을 넘기면 f 가 커질 뿐이므로 **넘김(취향)은 이 값을 줄이지 않는다** — 멈춤만 줄인다.
- 제외: 10분 안에 새 추천을 받은 세션(다시 요청 — 멈춤이 아니라 교체), 노출 0 세션.
- 최근 10세션에서 `pace.quit_guard.min_sessions(5)` 이상이면, `pace.quit_guard.prior_sessions(2)` 개의 가상 세션(f = 1)을 더한 가중 중앙값 `f_med`.
- `f_med < pace.quit_guard.apply_below(0.9)` 이면 정책에 `quit_frac = f_med`. 엔진이 곡 수 n 을 안 뒤
  `K = max(2, floor(f_med·n))`, `tp ≤ max(0.5, (K − 1)/(n − 1))` 로 상한을 건다(도착 곡 번호 = ceil(tp·(n−1)) + 1 ≤ K).
- 사용자가 '천천히'를 직접 눌렀거나 고긴장이면 적용하지 않는다.

- **훅**: 엔진 L517 (`at` 결정) + `quit_frac` 상한. 앱: L3477–3483 삭제, `engineInput.pace = PACE_MODE`.
- **UI**: 속도 칸의 `#paceNote` — 자동이 개인화되면 "자동(나에게 맞춤): 조금 빠르게 — ‘빠르게’ 1번 · ‘더 빨리’ 1번 기준". 버튼을 누르면 그게 이긴다. 버튼을 누를 때 `pace_choice{choice, suggested, source}` 기록.
- **설명 칩**: "빠르게 도착 · 5번째 곡" / "보통 5번째 곡쯤에서 멈추셔서 그 전에 목표에 닿게 했어요".
- **시험**: (단위) π ∈ {−1, −0.6, 0, 0.6, 1} × {15, 30, 60}분 → tp·도착 곡 표 · n ≤ 3 보호 · 고긴장 하한 · 버튼 우선.
  (합성) P1 π* = +0.8, P2 π* = −0.7: 답할 확률 0.7, |π* − π_used| > 0.25 이면 방향 답, 아니면 "딱".
  **합격**: 5세션 안에 P1 π ≥ 0.35, P2 π ≤ −0.35 인 반복 ≥ 80% · 대조군 |π| ≤ 0.3 ≥ 80% · P9(5곡째 이탈) 6~10세션에서 도착 곡 ≤ 이탈 지점인 세션 ≥ 80%.

### 4.4 ISO 경로 — 시작 오프셋 s (P1, 팀 결정 D2)

첫 곡을 지금 기분 그 자체가 아니라 목표 쪽으로 한 걸음 나간 곳에서 시작한다. ISO 시작 일치는 치료 전제이므로 **기본 0, 명시 확인이 있을 때만** 올린다.

- **팔**: `start.arms` = {0, 0.075, 0.15}. 고긴장 상한 0.075(I5). 여정 거리(작업 좌표) < `start.min_journey(0.15)` 이면 적용 안 함.
- **신호**: web-personal 세션의 경로 첫 곡 노출과 나머지 이동 구간 곡(2..n_move) 노출. 거절 = 조기 넘김 또는 그 곡의 `dislike_reason: mood_mismatch`. (`not_my_taste` 는 취향 신호라 넣지 않는다 — 취향 몫은 q 가 따로 뺀다.)
- **취향 통제 비율**(심사 B-2·C-2 수정): 현재 팔로 치른 최근 10세션에서
  `SR_1 = (O_1 + 2·p̄)/(E_1 + 2·p̄)`, `SR_rest = (O_rest + 2·p̄)/(E_rest + 2·p̄)` — O 는 거절 수, E = Σ q(§3.4), p̄ = 전체 거절률.
  `ratio = SR_1 / SR_rest`.
- **올림**(한 칸): `n_1 ≥ start.min_first_songs(5)` ∧ `ratio ≥ start.ratio_up(1.5) × start.pop_first_ratio(1.2)` ∧
  같은 창에 사용자 출처 `mood_mismatch`(위치 ≤ 2) 1회 이상 — 셋 다.
  `pop_first_ratio` 는 "누구나 첫 곡을 조금 더 넘긴다"는 모집단 기저비(사전값 1.2, 실제 로그로 TOOLS 가 재추정).
- **내림**(한 칸): 현재 팔 > 0 에서 위치 1 `mood_mismatch` 가 `start.down_mismatch_n(2)` 번, 또는 사용자 초기화.
- 팔이 바뀌면 그 뒤 세션만 센다(이력 현상 — 진동 방지).
  > **변경 (2026-09-29, 1차 수정) — 전환 통제.** `start.expect_transition = true` 이면 이동 곡의 기대 거절 `E_rest = Σ q · Π_f m_f`
  > (들어온 전환이 큰 변화인 특징 f 마다 §4.8.3 의 적합 배수 m_f, 적용 문턱 전). 이동 곡 거절엔 들어온 전환 몫이 섞이고 첫 곡엔 없어서 q 만으로 표준화하면
  > 첫 곡의 초과 거절이 가려졌다(P10 비율 0.33–1.61 < 1.8). 대조(P0·P11·P1·P3·P5)는 확인 조건(mood_mismatch ≥ 1) 때문에 s = 0 그대로.
- **훅**(엔진 L517 직전): `s0 = P && P.start_offset > 0 && journey >= P.start_min_journey ? P.start_offset : 0`,
  `startC = s0 > 0 ? [nowC[0] + (tgtC[0]−nowC[0])·s0, nowC[1] + (tgtC[1]−nowC[1])·s0] : nowC`, `waypoints(startC, tgtC, n, at)`.
  곡 수(L497–501)와 진행 페널티·머묾 정렬은 계속 `nowC` 기준.
- **설명**: "첫 곡을 자주 넘기셔서(첫 곡 5번 중 3번) 지금 기분에서 한 걸음 목표 쪽에서 시작해요."
- **시험**: (합성) P10 참값: 첫 곡이 보고한 상태에 가까우면 조기 넘김 확률 +0.4. **합격**: 10세션 안에 s > 0 인 반복 ≥ 50% ·
  6~10세션 첫 곡 조기 넘김률 ≤ 0.8 × 쌍둥이 · 대조군·취향만 강한 페르소나(P1·P3) s = 0 100%.

### 4.5 곡 수 / 길이 — 기본 감상 시간 제안 (P1)

곡 수는 감상 시간(사용자 선언)에서 나온다. 선언을 조용히 바꾸지 않고(I4), **다음 세션의 기본값만 제안**한다(보이고, 바꿀 수 있다).

- **기준 시간** `base` = 최근 `length.base_sessions(5)` 세션(두 앱)의 실제 사용 시간(`input.effective.minutes`, 옛 기록 `recommend_minutes`) 중앙값.
  자연어가 시간을 정한 세션은 제외(그날만의 조건). 기록이 없으면 `users.recommend_minutes` 또는 30.
- **방향 신호**: `length` 를 고르면 바로 아래 나타나는 새 하위 칩 "길었어요 / 짧았어요"(`post_change.length_dir ∈ {long, short}`).
  방향 없는 `length`·AI 가 고른 `length` 는 표가 아니다.
- **추정**(log2 분 척도, 절대값 — 기준 시간에 배수를 곱하지 않으므로 제안을 받아들인 뒤 기준이 내려가도 이중 적용되지 않는다):
  방향 답이 있는 세션 j 의 표 `v_j = log2(그 세션 실제 시간) + length.vote_step_log2(0.3)·(short ? +1 : −1)`,
  `L = (Σ_j γ^j·v_j + length.k0(1)·log2(base)) / (Σ_j γ^j + length.k0(1))`, `bias = clamp(L − log2(base), −0.5, +0.5)`,
  |bias| ≥ `length.apply_abs_log2(0.1)` 일 때만 적용. 방향 답이 그치면 표는 γ 로 옅어지고 기준 시간(최근 실제 시간)이 닻 역할을 해 멈춘다.
- **적용**(앱): `personal.suggestMinutes(MODEL, base, RULES)` → `{ minutes: clamp(5의 배수 반올림(2^(log2(base)+bias)), 5, 90), bias_log2, applied }`.
  감상 시간 슬라이더를 이 값으로 미리 두고 한 줄 안내 "지난번 ‘길었어요’ → 25분으로 맞춰 뒀어요 [되돌리기]".
  계산 예: 30분에서 ‘길었어요’ 1번 → L = (log2 30 − 0.3 + log2 30)/2 → 27.0분 → **25분**. 25분에서 두 번 더 ‘길었어요’ → 약 22분 → **20분**.
  로그: `input.minutes_base`, `input.minutes_suggested`, `input.effective.minutes`.
- 앱이 추천마다 `recommend_minutes` 를 계정에 덮어쓰던 동작(L3546–3548)은 없앤다(B2) — 기본값은 이 제안이 맡는다.
- 엔진 훅 없음(곡 수 규칙 `iso.song_count` 그대로). ISO 도착 시점의 개인화는 §4.3(속도·이탈 가드)이 맡는다.
- **설명**: "여정 길이: 보통 25분 — ‘길었어요’ 2번".
- **시험**: (합성) 선호 20분인 페르소나가 30분으로 시작해 `length + long` 을 답함. **합격**: 6세션 안에 제안 ≤ 25분 ≥ 80% · 한 번도 안 답한 사용자는 제안 = base 100%.

### 4.6 도착 후 머묾 구간 — 반경 r 과 순서 (P0, 학습 규칙은 P1)

#### 4.6.1 모집단 기본값 (P0, 신규 사용자부터)

- **반경**: `hold.p0_radius(0.035)`. 곡 수 n < `hold.min_songs(5)` 이면 0 (15분 이하 — 도착 걸음이 마지막 곡 하나뿐이라 반경만큼 도착 오차가 커진다: 15분 r=0.035 도착 오차 중앙 0.030).
- **순서**: `hold.order = "last_fixed_progress"` — 머묾 구간 곡 중 **fit 이 가장 작은 곡을 마지막에 고정**하고, 나머지를 진행 방향 투영
  `along = (c − nowC)·(tgtC − nowC)` 오름차순(같으면 fit 내림, 그다음 song_id)으로 앞에 둔다.
- 근거(측정, 1,224세션): 2.5.1 은 같은 곡으로 끝남 100%·머묾 겹침 100%. r = 0.035 는 같은 곡으로 끝남 25.3%·겹침 31.9%, 도착 오차 중앙 0.007→0.015(30·45분)·0.021(전체),
  꺾임 18.5%(거리 순 재배열). 진행 방향 순(제안 B)은 꺾임 8.3% 이지만 "마지막 곡이 가장 가깝지 않음" 46.0%.
  마지막 곡 고정 + 진행 방향 순은 지그재그 0% 를 구조적으로 보장하고 꺾임은 둘 사이로 예상 → §11 에서 측정해 확인한다(꺾임 ≤ 12%).
- **P2 후보** `last_fixed_smooth`: 나머지(≤ `hold.smooth_max_tail(6)`−1 곡)를 `Σ(adjCost + λ·jump)` 가 최소인 순열로(동점은 진행 방향 순).
  스윕에서 꺾임이 `last_fixed_progress` + 2%p 이내일 때만 채택.

> **변경 (2026-09-29, 1차 수정) — 머묾 구간 다섯 가지** (P 모드만, 중립 정책·P === null 은 그대로 — I0/I1). 숫자와 측정은 `hold.*_evidence`.
> 1. **밀도 적응 반경** `hold.min_pool(12)`: 반경 안 후보(게이트·싫어요·최근 창을 거친 뒤)가 12곡 미만이면 12번째로 가까운 후보까지 넓힌다.
>    상한 `hold_radius_cap` = `bounds.hold_radius[1]`(0.05), 고긴장 0.035(I5). 좁힌 팔(r < p0_radius)은 넓히지 않는다(`hold_min_pool = 0`).
> 2. **도착 상한**: 머묾 걸음에서 "도착한 곡"(거리 0·가점 허용)의 반경은 `min(r, 마지막 이동 곡의 목표 거리 + envelope.reversal_eps)` —
>    그보다 먼 곡을 머묾 첫 곡으로 두면 §11 B3 의 역행이다(새 숫자 없음).
> 3. **머묾 묶음** `hold.cluster = true`: 머묾 곡끼리 서로 `envelope.turn_min(0.02)` 안이어야 "도착한 곡"이다. B3 의 90° 꺾임은 두 걸음이 모두 turn_min 을
>    넘을 때만 세므로 머묾 곡 집합의 지름이 turn_min 이하면 어떤 순서든 머묾 안 꺾임이 없다. 묶음 밖 곡은 반경 밖 곡처럼 실거리 비용(곡이 모자랄 때만 쓰임).
>    페르소나 B3 꺾임 21.3% → 5.6%, 격자 9.4% → 4.2%(아래 4 까지 넣은 최종: 5.3% · 4.4%).
> 4. **머묾 경로 비용 양자화** `hold.quantize_path = true`: 머묾 걸음의 진행·λ 전환 비용도 `pers_bucket` 으로 0 쪽 양자화 — 한 칸 미만의 기하 차이는 동률로 두어
>    시드가 머묾 곡·마지막 곡을 가른다. 묶음만 켜면 같은 곡으로 끝남 38.1% → 52.2% 로 늘었는데 이것으로 40.1%.
> 5. **순서** `hold.order = "last_fixed_turn"`: 곡 집합·마지막 곡(최소 fit) 고정은 `last_fixed_progress` 와 같고, 나머지(≤ smooth_max_tail − 1 곡)는
>    (이동→머묾 역행, 앞 두 곡부터 이은 90° 꺾임 수)를 사전식으로 최소화하는 순열(같으면 진행 방향 순).
>
> **B5 "같은 곡으로 끝남 ≤ 35%" 는 봉투 안에서 닿지 못했다**(40.1%, 2.5.1 100%): 목표 칩 좌표 근처가 성긴 '잠들고 싶어요'(0.035 안 0곡 — B1 도착 90% ≤ 0.036 이라
> 가장 가까운 곡으로 끝나야 함)와 '푹 쉬고 싶어요'(5곡)가 각각 100%·92% 로 약 22%p 를 차지한다. 나머지 여섯 칩은 16–38%. 팀 결정: 기준 유지(칩별 보고) ·
> B5 를 반경 안 12곡 이상인 칩에서만 재기 · 두 칩 좌표 재검토 중 하나(change.md).
>
> **변경 (2026-09-30, 2차 수정) — 묶음 깨기 비용** `hold.cluster_break = "j_hold"`: 도착 영역(fit ≤ 도착 상한 rCap) 안이지만 머묾 묶음 밖인 곡의 거리 비용을
> 실거리 대신 `min(j_hold, rCap)` 로 둔다. 실거리면 묶음이 모자랄 때마다 목표에 가장 가까운 곡이 늘 끼어 마지막 곡(최소 fit)이 시드와 무관하게 정해졌다
> ('푹 쉬고 싶어요': 0.035 안 5곡 중 서로 0.02 안인 쌍은 하나뿐 → 모든 시드가 가장 가까운 곡으로 끝남). 일정 비용이면 묶음 깨기 후보끼리 동률이라 시드가 고르고,
> 도착한 곡(0)보다 비싸고 반경 밖 곡(실거리 > rCap)보다 싸다(1차의 순서 유지). 새 숫자 없음(머묾 결합 제한 J). 한 칸(pers_bucket)으로 두면 페르소나 꺾임 11.1%,
> 둘째 머묾 걸음부터 순서 무관 비용까지 더하면 14.0%(B3 불합격)라 버렸다.
> 이 변경과 §3.8 흔들기로 **B5 가 봉투 안에서 닿는다**: 같은 곡으로 끝남 33.5%(다른 시드 묶음 Q4–6 33.3% · Q7–9 30.9%), 칩당 머묾 곡 15.1,
> B1 0.013/0.035 · B2 0.150 · B3 0.7%/6.5%/0 · B4 0.017. 칩별: 푹 쉬고 92.2 → 65.7%, 잠들고 98%(0.036 안 1곡 — 둘째 곡 0.048 은 안전 확인 arrival_abs 0.04 밖이라 남김),
> 나머지 9.8–31.4%. 위 1차 기록의 "닿지 못했다"는 1차 기준이다. 표는 `hold.cluster_break_evidence`.

#### 4.6.2 개인 학습 (P1, 규칙 기반·이력 현상)

- **팔**: `hold.arms` = {0, 0.02, 0.035, 0.05}. 시작은 P0(0.035 또는 0).
- **좁힘**(한 칸 아래): 현재 팔 이후 최근 10세션에서 `arrival_mismatch` 가중 합 ≥ `hold.arrival_mismatch_min(2)`
  (세션 코드: 사용자 1 · AI 유지 0.5 / `dislike_reason: arrival_mismatch` 가 머묾 구간 곡에 1).
- **넓힘**(한 칸 위): 같은 창에서 머묾 구간에 걸린 `too_repetitive` 가중 합 ≥ `hold.repetitive_min(2)`
  (곡 단위 `dislike_reason: too_repetitive` 가 머묾 곡에 1 / 세션 코드의 `note_ai.positions` 가 모두 머묾 구간일 때 사용자 1·AI 0.5).
- 좁힘이 넓힘보다 우선. 고긴장 `min(r, 0.035)`. n < 5 이면 0. 머묾 곡의 조기 넘김은 **쓰지 않는다**(취향).

- **훅**: `stepCandidates` L452 → `const distCost = arrival ? (P && fit <= rEff ? 0 : fit) : bandIdx * band;`
  (`rEff = n >= P.hold_min_songs ? P.hold_radius : 0`, P 없으면 원래 식 그대로).
  재배열 L566–575 → `P ? orderHold(tail, P, …) : 2.5.1 정렬 그대로`. 중립 정책은 `hold_order = "fit"` = 2.5.1 정렬.
- **설명**: "끝 분위기가 원한 것과 달랐다는 기록이 있어 마지막 곡들을 목표에 더 가깝게 모았어요." /
  "도착 뒤 같은 곡이 반복된다는 기록이 있어 목표 근처에서 더 넓게 골랐어요." / 경로 표시 "7번째 곡부터 목표 분위기에 머물러요."
- **시험**: (규칙 단위) 세션마다 사용자 출처 `arrival_mismatch` 를 넣은 합성 기록 → 2세션 뒤 r = 0.02, 4세션 뒤 r = 0(두 칸), 그 뒤 도착 오차 중앙 ≤ 0.010. 반복 싫음 P4 → r = 0.05.
  15분 세션 r = 0 100% · 모든 페르소나 지그재그 0%.

### 4.7 곡 취향 (P0, 발견 칸은 P1, 인기도는 P2)

#### 4.7.1 취향 항목 만들기 (`personal.js`, 앱의 `buildHeardItems` L2328–2365 를 대체)

곡마다 항목 하나. 판단 순서는 지금 앱과 같다(명시 상태가 있으면 청취 표를 쓰지 않는다):

| 곡의 상태 | 항목 |
|---|---|
| 싫어요 중(`users.dislikedSongs`) | `{ disliked:true, reason }` — 이유는 `wp_personal_v1.dislike_reasons` ∪ 최신 `dislike_reason` 이벤트(400건 창에서 사라져도 남음, B16) |
| 좋아요 중 / 벽·선호곡(`playlists` ∪ `favorite_tracks`) | 지금과 같이 `liked` / `pinned` 플래그 (2.5.1 코드 기준 `src:"playlist"` 곡도 핀으로 센다 — 유지) |
| 그 밖에 청취 표가 있는 곡 | `{ vote: { pos, neg, pin: 0 } }` (§3.2) |
| 벽·선호 가수 | `{ pinned:true, artist }` — 이름 해석(`findArtist`)은 앱이 해서 `RawFacts.profile.pinned_artists_resolved` 로 넘긴다 |
| `preferred_genres` | **항목을 만들지 않는다**(B2·D3 — 세션 장르 선택이 저장돼 '좋아요'로 세이던 오염) |
| `taste_vector` | **읽지 않는다**(B5 — `favorite_tracks` 의 태그 평균이라 이미 핀으로 센 것을 한 번 더 세게 됨) |

각 항목에 `artist, genres, feature_bins, feature_bins_p`(카탈로그 인덱스)와 `days`(그 곡 최신 근거 이후 경과일)를 붙인다.
집계: `aggregateAffinity(items, rules, { scope_add: taste.dislike_scope_add, extra_feature_ids })` — 엔진에 `vote` 분기 한 줄(§6.6).

#### 4.7.2 싫어요 범위 추가

`taste.dislike_scope_add = { arrival_mismatch: [], length: [] }` — 이 두 이유의 싫어요는 **그 곡만 제외**하고 어떤 묶음에도 세지 않는다
(지금은 규칙에 키가 없어 `_no_reason` = 취향 전체 싫어요로 처리됨, B1). 규칙 기본 절 `preference.dislike_scope` 는 그대로 둔다(I0).

#### 4.7.3 반영 강도 μ — 증거량으로 정하는 결정식

```
E  = (좋아요 수) + (취향 싫어요 수: 범위에 artist·features 둘 다) + taste.pin_evidence_w(0.5)·(핀 곡 + 핀 가수) + Σ(청취 표 pos+neg)
μ  = taste.mu_max(0.5) · E / (E + taste.k_mu(8))
```

예: 선호곡 3·가수 2만 → E 2.5 → μ 0.12 · 2세션 뒤(좋아요 3, 끝까지 8곡 = 2.0, 넘김 4곡 = 1.0) → E 8.5 → μ 0.26 · 기록 없음 → μ 0 (2.5.1 과 같은 순위).

- 강도가 세도 **개인 비용 결합 제한(§3.8)** 이 기하를 지킨다: 이동 구간 ±1.5 밴드, 코리도어 밖은 가점 없음, 머묾 구간은 반경 안에서만 가점.
  탐침에서 연주곡 사용자 μ = 0.5(제한 없음)는 도착 오차 0.006→0.019, 최대 전환 0.180→0.220 이었다 — 이 제한이 그 문제를 막는다.
- μ 에 보상 학습은 없다(심사 A-1). "μ 가 바꾼 곡"은 걸음별 `p_chosen_by = "taste"` 로 기록해 설명·진단에만 쓴다.

> **변경 (2026-09-29, 1차 수정) — 유의한 묶음만 · μ 상한 1.0.** 청취 표 한 표(`listen_vote.unit`)를 관측 1회로 보고
> `z = |p̂ − p0|·√((n/unit)/(p0(1−p0)))` 가 `taste.group_z_min(1.28)` 미만인 가수·장르·특징 묶음은 엔진에 넘기지 않는다(엔진에선 '모르면 내 평균' p0).
> 벽(pin)이 있는 묶음과 곡 자체 기록(`song_likes`)은 늘 남긴다. 학습 모드(personal·geometry)에서만 — p0·중립은 영향 없음.
> 취향 없는 페르소나도 1–2표 잡음 묶음으로 μ·여백 0.10–0.15 band 를 얻어 전환 비용(≤ 0.5 band)을 덮던 문제(P4·P6·P8 넘김 frozen 대비 +7%p) 수정.
> 잡음을 거른 뒤라 `taste.mu_max` 0.5 → **1.0**(식은 그대로 μ = mu_max·E/(E+8)): 위 계산 예는 μ 0.24 · 0.52 가 된다. 근거 `taste.group_z_evidence`.
- **훅**: L525 → `const mu = P ? P.mu : Number(rules.preference.pref_weight || 0);` · key(L467)·비용(L547)은 §3.8 의 P 분기.

#### 4.7.4 새 가수 발견 칸 (P1)

- 조건: `μ ≥ taste.discovery.min_mu(0.15)` ∧ `E ≥ taste.discovery.min_E(4)` ∧ 고긴장 아님 ∧ 일시정지 중 아님.
- 정책은 `discovery_u = seededUniform(seed, "discovery")` 만 넘긴다. 엔진이 이동 걸음 수 `n_move` 를 안 뒤
  `n_move ≥ taste.discovery.min_moving_steps(3)` 이면 걸음 `1 + floor(u·(n_move − 1))`(첫 곡·머묾 제외)를 발견 칸으로 쓴다.
- 발견 칸: 코리도어 안에 **가수 키가 `artist_affinity` 에 하나도 없는 곡**이 있으면 후보를 그 곡들로 좁히고 그 걸음의 취향 항을 0 으로 둔다(전환·기하는 그대로). 없으면 평소대로.
- 일시정지: 발견 곡이 연속 `pause_after_skips(3)` 번 조기 넘김되면 다음 `pause_sessions(3)` 세션 동안 끔.
- trace `p_discovery: true`, 설명 "이번엔 아직 안 들어본 가수의 곡도 하나 넣어 봤어요."

#### 4.7.5 인기도 특징 (P2, 기본 꺼짐)

`taste.extra_features_available = [{ id:"popularity", field:"popularity", bins:3, label:"알려진 정도", zero_is_unknown:true }]`.
켜면 `taste.extra_features` 로 옮긴다. 경계는 **전체 카탈로그의 0 이 아닌 값** 3분위(엔진 새 export `makeExtraBinner`), 0 은 '모름'(묶지 않음).
결과는 곡의 `feature_bins_p` 에만 들어가므로 `preference.features` 와 기본 경로는 그대로다. `prefDetail(song, rules, user, extraSpecs)` 가 P 모드에서만 추가로 평균에 넣는다.

- **설명**: 기존 `by_my_record` "내가 좋아요한 곡들과 닮았어요 ({pref_basis})" 그대로. 세션 칩 "재즈 취향 반영 (좋아요 4 · 끝까지 3)".
  패널 카드 "곡 취향": 내 평균보다 높은 묶음 3개·낮은 묶음 2개를 횟수와 함께("재즈 · 좋아요 4 · 끝까지 들음 3 · 넘김 1"), 강도 막대 "취향 반영 강도: 중간 (기록 18곡)".
- **시험**: (단위) 청취 표 표(§3.2)의 모든 종료 원인·미리듣기 반값·곡당 상한 1·명시 우선·`arrival_mismatch` 싫어요는 제외만·`preferred_genres` 항목 없음·μ 식.
  (합성 P1 재즈 7%, P2 연주곡 17%, P3 K-발라드 46%, P5 벽 아이유 1%) **합격**: 6~10세션 좋아하는 묶음 비율 ≥ max(1.5 × 쌍둥이, 쌍둥이 + 10%p)
  (P5 는 쌍둥이 + 5%p) · 같은 세션의 도착 오차·최대 전환은 §11 봉투 안 · 잡음 페르소나 P11 좋아하는 묶음 비율 = 쌍둥이 ± 5%p.

### 4.8 곡과 곡 사이 연결 — 인접 전환 비용 (P0)

지금 엔진은 인접 곡을 V/A 거리로만 잇는다: 추천 인접 쌍 BPM 차 중앙 28.3(무작위 29.7) · 보컬↔연주 전환 11.3% · 두 개 이상 어긋난 전환 36.6%(660회 측정).
"보컬량"을 직접 나타내는 데이터는 없다 — 쓸 수 있는 것은 연주곡 여부(0/1)와 말 비중(`spokenness`, 랩·말하듯 하는 정도)이다(9차). 그래서 목소리 결은 두 특징으로 표현한다.

#### 4.8.1 쌍 특징 x_f(a, b) ∈ [0, 1] (엔진 `adjFeatures`, 값을 모르면 0)

| f | 정의 | 근거 |
|---|---|---|
| tempo | `bpm(s) = 50 + 150·s.tempo`(계약 필드 `tempo` = 0~1 빠르기 태그), Δ = \|bpm_a − bpm_b\|, `x = min(1, Δ / adjacency.bpm_scale(60))`. `half_double_fold`(기본 false) 가 켜지면 Δ = min(\|a−b\|, \|2a−b\|, \|a−2b\|) | 60 ≈ 무작위 쌍 90% 68.3 근처. 측정 지표(tempo×150)와 같은 정의라 비교 가능. 원 BPM 은 카탈로그 CSV 에 없어 앱·시뮬레이터가 같은 값을 쓰려면 태그를 쓴다 |
| vocal | 둘 다 불리언이고 `instrumental` 이 다르면 1 | 무작위 27.8%, 엔진 11.3% |
| spoken | `min(1, \|sp_a − sp_b\| / adjacency.spoken_scale(0.5))` | 추천 쌍 중앙 0.278 |
| genre | 둘 다 버튼 장르가 있고 겹치지 않으면 1 | 버튼 장르 공유 33.6% |
| va (학습 전용) | 작업 좌표 전환 거리 ≥ `adjacency.large.va(0.15)` 이면 1 | 이동 구간 중앙 0.135 |

#### 4.8.2 모집단 기본 비용 (P0, 신규 사용자부터)

`adjCost(a, b) = Σ_{f∈{tempo,vocal,spoken,genre}} P.adj_w[f] · x_f(a, b)`,
`P.adj_w[f] = band · adjacency.base_weights_bands[f] · adjacency.scale · m_f` (band = `preference.band` 0.025).
기본 `base_weights_bands = { tempo 0.4, vocal 0.3, spoken 0.15, genre 0.15 }`(합 1 밴드), `scale = 1.0` — **사전값, 스윕으로 확정**(D7).
의미: 기본값에서 전환 비용 전체가 순위 해상도 한 칸(1 밴드)을 넘지 않는다. 결합 제한(§3.8) 때문에 배수를 최대로 올려도 1.5 밴드에서 멈춘다.
전환 비용은 λ 와 같은 **전환 비용**이지 적합도 점수가 아니다(원칙 9: 태그는 문턱·전환 비용으로만).

**스윕**(TOOLS, D7): `scale ∈ {0, 0.5, 1, 1.5, 2}` × `half_double_fold ∈ {false, true}` 를 660 격자·1,224 격자에서 돌려,
§11 ISO 봉투(B1–B5)를 모두 지키는 값 중 구성 목표(C1)를 가장 많이 달성하는 가장 작은 scale 을 채택하고 근거 문자열에 표를 붙인다.

#### 4.8.3 개인 배수 m_f — 취향 오프셋을 둔 결합 곱셈 모형 (P0 학습기, 적용 문턱 있음)

전환 i = (a → b) 는 §3.3 의 라벨 y_i ∈ {0, 1}, 가중 `w_i`(출처 가중 × 0.5^(age/45일) × 옛 기록 0.5), 큰 변화 표시
`L_if ∈ {0,1}`(tempo: BPM 차 ≥ `large.tempo_bpm(30)` · vocal: 전환 · spoken: 차 ≥ `large.spoken(0.25)` · genre: 불일치 · va: ≥ 0.15)를 가진다.

```
기대 거절 μ_i = q_i · m_0 · Π_f m_f^{L_if}          // q_i: 취향 기대 거절률(§3.4), m_0: 이 사람의 전반적 넘김 성향
사전: m_0, m_f ~ Gamma(κ, κ)  (평균 1), κ = adjacency.kappa(2)
순환 갱신 20회(adjacency.iterations):
  m_0 ← (Σ_i w_i y_i + κ) / (Σ_i w_i q_i Π_f m_f^{L_if} + κ)
  각 f: m_f ← (Σ_i w_i L_if y_i + κ) / (Σ_i w_i L_if q_i m_0 Π_{g≠f} m_g^{L_ig} + κ)
  ln m_f 를 [ln 0.5, ln 2] 로 자름
```

- 다섯 특징을 **동시에** 맞추므로 보컬 전환↔말 비중, 빠르기↔V/A 거리처럼 같이 움직이는 특징의 공을 나눈다(심사 B-3).
- 취향으로 설명되는 넘김은 q 가 먼저 가져가고, 사람마다 다른 전반적 넘김 성향은 m_0 가 가져간다 → m_f 는 "같은 사람·같은 취향 여백에서 큰 변화 뒤에 더 넘기나"만 본다.
- **적용 문턱**(심사 A-3): `|ln m_f| ≥ adjacency.z_apply(1.28) / sqrt(O_f + κ)`(80% 구간이 1 을 벗어남) ∧ 큰 변화 쌍 수 ≥ `min_large(8)` ∧ 전환 총수 ≥ `min_transitions(12)`. 아니면 `m_f = 1`.
- 적용 범위 `mult_range = [0.5, 2.0]`, 고긴장이면 `max(m_f, 1)`.
- 계산 예(빠르기 민감, 3세션, 다른 특징은 1로 둠): 큰 빠르기 변화 뒤 8번 중 4번 넘김, 작은 변화 뒤 10번 중 1번, 모든 곡 q = 0.15 →
  순환 갱신이 m_0 ≈ 1.26, m_tempo ≈ 1.70 으로 수렴. 문턱 1.28/√(4+2) = 0.52 ≤ ln 1.70 = 0.53 → 적용(겨우 넘음). "빠르기를 1.7배 신경 써서 이어요".
  둔감한 사용자(8번 중 2번 vs 10번 중 2번)는 m_tempo ≈ 1.15, 문턱 1.28/√4 = 0.64 > 0.14 → 적용 안 함(1).

#### 4.8.4 전환 귀속분 a — 스킵 이중 계산 방지

같은 조기 넘김을 취향(−¼)과 전환(y = 1) 양쪽에 다 세지 않도록, 노출 e 의 전환 귀속분
`a_e = clamp(1 − 1 / Π_f m_f^{L_ef}, 0, adjacency.attrib_max(0.8))`(적용된 배수만)를 구해 취향 표를 `(1 − a_e)` 배로 줄인다(§3.2). 배수가 모두 1 이면 a = 0.

#### 4.8.5 V/A 전환 가중 λ

`λ_u = clamp(path.jump_weight(0.1) · m_va, 0.1, 0.25)` — 절대 지금보다 느슨해지지 않는다. 0.25 상한 근거: λ ≥ 0.25 에서 최대 전환이 0.197 로 평탄하고 도착 오차만 는다(2026-09-21 λ 스윕).
**훅**: L524 → `const jw = P ? P.lambda : Number(rules.path.jump_weight || 0);`

#### 4.8.6 엔진 훅

- 빔 상태에 `prevSong`(곡 객체) 추가: L530 초기값 null, L543–552 에서 `prevSong: s`.
- `stepCandidates`(L425) 끝에 인자 `P = null` 추가. P 모드에서만 `adj = state.prevSong ? adjCost(state.prevSong, s, P) : 0` 을 계산해 §3.8 식으로 `pers` 에 넣는다.
  첫 곡(앞 곡 없음)은 adj = 0 → 시작 일치 그대로.
- 머묾 `last_fixed_smooth`(P2)·extras(§4.11)도 같은 `adjCost` 를 쓴다.
- trace(P 모드에서만): `p_adj`, `p_adj_x{tempo,vocal,spoken,genre}`, `p_bpm_diff`, `p_smooth`, `p_smooth_basis`(§6.8).

- **설명**(곡): 기하 최선곡과 다른 곡을 전환 비용 때문에 골랐고 그 차이가 난 특징이 있을 때만(`p_smooth == true`) — "앞 곡과 빠르기·목소리 유무 흐름을 이어 골랐어요."
  (세션 카드) "곡이 바뀔 때 빠르기가 크게 달라지면 넘기시는 편이에요(크게 바뀐 뒤 8번 중 4번, 비슷할 때 10번 중 1번) → 빠르기를 1.7배 더 신경 써서 이어요. (관찰 기반 추정)"
- **시험**: (660 격자, P0) §11 C1. (합성) P6 빠르기 민감(넘김 확률에 +1.5·x_tempo), P2 보컬 전환 민감. **합격**: 10세션 안에 P6 m_tempo ≥ 1.3 인 반복 ≥ 60% ·
  6~10세션 P6 BPM 차 중앙 ≤ 0.8 × 쌍둥이 · P2 보컬 전환율 ≤ 0.5 × 쌍둥이 · **교차 오염**: 아래 대상 페르소나의 적용 배수가 1 이거나 [0.8, 1.25] 인 세션 ≥ 80% ·
  취향만 강한 페르소나(P3)를 q 없이 적합하면 배수가 부풀고(대조 실험 보고), q 를 넣으면 안 부풂.
  (교차 오염 대상: 전환 민감도를 넣지 않은 P0 · P1 · P3 · P5 · P11.)

### 4.9 후보 게이트 — 말 많은 곡 자동 제외 (P1)

- **켜짐**(둘 중 하나):
  (a) 최근 `gates.soft_spoken.window_days(30)`일에 `vocal_bother` 가중 합 ≥ `vocal_bother_min(2)`
      (곡 단위 `dislike_reason: vocal_bother` 가 말 비중 '높음' 묶음 곡에 1 · 세션 코드 사용자 1 · AI 유지 0.5).
  (b) `feature_affinity["spokenness:high"]` 의 축소 점수(엔진 `shrunk` 식, p0 기준) ≤ `rate_ratio_max(0.5)` × p0 ∧ 그 묶음 표 수 ≥ `min_n(6)`.
  > **변경 (2026-09-29, 1차 수정) — 세션 코드 확인** `gates.soft_spoken.corroborate_codes = true`: 세션 코드 `vocal_bother`(사용자·AI)는 그 세션에
  > 말 비중 '높음' 경로 곡을 조기 넘김한 일이 있을 때만 센다(코드에 위치가 있으면 그 위치에서). 곡 단위 `dislike_reason` 은 그대로.
  > 말 많은 곡이 없던 세션의 잡음 코드가 게이트를 켜던 것(P11 F1)을 막는다. 확인을 붙인 코드 한 번은 코드 + 실제 조기 넘김 두 신호라
  > `vocal_bother_min` 2 → **1**([prior] 값 변경 — 팀 확인 필요): P3 는 취향 학습이 말 많은 곡을 먼저 빼서 1–5세션에 1–4곡만 들어 2회에 못 닿았다(D6 20% → 100%). 근거 `gates.corroborate_evidence`.
- **꺼짐**: 마지막 근거로부터 `expire_days(30)`일 지나면 자동 해제(심사 B-5 — 게이트가 그 묶음을 가려 반대 근거가 안 쌓이는 흡수 상태 방지).
  사용자가 결과 화면 칩 "자동: 말 많은 곡 빼는 중 [끄기]"를 누르면 `auto_gate_off` 기록 + `wp_personal_v1.gate_off_until[gate] = +user_off_days(30)일`.
- 문턱은 규칙의 기존 게이트 `exclude_spoken`(상위 20% 제외, 백분위 문턱) 그대로 — 점수화하지 않는다(원칙 9).
- **적용 방식(소프트)**: 엔진이 걸음마다 `stepPool` 에서 소프트 게이트를 통과한 곡만 남기되, 남은 곡이 `gates.soft_min_pool(24)`(= `min_pool` 48 의 절반) 미만이면
  그 걸음은 게이트 없이 쓴다(`p_soft_relaxed: true`). `eligibleUniverse` 는 건드리지 않는다.
  **훅**: L535 다음 `const usePool = P && P.soft_gates.length ? softFilter(stepPool) : stepPool` (+ 폴백).
- **자동 연주곡 게이트는 두지 않는다** — 가사 조건은 사용자 선언이고(I4), 연주곡 취향은 μ 가 반영한다.
- 가사·장르 선언(`instrumental_only`·`prefer_vocal`·장르 버튼)은 지금 그대로 하드 조건. 장르 정책 `hard_if_sufficient` 그대로.
- **설명**: "말이 많은 곡(랩·내레이션)은 빼고 골랐어요 — ‘가사·목소리가 거슬려요’ 2번 [끄기]"
- **시험**: (합성 P3, 말 많은 곡 넘김 +1.5·`vocal_bother` 응답) **합격**: 5세션 안에 게이트 켜짐 ≥ 80% · 켜진 뒤 경로의 말 비중 '높음' 곡 ≤ 5% ·
  대조군·미리듣기 페르소나(P12) 오작동 ≤ 5% · 작은 풀(장르+가사 조건)에서 걸음 폴백이 일어나고 곡 수가 줄지 않음.

### 4.10 다양성 — 가수 상한 · 최근 곡 쉬는 폭 · 좋아요 곡 다시 넣기

#### 4.10.1 가수 상한 (P0 버그 수정 + P1 개인)

- **버그(B27)**: 10차 3번("참여 가수 중 한 명이라도 상한에 닿으면 제외")이 2.5.1 코드에 없다 — L434·L541–542 가 `s.artist` 문자열 통째로 센다.
  P 모드에서는 `artistKeys(s.artist)` 의 **어느 키든** 상한에 닿으면 제외하고, 빔 상태에 키 단위 카운트 `keyCount` 를 따로 둔다(`P.artist_cap_by_key = true`). P 없음은 2.5.1 그대로.
- **개인**(P1): 최근 10세션 중 `too_repetitive`(출처 무관, AI 유지 0.5) 세션 가중 합 ≥ `diversity.repetitive_sessions_for_cap(2)` → 상한 `artist_cap_low(1)`.
  규칙 값(2)보다 올리지 않는다. **훅**: L429 → `const cap = P ? P.artist_cap : Number(rules.diversity.max_per_artist);`

#### 4.10.2 최근 곡 쉬는 폭 — 기기 무관 (P0)

- **버그(B8)**: 지금은 이 기기 `localStorage` 60곡, 그것도 "추천된" 곡(L3517). 다른 기기에서 들은 곡을 모른다.
- **새 방식**: `exclude_ids` = 두 앱의 `recommendations` 문서(경로+더 들을 곡 행)와 이 탭의 세션에서, 최신순으로 서로 다른 곡 N 개.
  보여 줬지만 안 들은 곡도 넣는다(화면에 나왔으므로). N = `diversity.recent_window(60)`(지금 `RECENT_MAX` 값을 옮김),
  최근 10세션 `too_repetitive` 세션 ≥ 2 이면 `recent_window_repetitive(120)`.
- **훅**: L370 → `const recent = new Set(rules.diversity.exclude_recent_played ? (P && P.exclude_ids ? P.exclude_ids : user.recent_played || []) : []);`
  익명 사용자는 지금처럼 로컬 목록(이제 더 들을 곡 포함).

#### 4.10.3 좋아요 곡 다시 넣기 (P1)

- `replay_ids` = (좋아요 중 ∪ 벽 곡) 중 `exclude_ids` 후보에 들었지만 마지막 노출이 `replay.cooldown_days(7)`일 넘게 지난 곡 → `exclude_ids` 에서 빼고 정책에 넣는다.
- 엔진은 시퀀스당 `replay.max_per_session(1)` 곡까지만 허용(빔 상태 `replays`). 실제로 뽑히는지는 μ·코리도어가 정한다(억지로 넣지 않음).
- 곡에 `too_repetitive` 가 붙으면 `song_block_days(30)`일 제외. 다시 넣은 곡이 `pause_after_skips(2)`번 조기 넘김되면 `pause_sessions(5)`세션 동안 끔.
- trace `p_replay: true`, 설명 "좋아요한 곡을 오랜만에 다시 넣었어요 (12일 전)".

- **시험**: 두 "기기"(서로 다른 날의 추천 문서)에서 같은 `exclude_ids` · 시퀀스당 다시 넣기 ≤ 1 · (합성 P4 반복 싫음) 6세션 안에 창 120 · 켜진 뒤 5세션 안에 반복 0 ·
  (합성 P5 다시 듣기 좋아함) 6~10세션의 자격 세션 중 다시 넣기 ≥ 50%.

### 4.11 더 들을 곡 — 엔진이 고른다 (P0)

지금(L3522–3537): 앱이 경로 뒤를 **원좌표 목표 거리순**으로 채운다. `instrumental_only` 게이트가 빠져 연주곡만 원해도 보컬곡이 나오고(B21),
취향·가수 상한·시드·전환을 보지 않으며(B22), 재생 큐에 들어가지 않아 신호가 안 생긴다.

**새 export** `recommendExtras(catalog, rules, inputs, result, { target_sec })` (P 가 있을 때만 앱이 부른다):

1. 후보 = `eligibleUniverse` 와 같은 게이트(가사 게이트 포함) + 소프트 게이트(걸음 폴백과 같은 규칙) + `P.exclude_ids` + 싫어요 − 경로 곡. 장르 정책 같음.
2. 가수 상한은 경로에서 쓴 카운트에 이어서 센다(키 단위).
3. 탐욕 1폭: 경유지 = 목표 좌표, `distCost = fit ≤ R_x ? 0 : fit`, `R_x = max(유효 r, extras.radius(0.05))`,
   `pers` = §3.8 머묾 규칙(J_hold, 가점은 fit ≤ R_x 에서만) — 앞 곡은 직전에 고른 곡(첫 extra 는 경로 마지막 곡).
   정렬 키 `[R9(distCost + pers), jitterOf(seed, song_id, n + j), tiebreakKeys…, song_id]`.
4. 곡 길이 = `duration_ms/1000`(없으면 `default_duration_s` 210), 최소 `min_duration_s` 60. 경로+extras 합이
   `target_sec = 분·60·extras.fill_ratio(0.85)` 에 닿거나 `max_songs(12)` 곡이면 멈춘다.
5. 반환 `{ extras: [{ song_id, trace, explanations }], total_sec }`. trace 에 `p_phase:"extra"`, `p_extra:true`, `va_distance`, `p_adj`, `p_pers`.
   **경로(`result.sequence`)는 절대 바꾸지 않는다**(시험: extras 유무와 무관하게 경로 동일).

**앱**: extras 를 경로 뒤 재생 큐에 넣는다(`setupPlayer([...seq, ...extras])`, 역할 `extra`) — 그래야 `track_exit`·좋아요(10초)가 생긴다(D4).
`post_change` 의 위치는 여전히 경로 위치 1..n. 익명 사용자는 옛 코드를 쓰되 `instrumental_only` 를 거른다(B21 수정은 모두에게).
**설명**: "목표 분위기를 이어 가는 곡이에요."

### 4.12 조건 완화 · 시드 · 설명 층 · 비교 · 데모

#### 4.12.1 조건 완화 순서 (P1)

지금(L3489–3503): 경로가 짧으면 가사 → 장르 → 둘 다 순으로 풀어 다시 만든다. 무엇을 풀었는지 로그에 없다.
- 소프트 게이트는 엔진이 걸음마다 먼저 푼다(§4.9).
- 앱 순서: 기본 `relax.order_default = [lyric, genre, both]`. 사용자가 `instrumental_only` 를 직접 골랐거나 최근 30일 `vocal_bother` ≥ 2 이면 `order_vocal_bother = [genre, lyric, both]`(가사가 더 중요한 사람은 장르를 먼저 푼다).
- 기록: `input.relaxed ∈ {null, "lyric", "genre", "both"}` + 걸음별 `p_soft_relaxed`.

#### 4.12.2 시드 (P0)

`seed = uid:YYYY-MM-DD:no`, `no = max(이 기기 카운터, 불러온 추천 중 오늘(UTC) 이 uid 의 개수) + 1` — 기기를 바꿔도 같은 날 같은 시드가 반복되지 않는다(B25). `input.seed` 로 기록.

#### 4.12.3 설명 층 (P0 최소, P1 전체)

| 위치 | 내용 | 출처 |
|---|---|---|
| 곡 카드 | 엔진 `rules.explanations`(기존 + `p_smooth`·`p_discovery`·`p_replay`·`p_extra`) — 기존 `renderExplanations` 그대로 | trace |
| 결과 상단 "이번 추천에 반영된 나" | 칩 ≤ 3, 기본값에서 벗어난 것만, 고정 우선순위(속도 → 좌표 보정 → 연결 → 취향 → 게이트 → 다양성 → 머묾) | `explainPolicy(policy, model, rules)` |
| 기본 추천과 비교 (P0) | 토글: R 경로를 감정 변화 지도(`#emotionMap`)에 점선으로 겹쳐 그리고, A 에만 있는 곡에 "나에게 맞춤" 표시, 머리글 "8곡 중 5곡이 나에게 맞게 바뀌었어요". 폴백이면 "이번엔 기본 추천을 그대로 썼어요 (안전 기준)" | A·R 결과 |
| 내 방 "내 취향 모델" 패널 | 카드: 기분 해석 · 목표 해석 · 여정 속도 · 첫 곡 · 여정 길이 · 도착 구간 · 곡 취향 · 곡 사이 연결 · 빼는 곡 · 다양성 · 새로운 발견. 카드마다 한 줄 문장 · 근거 횟수 · 확신 점(1~5) · "기본값" 표시 · "지난 추천 이후 바뀜" 표시 · 최근 추천들의 값 추이(로그의 `personal_meta.params` 에서) · [초기화] | `explainModel(model, rules, { history })` |
| 전역 | "개인화 끄기" 토글(`wp_personal_v1.opt_out`) | — |

문구는 **횟수**로 말한다("N번 중 M번") — 점수로 말하지 않는다. 비회원에게는 "로그인하면 들을수록 나에게 맞춰져요".

> **변경 (2026-09-29, 1차 수정)** — 패널 카드의 "근거 N번"과 문장 속 "…번"은 가중 없는 **정수 횟수**다: 곡 취향·새로운 발견 = 좋아요 + 취향 싫어요 + 벽 곡 + 벽 가수 +
> 끝까지 들음 + 넘김(`counts_for_explain.taste`), 도착 구간 = `hold.arrival_n + repetitive_n`, 빼는 곡 = `gates.evidence.vocal_bother_n`,
> 다양성 = `diversity.repetitive_sessions_n`. 가중 합(E, 청취 표 ¼, AI 코드 ½)은 확신 점에만 쓴다("근거 9.75번" 같은 소수 표시 수정).

#### 4.12.4 데모 모드 (P1)

`?demo=<persona>`: `demo/personas/<id>.json`(TOOLS 가 만든 합성 RawFacts)을 메모리에 올리고 상단에 "데모 프로필(합성 사용자)" 띠.
**모든 Firestore 쓰기는 무효**(`fsWrite` 가 `writes:false`)이고 결과는 메모리 `SESSION_LOG` 에만 쌓여 모델이 바로 다시 만들어진다.
"가상 청취 1회" 버튼은 `tools/sim/behavior.mjs`(순수 ESM)로 현재 추천을 가상으로 듣고 기록을 접는다 → 다음 추천에서 변화가 보인다.
`lab.html`(페르소나 세션 1→10 단계 보기, 포스터 SVG)은 P2.

### 4.13 개인화하지 않는 것과 전체 목록

**일부러 개인화하지 않는 것**(기하의 뼈대 — 바꾸면 "무엇이 맞는 곡인가"의 정의가 사람마다 달라진다):
좌표계(퍼센타일) · 영역 풀(`selection.region`) · 빔 폭·확장 수 · `preference.band` · `path.progress_weight`(0 이면 역행 2배) ·
`iso.min_step_span` · 장르 우선 정책 · 전체 통계 콜드스타트(`global_stats`) · 부하 모듈레이터(`load`, 미수집).

| 절차 (앱·엔진 순서) | 처리 |
|---|---|
| 입력 해석(지금) | §4.1 보정 |
| 목표 해석 | §4.2 보정(자동 이동 없음) |
| 가사 조건 | 선언 그대로 + §4.12.1 완화 순서 |
| 장르 조건 | 선언 그대로(취향은 μ 로만) |
| 앱 풀 사전 필터 | 그대로(`prefer_vocal`) |
| 곡 수 | §4.5 기본 시간 제안 |
| 좌표계 | 개인화 안 함 |
| 게이트 | 선언 + §4.9 소프트 게이트 |
| 싫어요 제외 | 그대로(I12) + 범위 수정 §4.7.2 |
| 최근 곡 제외 | §4.10.2 |
| 영역 풀 | 개인화 안 함 |
| 경유지 | §4.3 속도·이탈 가드, §4.4 시작점 |
| 순위: 밴드 | 개인화 안 함 |
| 순위: 취향 μ | §4.7 |
| 순위: 전환 | §4.8 |
| 순위: 머묾 | §4.6 |
| 빔 | 개인화 안 함 |
| 머묾 재배열 | §4.6 |
| 가수 상한 | §4.10.1 |
| 조건 완화 | §4.12.1 |
| 더 들을 곡 | §4.11 |
| 시드 | §4.12.2 |
| 설명 | §4.12.3 |

---

## 5. 신용 할당 행렬 — 어떤 신호가 어떤 학습기를 움직이나

이 표에 없는 조합은 **움직이지 않는다**. 세 원칙:
(1) 취향 신호는 경로 모수(속도·시작점·길이·반경·좌표)를 움직이지 않는다.
(2) 방향이 있는 신호만 연속값(π·δ·길이)을 움직이고, 방향 없는 불만은 안내나 규칙 기반 계단(반경·창·상한)에만 쓰인다.
(3) `post_change.change`(−2~+2)는 **어떤 학습기에도 넣지 않는다** — 기분·날씨·하루 사정이 섞인 한 숫자라 어느 부품의 공인지 가를 수 없다. 평가 지표(시뮬레이터·5단계)와 `song_stats` 에만 쓴다.

| 신호 | 취향 표·μ | 전환 m·λ | 좌표 보정 | 속도 π | 시작 s | 머묾 r | 길이 | 게이트 | 다양성 | 발견·다시 넣기 | 이탈 가드 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 노출 c ≥ 0.70 | +¼·φ | y = 0 | – | – | 첫 곡이면 수락 | – | – | – | – | 성공(해당 곡) | 도달 위치 |
| 노출 0.30 ≤ c < 0.70 | 0 | 제외 | – | – | – | – | – | – | – | – | 도달 위치 |
| 조기 넘김(next/jump, c < 0.30) | −¼·φ·(1−a) | y = 1 | – | – | 첫 곡이면 거절 | – | – | 말 비중 묶음 표(취향 경유) | – | 연속 넘김 수 | 도달 위치(늘어남) |
| c < 0.30 · prev/pagehide/new_rec/session_end | – | 제외 | – | – | – | – | – | – | – | – | 멈춘 위치 |
| 자동재생 실패 | – | 제외 | – | – | 제외 | – | – | – | – | – | – |
| 좋아요 켬(`on:true`) | pos 1 | y = 0 | – | – | 수락 | – | – | – | – | 다시 넣기 성공 | – |
| 싫어요 `not_my_taste`·이유 없음 | neg 1(전 묶음) + 제외 | 그 곡은 전환 대상에서 빠짐 | – | – | – (취향 신호) | – | – | – | – | – | – |
| 싫어요 `vocal_bother` | 말 비중·연주곡 묶음 neg 1 + 제외 | – | – | – | – | – | – | 켜짐 근거 1 | – | – | – |
| 싫어요 `path_jump` @k | 제외만 | y = 1 (가중 1) | – | – | – | – | – | – | – | – | – |
| 싫어요 `mood_mismatch` @k | 제외만 | – | k ≤ 2 이면 안내 계수 | – | 위치 1: 거절 + 확인/내림 근거 | – | – | – | – | – | – |
| 싫어요 `arrival_mismatch` @k | 제외만(범위 `[]`) | – | 목표 안내 계수 | – | – | 머묾 곡이면 좁힘 1 | – | – | – | – | – |
| 싫어요 `too_repetitive` @k | 제외만 | – | – | – | – | 머묾 곡이면 넓힘 1 | – | – | 창·상한 계수 | 그 곡 다시 넣기 30일 막음 | – |
| 싫어요 `length` | 제외만(범위 `[]`) | – | – | – | – | – | – | – | – | – | – |
| 세션 `path_jump` + 위치 | – | 그 위치 y = 1 (사용자 1 · AI 유지 0.5) | – | – | – | – | – | – | – | – | – |
| 세션 `path_jump` 위치 없음 | – | – (패널 횟수만) | – | – | – | – | – | – | – | – | – |
| 세션 `mood_mismatch` | – | – | 안내 계수 | – | 확인 근거(사용자 출처) | – | – | – | – | – | – |
| 세션 `arrival_mismatch` | – | – | 목표 안내 계수 | – | – | 좁힘(사용자 1 · AI 0.5) | – | – | – | – | – |
| 세션 `too_repetitive` | – | – | – | – | – | 위치가 모두 머묾이면 넓힘 | – | – | 창·상한 계수 | – | – |
| 세션 `vocal_bother` | – | – | – | – | – | – | – | 켜짐 근거(사용자 1 · AI 0.5) | 완화 순서 | – | – |
| 세션 `not_my_taste` | – (곡 단위로만 배움) | – | – | – | – | – | – | – | – | – | – |
| 세션 `length` + `length_dir` | – | – | – | – | – | – | 표 | – | – | – | – |
| `pace_answer` | – | – | – | 표 | – | – | – | – | – | – | – |
| 속도 버튼 선택(`pace_choice`) | – | – | – | 표(가중 1.5) | – | – | – | – | – | – | 천천히면 끔 |
| 좌표 끌기·화살표(`nudged`) | – | – | 관측(가중 1) | – | – | – | – | – | – | – | – |
| 보정·표 좌표 받아들임 | – | – | 관측(가중 0.25) | – | – | – | – | – | – | – | – |
| 자연어 수정(`corrections`) | – | – | (P2) 치환·강도 | – | – | – | – | – | – | – | – |
| 새 추천 10분 안 재요청 | – | – | – | – | – | – | – | – | – | – | 그 세션 제외 |
| `auto_gate_off` | – | – | – | – | – | – | – | 30일 끔 | – | – | – |
| `personal_reset{procedure}` | 해당 학습기가 그 시각 이전 근거를 무시 | | | | | | | | | | |
| `post_change.change` | **학습에 쓰지 않음**(평가·`song_stats` 전용) | | | | | | | | | | |

더 들을 곡의 노출도 경로 곡과 똑같이 취향·전환 신호가 된다(역할 `extra`).

---

## 6. 스키마와 엔진 소비

### 6.1 RawFacts — 앱(또는 도구)이 모아 `personal.js` 에 주는 사실 (`schema: "wp-raw/1"`)

```js
/** RawFacts — 모든 시각은 epoch ms(숫자). Firestore Timestamp 는 호출자가 toMillis() 로 바꾼다.
 *  아직 서버 시각이 없는 이 탭의 쓰기(SESSION_LOG)는 로컬 시각을 넣는다. */
{
  schema: "wp-raw/1",
  uid: "string",
  as_of_ms: 1790000000000,                 // 빌드 기준 시각(앱은 Date.now() 를 여기서 한 번만 읽어 넘긴다)
  env: { app: "web-personal", env: "prod" | "local" | "demo" },
  profile: {                               // users/{uid} 에서 필요한 것만
    likedSongs: ["P0001"], dislikedSongs: [], playlists: [], favorite_tracks: [],
    wallMeta: { "P0001": { src: "onboarding" | "search" | "playlist", at: "ISO" | null } },
    pinned_artists_resolved: ["아이유"],   // wallArtists·preferred_artists 를 앱의 findArtist 로 카탈로그 표기로 푼 이름
    recommend_minutes: 30 | null,
    wp_personal_v1: WpUserDoc | null       // §7.4
  },
  recommendations: [ RecDoc ],             // 최신순, ≤100, 두 앱 모두(id 포함). 모양은 §7.1(옛 문서는 있는 필드만)
  events: [ { id, created_at_ms, rec_id: "string" | null, type: "string", payload: {} } ],   // 최신순, ≤1200
  listening_history: [ { songId, listenedSeconds, durationSeconds, completionRate, skipped, created_at_ms } ] | null,   // 선택(P2)
  session_log: { recommendations: [ RecDoc ], events: [ Event ] },   // 이 탭이 쓴 것(읽기 전 반영용). id/client_id 로 중복 제거
  vocab: {                                 // 옛 기록의 표 좌표를 다시 계산할 때만 쓴다(새 기록은 table_point 가 로그에 있음)
    mood_chips: [["불안해요", 0.30, 0.72]], goal_chips: [["차분해지고 싶어요", 0.60, 0.30]],
    nl_extra_emo: [], nl_extra_goal: [], nl_k: { "1": 0.6, "2": 1, "3": 1.3 }
  },
  context: { global_stats_digest: "string" | null }
}
```

앱은 `vocab` 을 자기 상수(MOOD_CHIPS 등, L893–903·L3105–3120)에서, 도구는 `tools/sim/app_tables.mjs`(index.html 앵커 추출)에서 채운다.

### 6.2 CatalogIndex — 호출자가 만든다

```js
{ n: 4117, digest: "fnv1a32 hex over sorted 'id:V:A'",
  byId: Map<song_id, ContractSong & { feature_bins: {...}, feature_bins_p: {...} }>,
  coords: Map<song_id, [v, a]> }           // 엔진 새 export workingCoords(catalog, rules) 결과(퍼센타일 작업 좌표)
```

`ContractSong` 은 지금 `toContractSong`(L2278–2293)과 같다: `song_id, title, artist, V, A, va_source, spokenness, instrumental, genres, popularity, duration_ms, tempo(0~1|null)`.
앱은 `contractWithBins` 로, 도구는 카탈로그 로더로 만든다. 두 경로가 같은 곡에 같은 값을 내는지 `check.mjs` 가 표본 200곡으로 비교한다(앱 쪽은 `AZT_DEBUG.dumpContract(ids)` 로 뽑음).

### 6.3 NormalizedLog — `normalizeLogs(raw, catalogIndex, rules)` 결과 (시험용으로 export)

```js
{ sessions: [ Session ], source: { n_recs, n_events, n_sessions_wp, n_sessions_legacy, n_orphans_attached, n_orphans_dropped, n_invalid_events, partial } }
Session = {
  rec_id, at_ms, app: "web-personal" | "fix-web", seed,
  input: { now:{v,e}, target:{v,e}, now_table, target_table, labels, nudged:{current,target},
           minutes, minutes_base, nl_minutes: bool, lyric, genres, pace_user: "fast"|"slow"|null, stress, high_stress },
  used: { pi_used, start_arm, hold_arm, minutes_bias, mu, m:{...}, calib:{ current, target } } | null,   // web-personal 이면 로그의 personal_meta.params
  policy: PersonalPolicy | null,
  n_path, arrival_index, path: [ { song_id, position, phase: "move"|"hold", pmarg|null } ], extras: [ { song_id, position } ],
  exposures: [ Exposure ],                 // 재생 순서
  transitions: [ { prev, cur, label: 0|1, w, L:{tempo,vocal,spoken,genre,va}, q } ],
  likes_on: [ song_id ], dislikes: [ { song_id, reason, position, phase } ],
  post: { change, touched, reasons: { code: "user"|"ai" }, ai_removed: [code], positions: [int],
          pace_answer, length_dir, end_va } | null,
  reached_frac, rerequested_within_10min: bool, ended_by: "complete"|"quit"|"new_rec"|"unknown"
}
Exposure = { song_id, position, role: "path"|"extra", instance, started, listened_s, duration_s, catalog_s,
             completion, preview, cause, prev_song_id, prev_completion, at_ms, source: "track_exit"|"legacy" }
```

### 6.4 PersonalModel — `buildPersonalModel(norm, catalogIndex, rules, { as_of_ms })` 결과 (`schema: "wp-model/1"`)

```js
{
  schema: "wp-model/1", personal_version: "p1.0.0", as_of_ms, digest,       // digest = fnv1a32(정규화 JSON, digest 필드 제외)
  source: { ...norm.source, cursor: { last_event_ms, last_rec_ms } },
  evidence: { E, n_exposures, n_transitions, n_pace_votes, n_length_votes, n_calib_edits: { current, target } },
  taste: { items: [ TasteItem ], affinity: AggregateAffinityOut, E, mu,
           discovery: { paused_until_session: int|null, consecutive_skips: int } },
  calib: { current: { g:{dv,de,W}, labels: { "불안해요": { dv, de, W, n_edit, applied: bool } } },
           target:  { g:{...}, labels: {...} },
           prompts: { current: ["불안해요"], target: [] } },
  pace:   { pi, W, votes: int, quit: { f_med: number|null, n: int } },
  start:  { arm, ratio: number|null, n1, mismatch_up: int, mismatch_down: int, since_rec_id },
  length: { bias_log2, W, base_minutes },
  hold:   { arm, arrival_w, repetitive_w, since_rec_id },
  adjacency: { m: { tempo, vocal, spoken, genre, va }, m0, applied: { tempo: bool, ... },
               O: {...}, Etilde: {...}, n_large: {...}, n_trans, lambda },
  gates:  { soft: [ "exclude_spoken" ], evidence: { vocal_bother_w, spoken_score, spoken_n, last_evidence_ms }, off_until: { gate: ms } },
  diversity: { artist_cap, recent_window, recent_ids: [song_id], replay_ids: [song_id],
               replay: { paused_until_session: int|null, consecutive_skips: int }, repetitive_sessions_w },
  resets: { procedure: ms },
  history: [ { rec_id, at_ms, params } ],   // 최근 10개 web-personal 추천의 personal_meta.params(패널 추이용)
  counts_for_explain: { ... }               // 문구에 넣을 횟수(좋아요 4, 끝까지 3 …)
}
```

`emptyModel(rules)` 는 같은 모양에 중립값(증거 0)을 채운다. 모델은 **저장하지 않는다**(§2.3).

### 6.5 PersonalPolicy — `inputs.personal` (`schema: "wp-policy/1"`)

`resolvePolicy(model, ctx, rules, { mode })` 가 만든다(`mode: "personal"` 기본, `"p0"` 는 기준 실행 R 용 — 학습값 없이 모집단 기본 + 비학습 사실(싫어요·최근 창 60)만).
엔진은 받는 즉시 `sanitizePersonal(p, rules, { duration_min, pace })` 로 모르는 키를 버리고 경계로 자르고 고긴장 규칙을 다시 적용한 **동결 사본**을 쓴다.
`rules.personalization.enabled !== true` 이거나 `p` 가 없으면 `null` → I0 경로.

| 필드 | 타입 | 중립(I1) | P0(빈 모델 · 기준 실행 R) | 경계(`personalization.bounds`) | 엔진에서 쓰는 곳 |
|---|---|---|---|---|---|
| `v`, `schema`, `digest`, `model_digest` | 1, "wp-policy/1", str, str\|null | — | — | — | 로그만 |
| `stress`, `high_stress` | int, bool | null, false | ctx 에서 | 0–4 | 고긴장 재적용 |
| `tp` | number\|null | null | null(고긴장·n≤3 보호는 엔진) | [0.5, 1.0] | L517 |
| `quit_frac` | number\|null | null | null | [0, 1] | L517 상한 |
| `start_offset`, `start_min_journey` | number | 0, 0.15 | 0, 0.15 | [0, 0.15] (고긴장 0.075) | L517 직전 |
| `hold_radius`, `hold_min_songs` | number, int | 0, 5 | 0.035, 5 | [0, 0.05] (고긴장 0.035), [3, 9] | L452 |
| `hold_order` | "fit"\|"last_fixed_progress"\|"last_fixed_smooth" | "fit" | "last_fixed_progress" | 열거 | L566–575 |
| `corridor_bands` | number\|null | null(제한 없음) | 1 | [0, 2] | §3.8 |
| `j_move`, `j_hold` | number\|null | null(clamp 없음) | 1.5·band, 0.0125 | [0, 1.5·band], [0, 0.0125] | §3.8 |
| `mu` | number | `preference.pref_weight`(0) | 0 (개인 모드는 0.5·E/(E+8)) | [0, max(taste.mu_max, preference.pref_weight)] | L525 |
| `taste_features` | spec[]\|null | null | `taste.extra_features`(기본 []) → null | ≤ 3 | `prefDetail` 4번째 인자 |
| `adj_w` | {tempo,vocal,spoken,genre} 절대 비용 | 모두 0 | band·base·scale | 각 [0, 2·band] (고긴장 ≥ band·base·scale) | `adjCost` |
| `bpm_scale`, `spoken_scale`, `half_double_fold` | number, number, bool | 60, 0.5, false | 규칙 값 | (30–120), (0.25–1) | `adjFeatures` |
| `lambda` | number | `path.jump_weight`(0.1) | 0.1 | [min(0.1, path.jump_weight), 0.25] | L524 |
| `discovery_u` | number\|null | null | null | [0, 1) | 발견 칸 |
| `soft_gates`, `soft_min_pool` | string[], int | [], 24 | [], 24 | `rules.gates` id 부분집합, [12, 48] | L535 |
| `artist_cap`, `artist_cap_by_key` | int, bool | `diversity.max_per_artist`(2), false | 2, true | [1, max_per_artist] | L429–434 |
| `exclude_ids` | string[]\|null | null(→ `user.recent_played`) | 최근 창 60 | ≤ 150개 | L370 |
| `replay_ids`, `replay_max` | string[], int | [], 0 | [], 0 | ≤ 50개, [0, 1] | `stepCandidates` |

경계 표의 `*_bands` 항목(`j_move_bands`, `adj_w_bands_each`)은 `preference.band` 를 곱한 절대값으로 비교한다. 정책의 `j_move`·`adj_w` 는 절대값이다.

> **변경 (2026-09-29, 1차 수정) — 새 필드** (중립 / P0 / 경계): `hold_order` 에 `"last_fixed_turn"` 추가(P0 기본) ·
> `hold_min_pool` int (0 / 12, 좁힌 팔 0 / [0, 24]) · `hold_radius_cap` (정책이 아니라 sanitize 가 규칙에서 채움: 0.05, 고긴장 0.035) ·
> `hold_cluster` bool (false / true) · `hold_path_q` bool (false / true) · `pers_bucket` number\|null (null / 0.25·band / [0, 0.5·band]).
> `hold_min_pool` 은 r 에서 정해지므로 경로 모수(`PATH_PARAM_KEYS`)에 넣는다. resolvePolicy 의 mode 에 `"path"`(R_path: 경로 모수만 개인값) 추가.
>
> **변경 (2026-09-30, 2차 수정) — 새 필드** (중립 / P0 / 경계): `hold_break` number\|null (null / `safety.j_hold` 0.0125 / [0, 0.0125] — `hold.cluster_break = "j_hold"` 일 때) ·
> `pers_jitter` number\|null (null / 0.25·band / `bounds.pers_jitter_bands` [0, 0.25]·band — `safety.pers_mode = "perturb"` 일 때). 둘 다 곡 레인(경유지 무관)이라
> `PATH_PARAM_KEYS` 에 넣지 않는다. 중립 정책은 둘 다 null → I1 그대로.

**중립이 항등인 이유**: μ = 규칙 값, adj = 0 이면 `pers = μ·pmarg + 0 = μ·pmarg`(정확히 같은 부동소수), clamp·코리도어 없음, λ·상한·최근 목록·정렬이 모두 규칙 값 그대로 → key·비용이 2.5.1 과 같은 값.

### 6.6 엔진 훅 목록 (`engine/engine.js` 2.6.0-wp)

| 줄(76e8bdf) | 지금 | 바꾸는 것 (P 없음 → 원래 식 그대로) |
|---|---|---|
| L33 | `ENGINE_VERSION = "2.5.1"` | `"2.6.0-wp"` + 머리 주석에 변경 기록 |
| L51 | `function fnv1a32` | `export` 만 추가 |
| (새) | — | `export seededUniform, workingCoords(catalog, rules), makeExtraBinner(fullCatalog, specs), adjFeatures(a,b,P), adjCost(a,b,P), sanitizePersonal(p, rules, env), recommendExtras(...)`; 기존 `songCount`·`transitionAt` 에 `export` |
| L233–262 | `aggregateAffinity(items, rules)` | 3번째 인자 `opts`: `scope_add`(이유별 범위 덧붙임 — 있을 때만 새 객체), `extra_feature_ids`(`feature_bins_p` 도 표). 표 분기 맨 앞에 `if (it.vote) v = { pos: +it.vote.pos \|\| 0, neg: +it.vote.neg \|\| 0, pin: +it.vote.pin \|\| 0 };` |
| L288 | `prefDetail(song, rules, user)` | 4번째 인자 `extraSpecs = null` — 있으면 L321–325 뒤에 `feature_bins_p` 묶음을 같은 방식으로 `rate` |
| L370 | `recent = user.recent_played` | `P && P.exclude_ids ? P.exclude_ids : user.recent_played \|\| []` (중립 정책의 `null` 이면 기존 목록) |
| L425–473 | `stepCandidates(...)` | 끝 인자 `P = null`, `rEff`, `discStep`. P 모드: 상한(키 단위), 다시 넣기 한도, 발견 칸 좁힘, `bestBand` 를 먼저 구한 뒤 §3.8 의 `pers`·key, 반환 후보에 `pers, adj, adj_x, geoBest` |
| L452 | `distCost = arrival ? fit : bandIdx * band` | `arrival ? (P && fit <= rEff ? 0 : fit) : bandIdx * band` |
| L467 | `key = R9(x.distCost + mu * x.pmarg)` | `P ? R9(x.distCost + x.pers) : (원래 식)` |
| L486 직후 | — | `const P = sanitizePersonal(inputsIn.personal, rules, { duration_min: dur, pace: inputsIn.pace })` |
| L517 | `waypoints(nowC, tgtC, n, transitionAt(rules, dur))` | `at` = `inputs.pace` 수동값 → `P.tp` → 표, 그 뒤 `P.quit_frac` 상한·n≤3 보호·고긴장 하한(P 모드), `startC`(§4.4) |
| L524–525 | `jw`, `mu` | `P ? P.lambda : …`, `P ? P.mu : …` |
| L530 | 빔 초기 상태 | `prevSong: null, keyCount: {}, replays: 0` 추가(출력 무관) |
| L535 | `stepPool` | P 소프트 게이트 필터 + 폴백(§4.9) |
| L538 | `stepCandidates(...)` 호출 | `P, rEff, discStep` 전달 |
| L541–552 | 다음 상태 | P 모드: `keyCount`·`replays`·`prevSong` 갱신, 비용 `st.cost + c.distCost + pw * c.prog + jw * c.jump + c.pers` (P 없음: 원래 식) · picks 에 `pers, adj, adj_x, pmarg, geoBest, chosenBy, discovery, replay, softRelaxed, phase` |
| L566–575 | 머묾 재배열 | `P ? orderHold(tail, P, ctx, nowC, tgtC, …) : (원래 정렬)` |
| L579–624 | trace | P 모드에서만 `p_*` 키 추가(§6.8) |
| L628–637 | 반환 | P 모드에서만 `personal: { digest: P.digest, discovery_step, soft_relaxed_steps }` 추가 |

`recommend` 의 입력에 새 키 두 개: `pace: "fast"|"slow"|null`(모든 사용자), `personal: PersonalPolicy|null`(회원).

### 6.7 `recommendExtras` 계약

```js
recommendExtras(catalog, rules, inputs /* recommend 에 준 최종 입력 그대로 */, result /* recommend 결과 */, { target_sec })
  → { extras: [ { song_id, trace: { phase:"extra", p_extra:true, va_distance, p_adj, p_pers, jitter, artist, song_V, song_A, rules_hash }, explanations: [string] } ],
      total_sec: number, soft_relaxed: boolean }
```

`inputs.personal` 이 없으면 `{ extras: [], total_sec: 0 }` 를 돌려준다(익명은 앱의 옛 코드 — B21 수정만 적용).

### 6.8 trace 키 · 설명 추가 (규칙 파일)

P 모드에서만 나오는 곡별 trace 키(`trace_keys` 에 추가):

| 키 | 값 |
|---|---|
| `p_phase` | `"move"` \| `"hold"` \| `"extra"` |
| `p_pmarg` | 취향 여백(내 중립점 − 선호) — 다음 학습의 q 계산용 |
| `p_pers`, `p_adj` | clamp 후 개인 비용, 전환 비용 |
| `p_adj_x` | `{tempo, vocal, spoken, genre}` 특징값 |
| `p_bpm_diff` | 앞 곡과의 BPM 차(정수) \| null |
| `p_geo_best` | 그 걸음에서 개인 항 없이 (distCost, jitter, tiebreak, id) 로 1등인 곡 |
| `p_chosen_by` | `"geometry"`(= p_geo_best) \| `"taste"` \| `"transition"` \| `"discovery"` \| `"replay"` \| `"beam"`(진행·λ 등 경로 단위) — 기하 최선곡 대비 가장 크게 유리했던 항 |
| `p_corridor` | 가점 허용 여부 |
| `p_smooth`, `p_smooth_basis` | `p_chosen_by === "transition"` 이고 기하 최선곡보다 x 가 0.25 이상 작은 특징이 있으면 true, 그 특징 이름("빠르기·목소리 유무") |
| `p_discovery`, `p_replay`, `p_soft_relaxed`, `p_extra` | 불리언 |

기존 `chosen_by`("preference"/"geometry", 밴드 크기 기준)는 뜻을 바꾸지 않고 그대로 둔다.

`rules.explanations` 에 추가(전부 `when` 이 있어 P 없음이면 나오지 않음):

```json
{ "id": "p_smooth",    "when": { "trace_key": "p_smooth",    "equals": true }, "template": "앞 곡과 {p_smooth_basis} 흐름을 이어 골랐어요.", "binds": ["p_smooth_basis"] },
{ "id": "p_discovery", "when": { "trace_key": "p_discovery", "equals": true }, "template": "이번엔 아직 안 들어본 가수의 곡도 하나 넣어 봤어요.", "binds": [] },
{ "id": "p_replay",    "when": { "trace_key": "p_replay",    "equals": true }, "template": "좋아요한 곡을 오랜만에 다시 넣었어요.", "binds": [] },
{ "id": "p_extra",     "when": { "trace_key": "p_extra",     "equals": true }, "template": "목표 분위기를 이어 가는 곡이에요.", "binds": [] }
```

**설명 충실도**: 곡 설명은 `p_geo_best` 와의 반사실 비교에서 그 항이 실제로 순위를 바꾼 경우에만 나온다(설계상 충실). 시험 §11 H4.

---

## 7. 로깅 — 신용 할당에 필요한 모든 필드

모든 쓰기는 `fsWrite` 를 지난다(§7.5). web-personal 이 쓰는 모든 문서·이벤트에 `app:"web-personal"`, `env` 표시.
`algorithm_version = rules_version + "+" + rules_hash + "+e" + ENGINE_VERSION + (정책 있음 ? "+" + PERSONAL_VERSION : "")`.

### 7.1 `recommendations` 문서 (추가 필드만 — 기존 필드는 그대로 유지)

문서 ID 는 **동기**로 만든다: `const ref = db.collection("recommendations").doc(); LAST_REC_ID = ref.id;` → 재생 이벤트 전에 ID 확정 → `ref.set(doc)`(B15).
문서 본문은 `personal.buildRecLog(...)` 가 만들고 앱이 `user_id, is_anonymous, created_at(serverTimestamp), algorithm_version` 을 붙인다 — **앱과 시뮬레이터가 같은 함수로 같은 모양**을 만든다.

```js
input: {
  // 기존: lyric_preference, genres, recommend_minutes, current_va, target_va, input_mode, filters, personalization, pace_mode, nl_text, nl_model, nl_v2
  app: "web-personal", env: "prod" | "local" | "demo",
  seed: "uid:2026-09-28:3", session_no: 3,
  effective: { lyric, genres, minutes },                  // 실제로 쓴 조건(자연어 사전설정 복원 전 값 — B18)
  minutes_base: 30, minutes_suggested: 25 | null,
  relaxed: null | "lyric" | "genre" | "both",
  pace_user: "fast" | "slow" | null,
  stress: 3, high_stress: true,
  labels:       { current: { mode: "chip", chip: "불안해요" } | { mode: "nl", nl: [{ label, intensity }] } | { mode: "tap" },
                  target:  { mode: "chip", chip: "차분해지고 싶어요" } | { mode: "nl", nl: "잠들고 싶어요" } | { mode: "tap" } },
  table_point:  { current: { v, e } | null, target: { v, e } | null },
  calib_applied:{ current: { dv, de } | null, target: { dv, de } | null },
  nudged:       { current: bool, target: bool },
  personal_policy: PersonalPolicy | null,                 // 엔진이 실제로 쓴 정규화 정책(exclude_ids·replay_ids 포함)
  personal_meta: {
    schema: "wp-meta/1", personal_version, engine_version, rules_hash, model_digest, policy_digest, as_of_ms,
    cursor: { last_event_ms, last_rec_ms }, evidence: { E, n_exposures, n_transitions, n_pace_votes },
    params: { pi, pi_used, start_arm, hold_arm, minutes_bias, mu, m: { tempo, vocal, spoken, genre, va }, lambda,
              calib: { current: { label, dv, de } | null, target: {...} | null }, soft_gates: [], artist_cap, recent_window },
    fallback: null | "geometry" | "p0",
    safety: { A: Metrics, R: Metrics, violations: [string] },   // Metrics = { arrival, max_jump, reversals, turns, n, hold_zigzag, start_dist }
                                                                // [변경 2026-09-29] + Rp: Metrics|null (R_path, §2.2 7), lane: null|"path"|"song"
    reference_ids: [song_id],                                  // 실행 R 의 경로(비교 토글·차이 분석용)
    changed_n: int, explain_codes: [string],
    catalog_n, catalog_digest, global_stats_digest
  } | null,
  user_affinity: { like_base, song_likes, artist_affinity, genre_affinity, feature_affinity } | null   // 소수 3자리로 줄인 aggregateAffinity 결과 — 정확한 재현용(≈5–20KB)
},
sequence: [
  // 경로 행: 기존 필드 + 아래
  { song_id, position, role: "path", fit, band_size, chosen_by, pref_score, pref_match, pref_basis, quadrant,
    wp_V, wp_A, song_V, song_A, phase: "move" | "hold", p_pmarg, p_pers, p_adj, p_adj_x, p_bpm_diff,
    p_geo_best, p_chosen_by, discovery, replay, soft_relaxed },
  // 더 들을 곡 행
  { song_id, position /* n+1.. */, role: "extra", phase: "extra", fit, song_V, song_A, p_pmarg, p_pers, p_adj, p_adj_x }
]
```

익명 사용자 문서: `personal_policy/personal_meta/user_affinity = null`, 나머지 새 필드(app·seed·effective·labels·table_point·nudged·relaxed)는 채운다.

### 7.2 `context_events` (보안규칙은 type 을 제한하지 않음 — 배포 첫날 콘솔에서 확인)

공통: `{ user_id, rec_id /* 동기 ID라 null 없음 */, type, payload: { app, env, client_id, ... }, created_at }`,
`client_id = rec_id|type|song_id|순번` (중복 제거용).

| type | payload (새/추가 필드) | 비고 |
|---|---|---|
| **`track_exit`** (새) | `song_id, position /* 시퀀스 위치, 1부터, extras 포함 */, queue_pos, role, instance, started, listened_s, duration_s, catalog_s, completion, preview, cause, prev_song_id, prev_completion, bg_credit_s, seek_fwd_s, liked, disliked, recovered?` | 곡 재생 1회당 정확히 1건. §7.3 |
| `like` / `dislike` | + `on: bool, position, role` | 켤 때·끌 때 모두 기록(B13) |
| `dislike_reason` | + `position`(시퀀스 위치), `role`, `phase` | 기존 코드값 그대로 |
| `post_change` | + `touched: bool`, `pace_answer: "faster"\|"ok"\|"slower"\|null`, `length_dir: "long"\|"short"\|null`, `rec_id`, `heard: { song_id: listened_s }`, `end_va`(P2) | 기존 `change, va_before, va_target, listened_seconds, misfit_reasons, note, reasons_source, ai_codes_removed_by_user, note_ai` 유지 |
| `pace_choice` (새) | `choice: "fast"\|"slow"\|null, suggested: pi_used, source: "user"` | 버튼을 누를 때 |
| `calib_reset` (새) | `field, label` | "원래 위치로" |
| `auto_gate_off` (새) | `gate` | 소프트 게이트 끄기 |
| `personal_reset` (새) | `procedure` (예 `"pace"`, `"calib:current:불안해요"`) | 패널 초기화 |
| `personal_toggle` (새) | `on: bool` | 개인화 끄기 |
| `compare_view` (새) | `changed_n` | 비교 토글 열람(시연 분석) |
| `track_complete`, `track_skip`, `spotify_click`, `sequence_play_start`, `sequence_complete`, `track_autoplay_failed`, `seek` | 기존 + `app, env, position`(시퀀스 위치), `track_skip` 에 `listened_s, completion, started` | **운영 앱의 `loadPersonalFeedback`(L2204–2219)이 읽으므로 계속 쓴다** |
| `track_milestone`, `track_transition_trace` | — | **web-personal 에서 끔**(`AZT_ENV.debug` 일 때만). `track_exit` 가 대신하고, 운영 앱의 400건 창을 덜 쓴다 |

### 7.3 `track_exit` 를 쓰는 곳 (APP, 한 함수 `closeExposure(cause)`)

- `goTo(idx)`(L2602) 맨 앞: 지금 곡을 원인(next/prev/jump — 호출자가 넘김)으로 닫는다. `finishTrack` 이 이미 닫았으면 아무것도 안 함(중복 저장 B10 제거).
- `finishTrack`(L2685): `complete` 로 닫고 표시.
- `setupPlayer`(L2557) 맨 앞: 이전 추천의 재생 중 곡을 `new_rec` 로 닫은 뒤 초기화(B11).
- 「기록하고 나가기」: `session_end`.
- 자동재생 실패(L2640, 15초 포기): `autoplay_fail`(started=false).
- `visibilitychange: hidden`: 닫지 않고(백그라운드 재생 계속) 스냅숏을 `localStorage["azt_wp_pending_v1:<uid>"]` 에 저장. `pagehide`: 스냅숏을 `pagehide` 원인으로 확정 저장.
  다음 실행에서 남은 스냅숏을 `track_exit{cause:"pagehide", recovered:true}` 로 한 번 쓰고 지운다.
- 백그라운드 보정 `bg_credit_s`: 끝을 watchdog·worker·visible 로 감지했고 숨김 직전 재생 중이었으면 `min(duration − 마지막 표본 위치, 숨김 벽시계 초)`.
- `instance` = 이 추천에서 그 곡의 몇 번째 재생인지. `listened_s` 는 그 재생분만(곡별 누적에서 시작 시점 값을 뺌).
- 위치는 **시퀀스 위치**(`seq` 인덱스+1)로 쓰고 재생 큐 위치는 `queue_pos` 로 따로(B14 — `QUEUE = seq.filter(trackId)` 때문에 어긋남).

### 7.4 `users/{uid}.wp_personal_v1` (유일한 새 영속 상태, `set(..., { merge: true })`, 회원만)

```js
{ schema: 1, app: "web-personal", updated_at: serverTimestamp,
  opt_out: false,
  resets: { procedure: ms },
  dislike_reasons: { song_id: { reason, at_ms } },      // 최대 500, 오래된 것부터 뺌 (B16)
  state_at: { song_id: ms },                           // 좋아요·싫어요·벽 '켠' 시각, 최대 1000 (경과일 계산)
  gate_off_until: { gate: ms },
  calib_prompt_seen: { "current:불안해요": ms } }
```

크기 상한 64KB(`fsWrite` 가 넘으면 오래된 항목부터 줄임). 운영 앱은 이 필드를 모르고 무시한다. 계정 삭제(L3972–3984)는 users 문서째 지우므로 함께 사라진다.
`recommendations`·`context_events` 는 보안규칙이 삭제를 막아 남는다 — 삭제 확인 문구에 이 사실을 적는다.

### 7.5 쓰기 보호 `fsWrite(kind, target, data, opts)` (APP)

| kind | 대상 | 허용 최상위 키 | 크기 | 조건 |
|---|---|---|---|---|
| `rec` | `recommendations/{id}` set | user_id, is_anonymous, created_at, algorithm_version, input, sequence | 200KB | — |
| `event` | `context_events` add | user_id, rec_id, type, payload, created_at | 10KB | — |
| `user_patch` | `users/{uid}` merge | likedSongs, dislikedSongs, playlists, playlistNotes, wallMeta, wallArtists, favorite_tracks, preferred_artists, display_name, recommend_minutes, lyric_preference_default, preferred_genres(내 방 저장만), onboarding 필드, wp_personal_v1, updated_at, created_at, skipped | 64KB(wp) | **회원만**(B19) |
| `stats` | `song_stats/{id}` merge increment | likes, dislikes, completes, clicks, playlistAdds, sum_change, n_change (기존 7개) | — | likes/dislikes 는 `on:true` 일 때만, completes 는 c ≥ 0.70 일 때만, sum_change/n_change 는 `touched` 이고 10초 이상 들은 곡만(B6·B12·B29) |
| `history` | `users/{uid}/listeningHistory` add | 기존 행 | 5KB | **회원만**(B24) |

`AZT_ENV.writes === false`(로컬 기본·데모)면 Firestore 를 부르지 않고 `console.info` + `SESSION_LOG` 에만 쌓는다.
계정 삭제의 batch 삭제만 예외로 허용 목록에 둔다. `check.mjs` 가 index.html 의 모든 `.add(`/`.set(`/`.update(` 가 `fsWrite` 안에 있는지 검사한다.

**멈추는 쓰기**: 추천마다 `preferred_genres`·`recommend_minutes`·`lyric_preference_default` 를 계정에 덮어쓰던 것(L3546–3548, B2),
익명 사용자의 users 문서·listeningHistory 쓰기(B19·B24), `LISTEN_HISTORY` 의 localStorage 저장(읽는 곳 없음, B26).

---

## 8. 버그 수정 목록

모두 `76e8bdf` 에서 확인했다. "담당"은 §9 소유자.

| ID | 위치 | 문제 | 수정 | 담당 |
|---|---|---|---|---|
| B1 | rules `preference.dislike_scope` | `arrival_mismatch`·`length` 키가 없어 `_no_reason`(취향 전체 싫어요)으로 처리 | `personalization.taste.dislike_scope_add` → `aggregateAffinity` opts (기본 절 불변) | ENGINE |
| B2 | index L2363, L3546–3548 | 세션 장르 선택이 `preferred_genres` 로 저장되고 그게 '좋아요' 항목으로 세여 내 평균(like_base)을 부풀림 | 추천 때 저장 안 함, 취향 항목에서 제외(D3) | APP·ENGINE |
| B3 | index L2664–2681 | 스킵 = 이전/다음/점프 아무거나, 들은 시간 무관 | `track_exit`·§3.1 조기 넘김 정의 | APP·ENGINE |
| B4 | rules `preference.implicit`, engine L260–262 | 완주 기준 0.8·반응 없음 = 부정 1 — 9/20 합의(30/70%, ¼)와 다름 | 청취 표 `vote`(§3.2), 기본 경로는 그대로(I0) | ENGINE |
| B5 | index L1566–1574 | `taste_vector` 저장만 되고 안 쓰임 | 쓰지 않는다고 명시(핀과 중복) | 문서 |
| B6 | index L2512–2515 | 좋아요·싫어요를 끌 때도 `song_stats` +1 | `on:true` 일 때만 | APP |
| B7 | rules `rules_hash` | 파일 `7a9dc8823c84` ≠ 계산 `f5f8ca824e6b`(2026-09-27 확인) | 규칙 수정 뒤 `--write`, `check.mjs` 가 불일치면 실패 | ENGINE·TOOLS |
| B8 | index L2403–2413, L3517 | 최근 곡 = 이 기기 localStorage 60, '추천된' 곡 기준 | 기기 무관 노출 창(§4.10.2) | ENGINE·APP |
| B9 | 7차 결정, index L3899–3905 | `misfit_reasons`·`note_ai` 집계 전용 | web-personal 에서 개인 경로 학습에 사용(D1) | ENGINE |
| B10 | index L2688 + L2604 | 끝까지 들은 곡이 `complete`·`track_switch` 로 두 번 저장 | `closeExposure` 1회 | APP |
| B11 | index L2557–2563 | 새 추천을 받으면 듣던 곡 기록이 저장 없이 사라짐, 탭 닫힘도 유실 | `new_rec`·`pagehide` 닫기 + 복구 스냅숏 | APP |
| B12 | index L2699–2705, L2758–2766 | 백그라운드에서 끝난 곡의 청취 시간이 적게 잡힘 | `bg_credit_s` | APP |
| B13 | index L1726 | like/dislike 이벤트에 켬/끔 방향 없음 | `on` | APP |
| B14 | index L2558, L2669 | 이벤트 `position` 이 재생 큐 위치(트랙 ID 없는 곡 제외)라 시퀀스 위치와 어긋남 | 시퀀스 위치 + `queue_pos`, 학습은 `(rec_id, song_id)` 조인 | APP·ENGINE |
| B15 | index L2453, L2471–2492 | 추천 문서 ID 가 `await add` 뒤에 생겨 그 전 이벤트는 `rec_id: null` | 동기 문서 ID | APP |
| B16 | index L2203 | 400건 창을 넘으면 싫어요 이유가 사라짐 | `wp_personal_v1.dislike_reasons` + 3쪽 읽기 | APP·ENGINE |
| B17 | index L3601, L3895 | 슬라이더 기본 0 을 안 건드린 것과 "그대로예요"를 구분 못 함 | `touched` | APP |
| B18 | index L3549–3554 | 자연어 조건으로 만든 추천인데 로그에는 복원된 사전설정(장르·시간)이 찍힘 | `input.effective`(복원 전 값) | APP |
| B19 | index L1661–1671 | 익명 uid 도 users 문서에 씀 → 나중에 계정 연결하면 문서가 있어 온보딩을 건너뜀 | Firestore 쓰기는 `isMember()` 일 때만 | APP |
| B20 | index L3477–3483 | 속도 전환점 `PACE_TP` 가 앱에만 있음(원칙 위반) | `personalization.pace.manual_tp` + `inputs.pace` | ENGINE·APP |
| B21 | index L3532 | 더 들을 곡에 `instrumental_only` 게이트가 빠져 보컬곡이 섞임 | 엔진 extras(회원) + 앱 옛 경로도 거름(익명) | ENGINE·APP |
| B22 | index L3522–3537 | 더 들을 곡이 원좌표 거리순, 취향·가수 상한·시드·전환 무시, 재생 큐에 없음 | `recommendExtras` + 큐 | ENGINE·APP |
| B23 | index L2142 | `renderMyAzt` 의 게스트 판정이 `!currentUser` — 익명도 currentUser 가 있어 회원 화면이 보임 | `!isMember()` | APP |
| B24 | index L1807–1812 | 익명 사용자도 listeningHistory 에 씀(고아 기록) | 회원만 | APP |
| B25 | index L2418–2429 | 세션 번호가 기기별이라 두 기기에서 같은 시드 | 불러온 오늘 추천 수와 합침 | APP |
| B26 | index L1814–1815 | 청취 기록을 localStorage 에 저장하지만 어디서도 읽지 않음 | 저장 중단 | APP |
| B27 | engine L434, L541–542 | 가수 상한이 `"A;B;C"` 문자열 통째 기준 — 10차 문서의 가수 키 단위 수정이 코드에 없음 | P 모드 키 단위(`artist_cap_by_key`) | ENGINE |
| B28 | engine L452(2.5.1) | 도착 걸음 실거리 → 동점 없음 → 목표 칩마다 같은 곡으로 끝남 100% | 반경 r(§4.6) | ENGINE |
| B29 | index L2519–2522 | `post_change.change` 를 안 들은 곡까지 경로 전 곡에 분배 | 10초 이상 들은 곡 + `touched` 만 | APP |
| B30 | index L3972–3984 | 계정 삭제가 추천·이벤트 로그는 못 지우는데 안내 없음 | 확인 문구에 명시 | APP |

---

## 9. 파일 소유와 인터페이스 계약

### 9.1 소유 (한 파일은 한 사람만 고친다)

| 담당 | 파일 | 하지 않는 것 |
|---|---|---|
| **ENGINE** | `engine/engine.js` · `engine/personal.js`(새) · `engine/test/*.test.mjs`(새, `node --test`, 작은 합성 카탈로그만) · `rules/rules.compiled.json` · `change.md`(병합 때 §13 반영) · `node tools/rules_hash.mjs --write` 실행(스크립트 자체는 고치지 않음) | DOM·Firebase 코드, 데이터 저장소 접근 |
| **APP** | `index.html` · `sw.js` · `pwa.js` · `manifest.webmanifest` · `env.js`(새, 배포용 고정값) | 숫자 만들기(모든 숫자는 규칙·`personal.js` 에서), 엔진 로직 복제 |
| **TOOLS** | `server.mjs`(새, 저장소 루트) · `tools/sim/*.mjs`(새) · `tools/sim/fixtures/*.json`(합성) · `demo/personas/*.json`(합성, 생성물) · `docs/personal_eval_YYYYMMDD.md`(생성물) · `.gitignore` · `README.md`(실행법) | `engine/`·`index.html` 수정, 데이터 저장소 checkout/merge/commit/push, 캐시 파일을 저장소 밖에 남기기 |

`package.json` 없음. Node 24 내장 모듈만. 데이터 저장소는 `git -C "<eumchichi-data>" show origin/master:<path>` 로만 읽는다(작업 트리는 일부러 낡아 있음).
기준 엔진은 `git -C <web-personal> show 76e8bdf:engine/engine.js` 를 OS 임시 파일로 써서 import 한 뒤 **바로 지운다**(azt_app.mjs 의 `importSource` 방식).

### 9.2 ENGINE 이 내놓는 인터페이스 (첫날 스텁으로 먼저 커밋)

**`engine/engine.js`**

```js
export const ENGINE_VERSION = "2.6.0-wp";
export function recommend(catalog, rules, inputs)            // inputs + { pace?: "fast"|"slow"|null, personal?: PersonalPolicy|null }
export function recommendExtras(catalog, rules, inputs, result, { target_sec })   // §6.7
export function aggregateAffinity(items, rules, opts = undefined)   // opts: { scope_add?, extra_feature_ids? }; 항목에 vote?, feature_bins_p?
export function sanitizePersonal(p, rules, { duration_min, pace })  // → 동결 PersonalPolicy | null
export function adjFeatures(a, b, P)                          // → { tempo, vocal, spoken, genre, bpm_diff }
export function adjCost(a, b, P)                              // → number (R9)
export function workingCoords(catalog, rules)                 // → Map<song_id, [v, a]> (prepare 의 ecdf 와 동일)
export function makeExtraBinner(fullCatalog, specs)          // → fn(song) → { id: "low"|"mid"|"high" }, zero_is_unknown 지원
export function seededUniform(seed, ...keys)                  // → [0, 1)
export { fnv1a32, songCount, transitionAt }                   // 기존 함수에 export 만
// 기존 export 유지: median, percentile, artistKeys, makeFeatureBinner, renderExplanations
```

**`engine/personal.js`** (순수 ESM, `engine.js` 만 import, `Math.random`·`Date.now` 금지)

```js
export const PERSONAL_VERSION = "p1.0.0";
export const SCHEMAS = { raw: "wp-raw/1", model: "wp-model/1", policy: "wp-policy/1", meta: "wp-meta/1" };
export function emptyModel(rules)                                        // → PersonalModel (중립)
export function normalizeLogs(raw, catalogIndex, rules)                  // → NormalizedLog (§6.3)
export function buildPersonalModel(norm, catalogIndex, rules, { as_of_ms })   // → PersonalModel (§6.4)
export function stressOf(point, rules)                                   // {v,e} → 0..4
export function tablePoint(field, labels, vocab)                         // "current"|"target" → {v,e}|null
export function calibratePoint(model, field, labels, tablePt, rules)     // → { point, applied, basis, prompt }
export function suggestMinutes(model, baseMinutes, rules)                // → { minutes, bias_log2, applied }
export function resolvePolicy(model, ctx, rules, { mode = "personal" } = {})
    // ctx = { now, target, now_table, target_table, labels, nudged, minutes, lyric, genres, pace_user, seed, global_stats, disliked_now, session_no }
    // → { policy: PersonalPolicy, user: EngineUser, explain: Chip[], meta: PersonalMetaDraft }
export function neutralPolicy(rules)                                     // I1 항등원
export function pathMetrics(result)                                      // → { arrival, max_jump, reversals, turns, n, hold_zigzag, start_dist }
export function safetyCheck(resA, resR, rules)                           // → { ok, violations: string[], A, R }
                                                                         // [변경 2026-09-29] safetyCheck(resA, resR, rules, { resRp }) → { ok, violations, lane, A, R, Rp }
                                                                         //   + export PATH_PARAM_KEYS, pathParamsDiffer(polA, polRef) (§2.2 7)
export function buildRecLog({ ctx, policyOut, resA, resR, extras, safety, fallback, env, catalogIndex, rules })   // → §7.1 의 input/sequence (서버 시각·user_id 제외)
export function validateEvent(type, payload)                             // → { ok, errors } (로컬·도구에서 모양 검사)
export function listenVote(exposure, rules, attribution = 0)             // → { pos, neg } | null   (시험용)
export function transitionLabel(prevExp, exp, session, rules)            // → 0 | 1 | null            (시험용)
export function explainPolicy(policy, model, rules)                      // → Chip[] ≤ 3   { id, text, procedure }
export function explainModel(model, rules, { history } = {})             // → Card[]        { id, title, text, evidence, confidence, is_default, changed, series, reset_procedure }
                                                                         //   history 를 안 주면 모델이 로그에서 모은 최근 10개 추천의 used 값(personal_meta.params)으로 추이를 그린다
export function digest(obj)                                              // fnv1a32 hex over canonical JSON(키 정렬)
```

`EngineUser = { disliked, recent_played /* = exclude_ids, 호환용 */, global_stats /* ctx 에서 그대로 */, like_base, song_likes, artist_affinity, genre_affinity, feature_affinity }`.

**첫날 스텁**: 모든 함수가 올바른 모양을 돌려준다 — `normalizeLogs` 는 빈 세션, `buildPersonalModel` 은 `emptyModel`, `resolvePolicy` 는 P0,
`calibratePoint` 는 입력 좌표 그대로. APP·TOOLS 는 스텁으로 배선을 끝내고, ENGINE 은 안쪽만 채운다.

### 9.3 TOOLS 가 내놓는 것

**`server.mjs`** — `node server.mjs [--port 5180] [--host localhost] [--writes] [--env .env] [--debug]`

- `localhost` 에 묶는다(Firebase 인증 승인 도메인 기본값). 포트 5180 은 fix-web 과 달라 서비스워커·캐시를 공유하지 않는다.
- `.env` 손 파싱(`KEY=VALUE`, `#` 주석, 기존 환경변수는 덮지 않음) → `GEMINI_API_KEY`. `.gitignore` 에 `.env*`(공개 저장소).
- `GET /env.js` → `window.AZT_ENV = { app:"web-personal", env:"local", writes:<--writes 여부>, sw:false, personal:true, debug:<--debug> }`.
  저장소의 정적 `env.js`(APP)는 배포용 `{ env:"prod", writes:true, sw:true, personal:true, debug:false }`. index.html 이 앱 스크립트보다 먼저 불러온다.
- `ALL /api/:name` — `api/<name>.js` 가 있을 때만(`gemini`, `soundiiz`). `await import(pathToFileURL(file).href + "?t=" + mtime)`.
  요청 흉내: `method, headers, url, query, body`(최대 1MB 버퍼, 넘으면 413 · `application/json` 이면 파싱, 빈 본문 `{}`, 잘못된 JSON 400).
  응답 흉내: `status(n)`(체이닝), `json(o)`, `send`, `setHeader`, `end`. 핸들러를 `await`(soundiiz 는 promise 반환). 예외는 500 JSON, 없는 API 는 404.
- `GET /api/health` → `{ ok, app:"web-personal", engine_version, rules_hash, personal_version }`.
- 정적 파일: 쿼리 제거·`decodeURIComponent`·`path.resolve(root, "."+p)` 가 root 안이어야 함·점 파일(`.env`, `.git`)과 `..` 거부(404)·`/` → `index.html`·SPA 폴백 없음.
  MIME `.html .js .mjs(text/javascript) .json .webmanifest(application/manifest+json) .png .svg .ico .css`, `Cache-Control: no-store`, HEAD 지원.

> **변경 (2026-09-30, 2차 수정) — 로컬 기본 실행은 운영 Firebase 에 접속하지 않는다(offline).** §11 H2(브라우저 픽스처)·I(쓰기 카운터)를 계정 없이 잴 수 있게.
> - `node server.mjs` 의 `/env.js` 에 `offline: true` 가 더해진다(기본). `--firebase` 를 주면 `offline: false` — 예전처럼 운영 Firebase 에 로그인·곡 읽기(쓰기는 여전히 `--writes` 때만).
> - `local_firebase.js`(APP, index.html 이 Firebase SDK 뒤·앱 스크립트 앞에서 부름): `offline` 이면 `window.firebase` 를 이 탭 안의 대역으로 바꾼다 —
>   익명 로그인은 가짜 익명 사용자(`local-anon`, 네트워크 없음), 이메일·구글 로그인은 거절, 모든 읽기는 빈 결과, 모든 쓰기는 거절하고 센다(`AZT_DEBUG.writes().local_firebase`).
>   배포(정적 `env.js`)에서는 아무것도 하지 않는다.
> - `GET /api/local-catalog` → `{ n, digest, source, songs }` — `tools/sim/catalog.mjs` 의 `loadCatalog`(데이터 저장소 `git show`, 읽기 전용)가 만든 계약 곡을 그대로.
>   앱 `init()` 은 offline 이면 Firestore `songs` 대신 이것을 받아 `localSongOf`(toContractSong 의 역함수)로 SONGS 를 만든다 — 브라우저 카탈로그 digest 가 Node 와 같다(33252b24).
> - `check.mjs` env 검사에 "기본 `/env.js` 가 offline:true · local_firebase.js 가 SDK 뒤·앱 앞" 을 더했다.

**`tools/sim/` 모듈** (모두 ESM, 저장소 루트에서 `node tools/sim/<x>.mjs`)

| 파일 | 내보내는 것 / 하는 일 |
|---|---|
| `catalog.mjs` | `loadCatalog({ dataRepo, ref = "origin/master", overrides = "data/instrumental_overrides.json" })` → `{ songs: ContractSong[], index: CatalogIndex, digest }`. `music_catalog_v2_20260920.csv` + `music_catalog.csv` 를 `git show` 로 메모리에 읽음(캐시 파일 없음). azt_app.mjs `loadCatalog` 와 같은 필드 규칙 + 앱과 같은 연주곡 판정(overrides) + `GENRE_RULES`. 4,117곡이 아니면 경고 |
| `app_tables.mjs` | `loadAppTables(indexHtmlPath)` → `{ MOOD_CHIPS, GOAL_CHIPS, NL_EXTRA_EMO, NL_EXTRA_GOAL, NL_K, GENRE_RULES, GENRE_RULE_EXCLUDE, deriveStress, nlCurrentPoint }` — 앵커 추출, 못 찾으면 멈춤 |
| `baseline.mjs` | `loadBaseline(ref = "76e8bdf")` → `{ engine, rules }`(임시 파일 import 후 삭제) |
| `grids.mjs` | `iso1224()`(감정 17 × 목표 8 × 15·30·60분 × 시드 3), `adj660()`(지금 칩 11 × 목표 칩 6 × 15·30분 × 시드 5), `probe()` |
| `regress.mjs` | CLI `--grid iso1224\|adj660\|probe\|all --check i0\|i1\|affinity\|pace`. 불일치 1건이라도 있으면 exit 1, 첫 차이를 출력 |
| `personas.mjs` | `PERSONAS` (§9.4 표) |
| `behavior.mjs` | **순수 ESM(브라우저에서도 import)** `respond(persona, recLog, catalogIndex, { rngKey, history })` → `{ events, nudges, answers, quit }` — §7 모양 그대로 |
| `fixweb_twin.mjs` | 쌍둥이: 2.5.1 엔진 + 76e8bdf 규칙 + fix-web 앱 규칙(`buildHeardItems` L2328–2365 의 2.5.0 암묵 표, 로컬 최근 60, `PACE_TP` 사본, 옛 extras) |
| `run.mjs` | CLI `--personas all --sessions 10 --reps 5 --arms wp,twin,frozen [--grid]` → `docs/personal_eval_YYYYMMDD.md` + 같은 이름 `.json`(`--json` 일 때). 모든 수치에 "합성 사용자" |
| `sweep.mjs` | CLI `--param adjacency.scale --values 0,0.5,1,1.5,2 --grid adj660,iso1224` → 표와 근거 문자열 초안 |
| `replay.mjs` | `--recs <내보낸 추천 JSON> --catalog-ref origin/master` → 로그의 `personal_policy`+`user_affinity`+입력으로 다시 돌려 `sequence` 일치율(카탈로그 digest 가 다르면 건너뜀) |
| `check.mjs` | 정적 검사(§11 I) |
| `demo_personas.mjs` | 페르소나 10세션을 돌려 `demo/personas/<id>.json`(RawFacts 모양, 합성) 생성 |

환경: 데이터 저장소 경로 기본 `C:/Users/green/Desktop/구글캡디/eumchichi-data`, `--data-repo` 또는 `AZT_DATA_REPO` 로 바꿈.

### 9.4 시뮬레이터 — 페르소나와 행동 모형 (TOOLS, 숫자는 `personas.mjs` 한 곳)

**세션 일정**: 반복(rep)마다 10세션, 세션 간격 ~ Exp(평균 1.5일)(시드 고정), 감상 시간 기본 30분(P9 는 30분으로 시작).
입력: 페르소나의 습관 단어 3개 중 하나(70%) 또는 칩 전체에서 무작위, 목표 칩 6개 중 무작위. 시드 `wp-<persona>:<rep>:<k>`.
**공통 난수**: 반응 난수는 `(persona, rep, session, song_id, 목적)` 로 키를 잡아, 세 팔(wp·twin·frozen)에서 같은 곡에 같은 반응이 나오게 한다(쌍 비교 분산 감소).

| id | 이름 | 숨은 참값 |
|---|---|---|
| P0 | 신규·무취향(대조) | 취향 0, 민감도 0, π* = 0(속도 답 80% "딱", 나머지 무작위), 끌기 없음 |
| P1 | 재즈·빠르게 | 장르 재즈 +1.5, K-pop −0.5, π* = +0.8, 전환 민감도 0 |
| P2 | 연주곡·천천히·보컬 전환 민감 | 연주곡 +1.5, π* = −0.7, β_vocal = 1.5 |
| P3 | K-발라드·가사 거슬림 | 발라드 +1.2, 말 비중 '높음' −1.5, 그런 곡을 넘기면 50% `vocal_bother` |
| P4 | 반복 싫음 | 최근 3세션에 들은 곡이면 넘김 +1.5 · `too_repetitive` 70%, β_genre = 0.8 |
| P5 | 벽 아이유 | 벽 곡 5, 가수 아이유 +1.5, 다시 넣은 좋아요 곡은 끝까지 들음 |
| P6 | 빠르기 민감 | β_tempo = 1.5 만 |
| P7 | 좌표 보정자 | 「불안해요」 δ* = (−0.05, +0.08) (습관 단어 70%), 「차분해지고 싶어요」 δ* = (+0.04, 0), 보여 준 점이 0.05 넘게 틀리면 50% 끌기(참값 + N(0, 0.02)) |
| P8 | 고긴장·빠르게 | 지금 단어는 불안해요·짜증나요·답답해요·걱정돼요만, π* = +0.8 |
| P9 | 조기 이탈·짧게 | 경로 5곡째 뒤 80% 재생 멈춤, 20분 넘는 세션이면 60% `length`+`long` |
| P10 | 첫 곡 거부 | 첫 곡이 보고한 지금 좌표에서 0.05 이내면 넘김 확률 +0.4 |
| P11 | 잡음(대조) | 답·코드 무작위, 취향 무작위 약함 |
| P12 | 미리듣기(모바일) | 모든 재생 30초 미리듣기, 약한 취향 |
| P13 | 옛 기록만 | 먼저 fix-web 형식 이벤트(`track_exit` 없음) 10세션, 그 뒤 web-personal 10세션 |

**행동 모형**

- 실제 상태: `s_0 = 표(단어) + δ*`, 곡 k 뒤 `s_k = s_{k−1} + 0.35·(곡 원좌표 − s_{k−1})`.
- 취향 `u(song)` = 페르소나 효과 합(가수 키·장르·연주곡·말 비중 묶음·인기도). 전환 손실 `T_k = Σ_f β_f·x_f(앞 곡, 곡) + 1.0·max(0, 작업좌표 전환 − 0.10)/0.10`.
- 조기 넘김 확률 `σ(−2.2 − 1.0·u + T_k + 반복항) + 첫곡항`(0~1 로 자름). 아니면 완주율 u > 0 → Beta(6, 1.5), 아니면 Beta(2, 2).
- 좋아요: u > 0.8 이고 c ≥ 0.7 이면 50%. 싫어요: u < −1.2 이고 넘기면 30% `not_my_taste` · T_k > 1.2 이고 넘기면 20% `path_jump`.
- 「듣고 난 뒤」 60% 응답: 잠재값 `Ũ = −2.5·‖s_n − 참목표‖/0.1 − 0.5·#(T_k > 1) − 1.0·|π* − π_used| − 0.5·#반복`,
  `change = clamp(round(1.5 + 0.6·Ũ + N(0, 0.6)), −2, 2)`, `touched: true`. 조건을 넘는 이유 코드마다 70% 선택(위치 포함, 출처 user), 세션 10% 는 AI 가 무작위 코드 하나 추가(출처 ai).
- 속도 답 70%: |π* − π_used| > 0.25 면 방향, 아니면 "ok". |π*| ≥ 0.7 이면 세션마다 20% 로 해당 속도 버튼을 직접 누름.
- **평가 지표**는 잡음 없는 잠재 기대값 `E[change]` 를 쓴다(응답 표집 잡음 제거).

### 9.5 APP 작업 목록 (index.html · sw.js · pwa.js · manifest · env.js)

| # | 할 일 | 관련 |
|---|---|---|
| 1 | `env.js` 로드(앱 스크립트보다 먼저) · `AZT_ENV` · 끄는 스위치 3개(`rules.personalization.enabled`, `?personal=0`, `wp_personal_v1.opt_out`) | I11 |
| 2 | `fsWrite(kind, …)` 로 모든 Firestore 쓰기 통일, 허용 키·크기·회원 조건·쓰기 끔 | §7.5, B19·B24 |
| 3 | 추천 문서 동기 ID(`doc()` → `set`), `SESSION_LOG` | B15, §2.3 |
| 4 | `closeExposure(cause)` / `track_exit` · 시퀀스 위치 · `queue_pos` · 백그라운드 보정 · `pagehide` 복구 · `track_milestone`·전환 추적 끔 | §7.2–7.3, B10–B14 |
| 5 | like/dislike `on`, `song_stats` 는 켤 때만, completes 는 c ≥ 0.70 | B6, B13 |
| 6 | 「듣고 난 뒤」: 속도 답 한 줄(늘 보임) · `length` 선택 시 길이 방향 칩 · `touched` · `heard` · `rec_id` | §4.3, §4.5, B17, B29 |
| 7 | 지금·목표 점 끌기(pointer) + `NUDGED` · 표 좌표·라벨 보관 · `calibratePoint` 호출 · 옅은 고리·"원래 위치로" · 안내 문구 | §4.1–4.2 |
| 8 | 로그인 시 RawFacts 읽기(추천 100·이벤트 400×3쪽·users) → `normalizeLogs` → `buildPersonalModel`, 세션 종료 때 재빌드 | §2.3, §6.1 |
| 9 | `recommend()` 재구성: ctx → `resolvePolicy`(개인·p0) → 실행 A·R → 완화 순서 → `safetyCheck`·폴백 → `recommendExtras` → `buildRecLog` → `fsWrite("rec")` | §2.2 |
| 10 | `inputs.pace = PACE_MODE`(PACE_TP 사본 삭제) · 속도 안내(`#paceNote`) · `pace_choice` 이벤트 | §4.3, B20 |
| 11 | 감상 시간 제안(`suggestMinutes`)으로 슬라이더 기본값 + 안내 · 추천 때 선호 필드 저장 중단 | §4.5, B2 |
| 12 | 더 들을 곡 재생 큐 편입(회원) · 익명 옛 경로의 `instrumental_only` 거름 | §4.11, B21–B22 |
| 13 | 결과: "이번 추천에 반영된 나" 칩 · 기본 추천과 비교 토글(`#emotionMap` 점선, 바뀐 곡 표시, `compare_view`) · 소프트 게이트 칩 [끄기] | §4.12.3, §4.9 |
| 14 | 내 방 "내 취향 모델" 패널(`explainModel`) · 카드별 [초기화](`personal_reset`) · "개인화 끄기" | §4.12.3 |
| 15 | 시드 세션 번호 합산 · `renderMyAzt` 게스트 판정 `!isMember()` · localStorage 청취 기록 저장 중단 · 계정 삭제 안내 문구 | B23, B25, B26, B30 |
| 16 | `AZT_DEBUG.dumpContract(ids)` · 개발 페이지 `?fixture=<name>`(digest 출력, 쓰기 끔) · `?demo=<persona>`(P1) | §6.2, §11 H2, §4.12.4 |
| 17 | `sw.js` VERSION `azt-personal-v1`, 셸에 `engine/personal.js`·`env.js` 추가, 엔진·규칙·personal 은 network-first · `pwa.js` 는 `AZT_ENV.sw === false` 면 등록하지 않고 기존 localhost 등록 해제 · 캐시 무력화 `?v=300` · manifest `name`/`short_name` 에 개인화판 표시 | §9.3 |

---

## 10. `rules.compiled.json` 의 `personalization` 절 (전문)

규칙 파일 변경: `rules_version` "v2.4.0" → **"v2.5.0-wp"**, `note` 에 한 줄 추가, 최상위 `personalization` 절 추가, `explanations` 4개·`trace_keys` 추가(§6.8).
기존 절(`preference`, `iso`, `path`, `diversity`, `gates` …)의 값은 **하나도 바꾸지 않는다**(I0). 마지막에 `node tools/rules_hash.mjs --write`.
근거 문자열의 표지: **[agreed]** 팀 합의 · **[measured]** 측정 근거(출처 명시) · **[prior]** 근거 없는 사전값(스윕·재추정 계획 명시) · **[derived]** 다른 값에서 유도.

> **변경 (2026-09-29, 1차 수정)** — 아래 전문은 명세 시점 값이다. 규칙 파일이 기준이며 바뀐 것: 새 키 `safety.pers_bucket_bands 0.25` ·
> `safety.envelope.reversal_tol 0` · `path_wp_step_allow 1` · `hold.min_pool 12` · `hold.order "last_fixed_turn"` · `hold.cluster true` · `hold.quantize_path true` ·
> `start.expect_transition true` · `taste.group_z_min 1.28` · `gates.soft_spoken.corroborate_codes true` · `bounds.pers_bucket_bands [0, 0.5]` · `bounds.hold_min_pool [0, 24]`;
> 값 변경 `taste.mu_max 0.5 → 1.0` · `calib.w_edit 1.0 → 3.0` · `pace.apply_abs 0.15 → 0.3` · `gates.soft_spoken.vocal_bother_min 2 → 1`. 각 키 옆 `*_evidence` 에 측정 표.
>
> **변경 (2026-09-30, 2차 수정)** — 새 키 `safety.pers_mode "perturb"`(+ `pers_mode_evidence`) · `hold.cluster_break "j_hold"`(+ `cluster_break_evidence`) ·
> `bounds.pers_jitter_bands [0, 0.25]`(+ `pers_jitter_evidence`). 값 변경 없음.

```json
"personalization": {
  "schema": "wp-policy/1",
  "enabled": true,
  "members_only": true,
  "p0_for_anonymous": false,
  "evidence": "[agreed] web-personal 전용. 로그인 사용자에게만 inputs.personal 을 만든다(9/17 결정: 익명은 개인화 없음). enabled=false 이거나 personal 이 없으면 엔진은 2.5.1 과 같은 출력(I0). p0_for_anonymous 는 익명에게 모집단 기본 정책(머묾 반경·기본 전환 비용)을 줄지 — 팀 결정 전까지 false.",
  "load": {
    "recs": 100, "event_pages": 3, "event_page_size": 400, "history_rows": 300, "orphan_window_h": 3, "rerequest_window_s": 600,
    "load_evidence": "[prior] 읽기 비용과 400건 창 유실(B16) 사이의 절충. recs 100·events 400 은 기존 loadPersonalFeedback 값, 쪽수 3 은 약 30~60세션을 덮는 양. orphan 3시간은 rec_id 없는 옛 이벤트를 붙이는 창."
  },
  "decay": {
    "session_gamma": 0.85, "calib_half_life_days": 60, "transition_half_life_days": 45, "lookback_sessions": 10,
    "decay_evidence": "[prior] 취향 감쇠는 preference.decay.half_life_days(14)를 그대로 쓴다. 방향 신호(속도·길이)는 세션 단위 0.85(약 4세션 반감). 좌표 습관은 하루 기분보다 느리게 변한다고 보고 60일, 전환 민감도는 45일. 규칙형 학습기는 최근 10세션만 본다."
  },
  "outcome": {
    "exposure_min_s": 3, "heard_min_s": 10, "skip_below": 0.30, "keep_from": 0.70, "engaged_prev_min": 0.5,
    "preview_max_duration_s": 31, "preview_catalog_min_s": 45, "preview_factor": 0.5, "legacy_factor": 0.5, "quit_gap_s": 1800,
    "outcome_evidence": "[agreed] 30%·70% 는 9/20 합의 문턱. heard 10초는 좋아요 버튼이 열리는 HEARD_MIN_SECONDS 와 같음. [prior] 노출 3초(실수 두 번 누름·자동재생 끊김 제외), 미리듣기 판정 31초/45초, 미리듣기·옛 기록 반값, 앞 곡 몰입 0.5, 이탈 판정 30분."
  },
  "listen_vote": {
    "unit": 0.25, "per_song_cap": 1.0, "skip_causes": ["next", "jump"],
    "no_vote_causes": ["prev", "pagehide", "new_rec", "session_end", "autoplay_fail", "unknown"],
    "listen_vote_evidence": "[agreed] 9/20 합의: 청취 30% 미만 약한 −, 30~70% 0, 70% 이상 +, 크기는 좋아요의 1/4. [derived] 부정 표는 실제 넘김(next/jump)일 때만 — 탭 닫힘·새 추천은 취향이 아니다. [prior] 곡당 암묵 표 합 1(자주 나온 곡 과대표 방지)."
  },
  "safety": {
    "stress_w_v": 0.6, "stress_w_a": 0.4, "high_stress_min": 3,
    "high_stress": { "faster_pace_allowed": false, "discovery": false, "hold_radius_max": 0.035, "start_offset_max": 0.075, "adj_mult_min": 1.0 },
    "corridor_bands": 1, "j_move_bands": 1.5, "j_hold": 0.0125,
    "envelope": { "arrival_abs": 0.040, "arrival_over_ref": 0.012, "max_jump_abs": 0.25, "max_jump_over_ref": 0.05, "reversal_eps": 0.01 },
    "safety_evidence": "[prior] 스트레스 식은 앱 deriveStress(0.6/0.4)와 같음 — 불안·짜증·답답·걱정 칩이 3. 고긴장 안전 집합은 팀 결정 D5. 코리도어 1 밴드·J 1.5 밴드면 개인 항이 최선 밴드보다 2 밴드 이상 나쁜 곡을 고를 수 없다(명세 §3.8 정리). 머묾 J 0.0125 는 band 의 절반. [measured] 봉투 기준: 2.5.1 도착 오차 90% 0.035, r=0.035 제안 0.035(iso_path_quality_20260926), 최대 전환 중앙 0.145."
  },
  "calib": {
    "k_user": 4, "k_label": 2, "max_axis": 0.10, "cross_neutral_min_edits": 4, "min_edits_label": 2, "min_edits_global": 4,
    "edit_eps": 0.01, "w_edit": 1.0, "w_accept": 0.25, "clamp": [0.04, 0.96], "prompt_after_mismatch": 2, "prompt_repeat_days": 7,
    "nl": { "substitution": false, "subst_min_n": 3, "subst_min_rate": 0.6, "intensity_bias": false, "intensity_apply_abs": 0.5 },
    "calib_evidence": "[prior] 두 층 축소(개인 전체 k=4, 단어 k=2 — preference.shrinkage.personal_k 와 같은 라플라스 무게). 관측은 항상 표 좌표 기준 o=최종−표. 한 축 0.10 상한은 칩 사이 간격(0.05~0.10) 수준. clamp [0.04,0.96] 은 기존 nlClamp. [measured] 화살표 한 칸 0.05(L2869). 자연어 치환·강도 편향은 P2, 기본 꺼짐."
  },
  "pace": {
    "manual_tp": { "fast": 0.5, "slow": 1.0 }, "tp_fast": 0.5, "tp_slow": 1.0,
    "vote_step": 0.5, "w_chip": 1.5, "w_answer": 1.0, "k0": 1.0, "apply_abs": 0.15, "small_n_max": 3, "small_n_min_tp": 0.75,
    "quit_guard": { "enabled": true, "min_sessions": 5, "prior_sessions": 2, "apply_below": 0.9 },
    "pace_evidence": "[measured] manual_tp 는 앱 PACE_TP(L3477) 값을 그대로 옮김(fast 0.5 → 30분 8곡 중 5번째 도착, slow 1.0 → 8번째; personalization_probe_20260926). [prior] 표 크기 0.5·가중 1.5/1·k0 1·적용 문턱 0.15. n≤3 에서 tp≥0.75 는 t=0,1,1 퇴화 방지(iso.min_step_span_evidence). 이탈 가드는 5세션 이상·가상 2세션(f=1)·중앙 도달 0.9 미만일 때."
  },
  "start": {
    "arms": [0, 0.075, 0.15], "min_journey": 0.15, "min_first_songs": 5, "ratio_up": 1.5, "pop_first_ratio": 1.2, "down_mismatch_n": 2,
    "start_evidence": "[prior] ISO 시작 일치는 치료 전제라 기본 0, 최대 여정의 15%(고긴장 7.5%). 팀 결정 D2(음악중재 자문). 첫 곡 거절률을 나머지 곡 대비·취향 기대 거절률로 표준화하고 모집단 기저비 1.2(누구나 첫 곡을 조금 더 넘김 — 실제 로그로 재추정)로 나눈 값이 1.5 이상이고 mood_mismatch 명시 확인이 있을 때만 올린다."
  },
  "length": {
    "base_sessions": 5, "vote_step_log2": 0.3, "k0": 1.0, "clamp_log2": [-0.5, 0.5], "apply_abs_log2": 0.1, "round_minutes": 5, "minutes_range": [5, 90],
    "length_evidence": "[prior] 감상 시간은 사용자 선언이라 바꾸지 않고 다음 기본값만 제안한다. 표 크기 0.3(≈23%)을 기준 시간(무게 1)과 평균하므로 한 번 답에 약 11% 이동(30분→27분→5분 단위 25분), 최대 ±41%(0.5). 5분 단위·5~90분은 기존 슬라이더 범위."
  },
  "hold": {
    "p0_radius": 0.035, "arms": [0, 0.02, 0.035, 0.05], "min_songs": 5, "order": "last_fixed_progress", "smooth_max_tail": 6,
    "arrival_mismatch_min": 2, "repetitive_min": 2,
    "hold_evidence": "[measured] hold_segment_proposal_20260925·iso_path_quality_20260926: 2.5.1 은 같은 곡으로 끝남 100%·머묾 겹침 100%. r=0.035 → 25.3%·31.9%, 도착 오차 중앙 30·45분 0.015(1,224세션 전체 0.021), 15분 0.030. 거리 순 재배열은 꺾임 18.5%, 진행 방향 순(제안 B)은 8.3% 이지만 마지막 곡이 가장 가깝지 않음 46%. 그래서 마지막 곡(최소 fit) 고정 + 나머지 진행 방향 순. min_songs 5: 15분(4곡)은 도착 걸음이 1곡뿐이라 반경만큼 오차가 커진다. [prior] 개인 계단 문턱 2회."
  },
  "taste": {
    "mu_max": 0.5, "k_mu": 8, "pin_evidence_w": 0.5,
    "dislike_scope_add": { "arrival_mismatch": [], "length": [] },
    "extra_features": [],
    "extra_features_available": [ { "id": "popularity", "field": "popularity", "bins": 3, "label": "알려진 정도", "zero_is_unknown": true } ],
    "discovery": { "min_mu": 0.15, "min_E": 4, "min_moving_steps": 3, "pause_after_skips": 3, "pause_sessions": 3 },
    "taste_evidence": "[measured] personalization_probe_20260926: μ=0 이면 취향이 곡을 거의 못 바꿈(연주곡 사용자 0%), μ=0.5 는 100% 이지만 도착 오차 0.006→0.019·최대 전환 0.180→0.220 — 결합 제한(safety) 안에서만 쓴다. [prior] μ=0.5·E/(E+8): 기록이 쌓일수록 커지는 결정식(보상 학습 없음). dislike_scope_add 는 도착·길이 불만을 취향 싫어요로 세던 문제(B1) 수정 — 기본 절은 그대로. 인기도는 P2(0=모름, 약 9%)."
  },
  "adjacency": {
    "base_weights_bands": { "tempo": 0.4, "vocal": 0.3, "spoken": 0.15, "genre": 0.15 }, "scale": 1.0,
    "bpm_scale": 60, "spoken_scale": 0.5, "half_double_fold": false,
    "large": { "tempo_bpm": 30, "spoken": 0.25, "va": 0.15 },
    "theta0": -1.73, "theta_margin": 3.0, "kappa": 2, "iterations": 20, "mult_range": [0.5, 2.0], "z_apply": 1.28,
    "min_large": 8, "min_transitions": 12, "attrib_max": 0.8, "lambda_range": [0.1, 0.25],
    "adjacency_evidence": "[measured] adjacent_similarity_20260925(660회): 추천 인접 쌍 BPM 차 중앙 28.3/90% 74.9(무작위 29.7/68.3), 보컬↔연주 11.3%(무작위 27.8%), 2개 이상 어긋남 36.6%, 말 비중 차 중앙 0.278. BPM 은 빠르기 태그×150+50 — 측정 지표와 같은 정의. large.tempo 30 은 무작위 중앙, va 0.15 는 이동 구간 중앙 0.135 근처. λ 상한 0.25: 2026-09-21 λ 스윕에서 0.25 이상 최대 전환 평탄. [prior] 기본 가중(합 1 밴드)·scale 은 스윕으로 확정(D7). θ0=logit 0.15, θ_m=3, κ=2, 적용 문턱 z=1.28(80%), 최소 8·12 는 사전값 — 실제 로그가 쌓이면 모집단 적합으로 재추정."
  },
  "gates": {
    "soft_spoken": { "vocal_bother_min": 2, "window_days": 30, "rate_ratio_max": 0.5, "min_n": 6, "expire_days": 30 },
    "soft_min_pool": 24, "user_off_days": 30,
    "gates_evidence": "[derived] soft_min_pool 24 = selection.region.min_pool(48)/2. 문턱 자체는 기존 게이트 exclude_spoken(상위 20% 제외)을 그대로 쓴다 — 태그는 문턱으로만(원칙 9). [prior] 켜짐 2회·30일, 비율 p0 의 절반·표 6, 만료 30일(게이트가 반대 근거를 가리는 흡수 상태 방지)."
  },
  "diversity": {
    "recent_window": 60, "recent_window_repetitive": 120, "repetitive_sessions_for_window": 2,
    "artist_cap_low": 1, "repetitive_sessions_for_cap": 2,
    "replay": { "cooldown_days": 7, "max_per_session": 1, "song_block_days": 30, "pause_after_skips": 2, "pause_sessions": 5 },
    "diversity_evidence": "[measured] recent_window 60 은 앱 RECENT_MAX 값을 옮김(이제 기기 무관·노출 기준). [prior] 반복 불만 2세션이면 창 2배·가수 상한 1. 좋아요 곡은 7일 뒤 시퀀스당 1곡까지 다시 넣을 수 있다."
  },
  "extras": {
    "fill_ratio": 0.85, "radius": 0.05, "default_duration_s": 210, "min_duration_s": 60, "max_songs": 12,
    "extras_evidence": "[measured] fill 0.85 는 앱 L3535 값, 곡 길이 210초는 toContractSong 기본값, 최소 60초는 앱 estimated 값. [prior] 더 들을 곡 반경 0.05(머묾 반경의 최대 팔), 최대 12곡."
  },
  "relax": {
    "order_default": ["lyric", "genre", "both"], "order_vocal_bother": ["genre", "lyric", "both"], "vocal_bother_min": 2,
    "relax_evidence": "[measured] 기본 순서는 앱 L3489–3503 그대로. [prior] 가사에 민감한 사람(instrumental_only 직접 선택 또는 30일 vocal_bother 2회)은 장르를 먼저 푼다. 소프트 게이트는 엔진이 걸음마다 먼저 푼다."
  },
  "bounds": {
    "tp": [0.5, 1.0], "quit_frac": [0, 1], "start_offset": [0, 0.15], "start_min_journey": [0.15, 1.0],
    "hold_radius": [0, 0.05], "hold_min_songs": [3, 9], "corridor_bands": [0, 2], "j_move_bands": [0, 1.5], "j_hold": [0, 0.0125],
    "adj_w_bands_each": [0, 2.0], "bpm_scale": [30, 120], "spoken_scale": [0.25, 1.0], "lambda_max": 0.25,
    "soft_min_pool": [12, 48], "exclude_ids_max": 150, "replay_ids_max": 50, "replay_max": [0, 1], "calib_axis": [-0.10, 0.10],
    "bounds_evidence": "[derived] sanitizePersonal 이 받은 정책을 여기에 맞춰 자른다(잘못된 로그·앱 버그에 대한 이중 방어). μ 상한은 max(taste.mu_max, preference.pref_weight), λ 하한은 min(0.1, path.jump_weight), 가수 상한은 [1, diversity.max_per_artist] — 기존 절에서 읽는다."
  }
}
```

`note` 에 덧붙일 한 줄: `"| v2.5.0-wp (2026-09-27): personalization 절 추가(web-personal 전용, 엔진 2.6.0-wp). 기존 절 값 불변 — personal 이 없으면 2.5.1 과 같은 출력."`

---

## 11. 수용 기준

- 모든 학습·결과 수치는 **합성 사용자**(§9.4) 기준이며, 보고서와 포스터에 그렇게 적는다.
- 팔(arm): **wp** = web-personal(학습) · **twin** = fix-web 76e8bdf 재현(§9.3 `fixweb_twin.mjs`) · **frozen** = web-personal 이지만 모델을 늘 빈 모델로(P0 고정).
- 반복 5회(모수 회복 시험은 10회), 세션 1~10. "6~10세션"은 학습 뒤 구간. 쌍 부트스트랩(반복×세션 단위, 2,000회) 95% 구간.
- **ISO 봉투(B)는 어떤 경우에도 완화하지 않는다.** 구성(C)·학습(D)·결과(E) 기준이 봉투 안에서 불가능하면, 봉투를 지키는 가장 좋은 점을 채택하고
  차이를 보고서에 적어 팀이 결정한다(기준을 조용히 바꾸지 않는다). 첫 실행 뒤 D·E 수치를 고치려면 사유를 change.md 에 남긴다.

### A. 회귀·호환 (필수, P0)

| ID | 기준 | 합격 |
|---|---|---|
| A1 | I0: `personal` 없음 — 1,224 + 660 + 탐침 격자에서 엔진 2.6.0-wp(새 규칙) vs 2.5.1(76e8bdf 규칙) | 100% 일치(버전·해시 필드 제외) |
| A2 | `inputs.pace` fast/slow vs 옛 규칙 사본 경로 | 100% |
| A3 | I1: `neutralPolicy` | 곡 순서·2.5.1 trace 키 100% |
| A4 | `aggregateAffinity(items, rules)` 2인자, 무작위 항목 집합 200 | 100% |
| A5 | P13(옛 기록만) 모델 빌드 | 오류 0, `source.n_sessions_legacy > 0`, 취향 표 생성 |

### B. ISO 봉투

| ID | 지표 (작업 좌표) | P0, 1,224 격자 | 모든 페르소나·wp 팔·세션 1~10 | 2.5.1 참고 |
|---|---|---|---|---|
| B1 | 도착 오차 중앙 / 90% | ≤ 0.025 / ≤ 0.036 | ≤ 0.025 / ≤ 0.040 | 0.007 / 0.035 |
| B2 | 세션 최대 전환 거리 중앙 | ≤ 0.155 | 90% ≤ 0.25 이고 ≤ twin 90% + 0.02 | 0.145 |
| B3 | 역행 있는 세션 / 90° 꺾임 있는 세션 / 머묾 지그재그 | ≤ 1.5% / ≤ 12% / **0%** | 같음 | 1.0% / 6.5% / 0% |
| B4 | 첫 곡↔지금 거리 중앙 (s = 0 세션) | ≤ 0.022 | ≤ 0.022 | 0.018 |
| B5 | 시드만 다른 두 세션이 같은 곡으로 끝남 (30·60분) / 목표 칩당 서로 다른 머묾 곡 | ≤ 35% / ≥ 12곡 | — | 100% / 4.2곡 |
| B6 | 경로 모수가 P0 와 같은 정책의 경유지 동일 | 100% | 100% | — |
| B7 | §3.8 정리 위반(단위 시험 10만 조합) | 0 | — | — |
| B8 | 안전 폴백 발생 세션 | — | ≤ 5% | — |

### C. 구성 (P0, 660 격자 — 신규 사용자)

| ID | 지표 | 목표 | 2.5.1 | 무작위 |
|---|---|---|---|---|
| C1a | 인접 BPM 차 중앙 / 90% | ≤ 24 / ≤ 68 | 28.3 / 74.9 | 29.7 / 68.3 |
| C1b | 보컬↔연주 전환 | ≤ 7% | 11.3% | 27.8% |
| C1c | 2개 이상 어긋난 전환 | ≤ 28% | 36.6% | 51.4% |
| C1d | 서로 다른 곡 수 | ≥ 600 | 668 | — |

### D. 학습 (합성 사용자, 세션 ≤ 10)

| ID | 페르소나 | 합격 |
|---|---|---|
| D1 | P1 / P2 속도 | 5세션 안에 π ≥ 0.35 / π ≤ −0.35 인 반복 ≥ 80% |
| D2 | P7 좌표 | 10세션 뒤 \|δ̂ − δ*\| ≤ 0.04(지금·목표 각각) 인 반복 ≥ 80% |
| D3 | P6 빠르기 | 10세션 안에 m_tempo ≥ 1.3 적용 반복 ≥ 60% · 6~10세션 BPM 차 중앙 ≤ 0.8 × twin |
| D4 | P2 보컬 전환 | 6~10세션 보컬↔연주 전환율 ≤ 0.5 × twin |
| D5 | P1·P2·P3·P5 취향 | 6~10세션 좋아하는 묶음 비율 ≥ max(1.5 × twin, twin + 10%p) (P5 는 twin + 5%p) |
| D6 | P3 게이트 | 5세션 안에 켜짐 ≥ 80% · 켜진 뒤 말 비중 '높음' 곡 ≤ 5% |
| D7 | P4 반복 | 6세션 안에 창 120 · 켜진 뒤 5세션 동안 반복 0 · r 한 칸 이상 넓어짐 |
| D8 | P5 다시 넣기 | 6~10세션 자격 세션 중 다시 넣기 ≥ 50% |
| D9 | P9 이탈·길이 | 6~10세션 도착 곡 ≤ 이탈 지점 ≥ 80% · 6세션 안에 제안 시간 ≤ 25분 ≥ 80% |
| D10 | P10 시작점 | 10세션 안에 s > 0 반복 ≥ 50% · 6~10세션 첫 곡 조기 넘김 ≤ 0.8 × twin |
| D11 | P12 미리듣기 | 소프트 게이트 오작동 0 · 취향 표 크기가 같은 행동의 전체 재생 대비 절반 |

### E. 결과 개선 (합성 사용자, 6~10세션, P1–P10 합산, wp vs twin 쌍 비교)

| ID | 지표 | 합격 |
|---|---|---|
| E1 | 경로 곡 조기 넘김률 | wp ≤ 0.85 × twin, 차이의 95% 구간 전체 < 0 |
| E2 | 좋아요율 | wp ≥ 1.2 × twin, 구간 > 0 |
| E3 | 평균 완주율 | wp ≥ twin + 0.03 |
| E4 | 잠재 청취 후 변화 `E[change]` | wp ≥ twin + 0.15, 구간 > 0 |
| E5 | 학습 몫(wp vs frozen) | 조기 넘김 wp ≤ 0.9 × frozen |
| E6 | 세션에 따른 개선 | wp 조기 넘김(6~10) ≤ 0.9 × wp(1~2) · twin 은 같은 비율 ≥ 0.95(거의 안 배움 — 비교 타당성 확인) |
| E7 | 대조군(P0·P11) | 좋아요·넘김 차이 \|Δ\| ≤ 0.03 이거나 wp 가 나음 · `E[change]` 차이 구간 하한 ≥ −0.10 |

### F. 거짓 학습·교차 오염

| ID | 기준 | 합격 |
|---|---|---|
| F1 | P0·P11, 6~10세션 | \|π\| ≤ 0.3 · \|δ\| ≤ 0.02 · 적용 배수 = 1(또는 [0.8, 1.25]) · s = 0 · 소프트 게이트 꺼짐 · r = P0 · 창 60 · 상한 2 — 모두 만족하는 세션 ≥ 80% |
| F2 | 전환 민감도 없는 P1·P3·P5 | 적용 배수 = 1 또는 [0.8, 1.25] 인 세션 ≥ 80% |
| F3 | 취향 없는 P6 | 취향 묶음 점수 이동 ≤ 0.03(P0 대비) |
| F4 | q 대조 실험(P3) | q 없이 적합 → 배수 부풂 보고, q 포함 → F2 만족 |
| F5 | 경로 모수 | 취향만 있는 페르소나(P1 의 취향 부분, P3, P5)에서 s·r·길이 제안이 P0 값 100% |

### G. 고긴장 (P8, 100%)

자동 tp ≥ at_def · 발견 칸 0 · r ≤ 0.035 · s ≤ 0.075 · 적용 배수 ≥ 1. 사용자가 '빠르게'를 직접 누른 세션만 예외(선언 우선).

### H. 결정성·재현·성능

| ID | 기준 | 합격 |
|---|---|---|
| H1 | 같은 입력 100회 | 모델 digest·정책 digest·시퀀스 100% 동일 |
| H2 | Node vs 브라우저(개발 페이지 `?fixture=<name>` 가 digest 출력) 픽스처 20개 | 100% 동일 (P1) |
| H3 | `replay.mjs` 로 시뮬레이터가 남긴 추천 문서 재현 | 100%(카탈로그 digest 일치 시) |
| H4 | 설명 충실도: `p_smooth = true` 행을 `adj_w = 0` 으로 다시 돌렸을 때 그 걸음 곡 또는 경로가 바뀜 | ≥ 90% |
| H5 | 성능(노트북 Node) | 모델 빌드 ≤ 50ms(추천 100·이벤트 1,200) · `resolvePolicy` ≤ 5ms · 개인 실행 중앙 ≤ 150ms · 버튼→결과(A+R+extras) ≤ 400ms |

### I. 데이터 안전 (`tools/sim/check.mjs`, 매 병합 전)

새 컬렉션 이름 0 · index.html 의 모든 Firestore 쓰기가 `fsWrite` 안(계정 삭제 batch 만 예외) · `song_stats` 키 ⊆ 기존 7개 ·
`engine/*.js` 에 `Math.random`·`Date.now` 0 · `rules_hash` 일치 · `trace_keys` ⊇ 엔진이 내는 `p_*` 키 · `sw.js` VERSION ≠ `azt-v9` ·
`personalization` 절 JSON 이 §10 키를 모두 가짐 · 로컬 서버 기본 실행과 데모 모드에서 Firestore 쓰기 호출 0(개발 페이지 카운터).

### J. 앱 수동 점검 (P0, 배포 전)

곡 8개 재생 중 다음·이전·점프·탭 닫기·새 추천을 섞어도 곡 재생 1회당 `track_exit` 정확히 1건(콘솔 표) · 비교 토글이 R 경로를 점선으로 그리고 바뀐 곡 수가 로그 `changed_n` 과 같음 ·
개인화 끄기 → 다음 추천 `personal_policy: null` · 익명 → `personal_policy: null` · 375px 모바일 폭에서 점 끌기 동작 · 패널 카드가 빈 모델에서 모두 "기본값" ·
`?personal=0` 동작 · 서비스워커가 localhost 에서 등록되지 않음.

---

## 12. 작업 순서 · 팀 결정 · 위험

### 12.1 작업 순서 (9/27 → 10/3 시연)

| 날 | ENGINE | APP | TOOLS |
|---|---|---|---|
| D0 9/27–28 | 이 명세의 인터페이스 동결 · `personal.js` 스텁 · 규칙 `personalization` 뼈대 + `rules_hash --write` · 엔진 훅을 P 무시 상태로(**A1 녹색**) | `env.js` · `fsWrite` · 동기 rec id · `closeExposure`/`track_exit` · like `on` · 시퀀스 위치 · 끌기 | `server.mjs` · `.gitignore` · `catalog.mjs`·`app_tables.mjs`·`baseline.mjs`·`grids.mjs`·`regress.mjs`(A1~A4) |
| D1 9/29 | P 모드 훅(§6.6): 결합 제한·코리도어·전환 비용·머묾 r·순서·속도·상한 키·최근·extras · `sanitizePersonal` · `normalizeLogs`·청취 표·μ·속도 | 로그 필드(§7.1)·「듣고 난 뒤」 속도 답·길이 방향·`touched` · 모델 읽기/빌드 · 추천 A/R + 안전 확인 배선(스텁→실제) · extras 큐 | `personas.mjs`·`behavior.mjs`·`fixweb_twin.mjs`·`run.mjs` 1차 · A3(I1) |
| D2 9/30 | 전환 학습기 · 좌표 보정 · 시작점 · 머묾 규칙 · 게이트·다양성 · `explainPolicy`·`explainModel` · `buildRecLog` | 비교 토글 · 반영된 나 칩 · 내 취향 모델 패널 · 보정 고리·안내 · 소프트 게이트 칩 · 속도 안내 · 시간 제안 | `sweep.mjs`(scale·fold·순서) → B·C 측정 · `check.mjs` |
| D3 10/1 | 스윕 결과로 기본값·근거 문자열 확정 · 버그 수정 | 데모 모드 · 모바일 점검 | `run.mjs` 전체(D·E·F·G·H) → `docs/personal_eval_20261001.md` · `demo_personas.mjs` |
| D4 10/2 | `change.md`(§13) · 최종 `rules_hash` | 별도 Vercel 프로젝트 배포 · Firebase 승인 도메인 추가(D10) | 최종 보고서 · 포스터 그림(합성 사용자 표기) |
| 10/3 | 시연 | 시연 | 시연 |

**병합 순서**: ① 규칙 + P 무시 엔진(A1 녹색) → ② `personal.js` + 단위 시험 → ③ 앱 배선(`?personal=1` 뒤에 숨김) → ④ 스윕으로 기본값 확정 → ⑤ 수용 실행 통과 후 기본 켬.
P0 가 끝나기 전에는 P1 을 시작하지 않는다.

### 12.2 팀 결정 (change.md 에 기록할 것)

| ID | 결정 |
|---|---|
| D1 | 세션 `misfit_reasons`·`note_ai.positions` 를 web-personal 의 개인 경로 학습에 쓴다(7차 "집계 전용"을 이 앱에서만 뒤집음) |
| D2 | 시작 오프셋 s 최대 0.15(고긴장 0.075), 기본 0 — 음악중재 자문 사안 |
| D3 | `preferred_genres` 는 취향 증거가 아니다(두 앱의 세션 저장으로 오염). web-personal 은 추천 때 저장하지 않는다 |
| D4 | 더 들을 곡을 재생 큐에 넣는다 |
| D5 | 고긴장(stress ≥ 3) 안전 집합: 발견 없음 · 자동 속도 가속 없음 · r ≤ 0.035 · s ≤ 0.075 · 전환 배수 ≥ 1 |
| D6 | 곡 수 ≥ 5 이면 신규 사용자부터 머묾 반경 0.035 + 마지막 곡 고정 진행 방향 순(도착 오차 중앙 0.007 → 약 0.02 를 받아들임) |
| D7 | 기본 전환 비용(빠르기·보컬 전환·말 비중·장르)은 λ 와 같은 전환 비용 — 가중은 스윕으로 확정 |
| D8 | 9/20 청취 시간 규칙을 그대로 채택(30%↓ −¼ 는 실제 넘김일 때만, 30~70% 0, 70%↑ +¼), 미리듣기 ½, 곡당 암묵 표 합 1 |
| D9 | μ = 0.5·E/(E+8) + 결합 제한(규칙의 전역 μ 스윕 대신) |
| D10 | web-personal 은 공유 Firestore 에 쓴다(표시 달린 로그, `wp_personal_v1` 한 필드, `track_milestone` 끔, `song_stats` 는 켤 때만). 별도 Vercel 프로젝트 + Firebase 승인 도메인 추가 |
| D11 | 좌표 보정은 사용자 본인이 끈 만큼만(보이고 되돌릴 수 있음). 목표를 자동으로 옮기지 않는다 |
| D12 | `post_change.change` 는 학습에 쓰지 않고 평가에만 쓴다 |
| D13 | 익명 사용자에게 모집단 기본 정책(P0)을 줄지 — 기본 아니오(`p0_for_anonymous: false`) |

### 12.3 위험

| 위험 | 대응 |
|---|---|
| 캡스톤 규모 데이터에서는 대부분의 학습기가 사전값에 머문다 | 설계 의도(축소·문턱). 시연은 모집단 개선(P0) + 비교 토글 + 데모 페르소나로 보여 준다. 시뮬레이터는 **기제**를 증명할 뿐 실제 효과가 아니다(5단계에서 실제 로그로 잰다) |
| 공유 Firestore — 운영 앱의 400건 창·users 문서 | `track_milestone`·전환 추적 끔, 곡당 1건, `wp_personal_v1` ≤ 64KB, 추천 때 선호 필드 저장 중단, `fsWrite` 허용 목록 |
| 배포된 보안규칙이 저장소와 다를 수 있음(`listeningHistory`, 새 이벤트 type) | D0 에 콘솔 확인. 설계는 `listeningHistory` 에 의존하지 않음. 새 type 이 막히면 `track_exit` 를 기존 type 의 payload 로 싣는 대안 준비 |
| 추천당 엔진 2~3회 | 약 160~240ms. 느린 폰에서 문제면 R 을 `requestIdleCallback` 으로 미뤄 비교 토글 열 때 계산(안전 확인은 A 의 절대 기준만으로) |
| 취향 기대 거절률 θ 가 사전값 | 실제 web-personal 로그 200 전환이 모이면 TOOLS 가 모집단 적합으로 θ 재추정 → 규칙 근거 갱신 |
| 곡별 청취·좋아요 개인화는 다른 팀원 담당 파트와 겹친다 | web-personal 은 별도 앱(실험)으로 두고, 규칙 값은 9/20 합의를 그대로 따른다. 담당 팀원과 D8·D9 를 확인 |
| Python 검증기(engine.py) 부재 | JS 만 기준. 로그에 정규화 정책 + `user_affinity` 가 있어 JS 로 재현 가능(H3) |

---

## 13. 변경 요약 (change.md 용)

> 아래 블록을 구현이 끝난 뒤 `change.md` 끝에 붙인다. `〈…〉` 는 실행 결과로 채운다.

```markdown
# web-personal 1차 (2026-09-27 명세 → 〈완료일〉 구현) — 플레이리스트를 만드는 모든 절차를 개인화

**왜** — fix-web(엔진 2.5.1)에서 개인화는 곡 취향 한 레인뿐이고 그마저 μ=0 이라 거의 작동하지 않았다(연주곡을 좋아해도 연주곡 0%, 벽 가수 0%).
경유지는 사람과 무관하게 100% 같았고, 인접 곡은 V/A 거리로만 이어져 빠르기 차가 무작위와 비슷했다(중앙 28.3 vs 29.7 BPM).
목표에 도착한 뒤에는 목표 칩마다 같은 곡으로 끝났다(100%). web-personal 은 fix-web 을 복제한 별도 앱으로,
로그인 사용자의 기록으로 입력 해석·목표 해석·도착 시점·시작점·감상 시간·머묾 구간·곡 취향·곡 사이 연결·게이트·다양성·더 들을 곡·완화 순서를 조정한다.

**지키는 것**
- `inputs.personal` 이 없으면 엔진 출력은 2.5.1 과 같다 — 회귀 〈1,224/1,224〉 · 〈660/660〉 · 탐침 〈15/15〉 동일.
- 개인 비용은 걸음마다 취향+전환을 묶어 ±1.5 밴드(머묾 ±0.0125)로 자르고, 가점은 최선 밴드+1(머묾: 반경) 안에서만 — 개인화가 기하를 넘지 못한다.
- 목표 좌표는 자동으로 옮기지 않는다. 좌표 보정은 본인이 끈 만큼만, 화면에 보이고 되돌릴 수 있다.
- 고긴장(불안·짜증·답답·걱정 칩 등)이면 탐색·가속 없음, 반경·시작점 상한.
- 싫어요는 이유와 무관하게 후보 제외.

**바뀐 것**

| # | 파일 | 내용 | 추천 영향 |
|---|---|---|---|
| 30 | engine.js 2.6.0-wp | `inputs.personal`(PersonalPolicy)·`inputs.pace` 소비, 결합 제한·코리도어, 인접 전환 비용(빠르기·보컬 전환·말 비중·장르), 머묾 반경 + 마지막 곡 고정 순서, 속도·시작점·이탈 가드, 가수 상한 키 단위, 기기 무관 최근 창, 좋아요 곡 다시 넣기, 새 가수 발견 칸, 소프트 말 많은 곡 게이트, `recommendExtras` | 회원만 |
| 31 | engine/personal.js (새) | 로그 정규화 → 개인 모델 → 정책. 청취 표(9/20 합의), μ=0.5·E/(E+8), 속도 π(버튼·속도 답), 좌표 보정(끌기), 전환 배수(취향 오프셋 결합 모형), 반경·창·상한·게이트 규칙, 설명 | 회원만 |
| 32 | rules v2.5.0-wp | `personalization` 절(모든 새 숫자 + 근거), 설명 4개, trace 키. 기존 절 값 불변 | 없음(P 없음) |
| 33 | index.html | `track_exit`(곡 재생 1회 1건), 동기 추천 ID, like `on`, 시퀀스 위치, 「듣고 난 뒤」 속도 답·길이 방향·`touched`, 점 끌기, 비교 토글, 내 취향 모델 패널, 개인화 끄기, 더 들을 곡 재생 큐, `fsWrite` | UI·로그 |
| 34 | server.mjs · tools/sim | 로컬 서버(쓰기 기본 끔), 카탈로그 로더(git show), 회귀·시뮬레이터·스윕·재현·정적 검사 | — |
| 35 | sw.js · pwa.js | `azt-personal-v1`, localhost 에서 등록 안 함 | — |

**고친 버그** B1–B30(명세 §8): 도착·길이 싫어요가 취향 싫어요로 셈 · 세션 장르가 좋아요로 셈 · 스킵 정의 · 청취 규칙이 합의와 다름 ·
토글이 통계에 +1 · 추천 ID null · 완주 곡 이중 저장 · 새 추천·탭 닫힘에 청취 유실 · 백그라운드 청취 과소 · 큐 위치와 시퀀스 위치 혼동 ·
자연어 조건 로그 오류 · 익명 users 문서 생성 · 더 들을 곡의 가사 조건 누락 · 가수 상한이 협업 표기 통째 기준 · rules_hash 불일치 등.

**검증 (합성 사용자 — 실제 효과는 5단계에서)**
- ISO 봉투(1,224세션, 신규 사용자 기본 정책): 도착 오차 중앙/90% 〈 〉(2.5.1 0.007/0.035) · 꺾임 〈 〉(6.5%) · 지그재그 〈0%〉 · 같은 곡으로 끝남 〈 〉(100%)
- 인접 구성(660회): BPM 차 중앙 〈 〉(28.3) · 보컬↔연주 〈 〉(11.3%) · 2개 이상 어긋남 〈 〉(36.6%)
- 결과(페르소나 14 × 10세션 × 5반복, 6~10세션, fix-web 재현 대비): 조기 넘김 〈 〉 · 좋아요 〈 〉 · 청취 후 변화 〈 〉
- 결정성 100/100 · 재현 〈 〉% · 성능 〈 〉ms

**팀 결정** D1–D13(명세 §12.2).

`rules_hash`: 파일 `7a9dc8823c84`(내용과 불일치, 계산값 `f5f8ca824e6b`) → 〈새 값〉 · `algorithm_version` = `v2.5.0-wp+〈hash〉+e2.6.0-wp+p1.0.0` · 서비스워커 `azt-personal-v1` · 엔진 캐시 `?v=300`
```

