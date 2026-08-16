# 배포본 수정 내역 (2026-08-16)

업로드해 주신 배포본 `index.html` 을 검사해서 3건을 고쳤습니다.
**1번이 가장 중요합니다 — 파이프라인 작업이 사용자에게 도달하지 않고 있었습니다.**

---

## 1. 🔴 앱이 v2 좌표를 안 읽고 있었음

```js
// 이전 — provider 원본만 읽음
const nv = normScale(pr.valence), ne = normScale(pr.energy);
```

`v2_valence` 를 읽는 코드가 **파일 전체에 0곳**이었습니다.

즉 그동안의 V축 작업이 전부 앱에 반영되지 않았습니다:

- 골드셋 249곡 (쌍비교 964건 + DEAM 앵커 절대척도 정렬)
- 가사 결합 96곡 (L2 식)
- 수작업 태깅 32곡
- 골드셋 척도정렬 · 정밀도 가중 결합 · 계단 보정 · 퍼센타일 정규화

사용자는 계속 **provider 원본 valence** 로 추천받고 있었습니다. 한국 곡 상관 0.323짜리 값입니다.

인수인계 문서에 적혀 있던 *"앱이 데이터팀 스펙 대신 하드코딩을 써서, 축을 바꿔도 사용자에게
도달하지 않는다"* 는 우려가 실제로 벌어져 있던 상태였습니다.

**수정:** `v2_valence` / `v2_arousal` 우선, 없는 곡만 `provider_raw` 폴백.
콘솔과 상태 문구에 **v2 좌표 커버리지 %** 를 찍습니다 — 배포 후 이 숫자를 꼭 확인하세요.
100% 가 아니면 그만큼의 곡이 아직 provider 값으로 추천되고 있다는 뜻입니다.

`va_source` 와 `popularity` 도 엔진에 전달하도록 추가했습니다. 규칙의 신뢰도 동점 정렬에
실제 필드값(`golden_set_calibrated` 등)을 반영해 사람이 검증한 곡이 먼저 나옵니다.

## 2. 태그 6종 → 3종 전환

`calmness` · `*_suitability` · `lyric_distraction` · `instrumental_probability`
→ `vocal_load` · `groove` · `tonality`

곡 로딩에서 `v2_tags` 를 우선 읽고, 가사 선호 필터를 `vocal_load` 방향으로 반전했습니다
(vocal_load 는 높을수록 목소리 비중이 크므로 기존 `instrumental_probability` 와 반대 방향).

태그는 v2.1 엔진에서 **점수가 아니라 게이트로만** 쓰이므로 이 교체가 추천 순위를 직접 흔들지는
않습니다. 표시용 라벨과 가사 필터만 영향받습니다.

## 3. 조용한 실패 수정

엔진 로드가 실패하면 에러 메시지를 써놓고 화면 전환을 안 해서, **버튼을 눌러도 아무 일도
안 일어나는 것처럼** 보였습니다. 이제 화면이 넘어가고 실패 원인까지 표시합니다.

---

## 배포 시 확인할 것

```
[AZT] 엔진 로드 v2.1.0+3347a588511c
[AZT] V/A 소스 — v2 파이프라인 ____곡 / provider 폴백 ____곡 (___%)
```

브라우저 콘솔에서 이 두 줄을 확인하세요. 두 번째 줄의 비율이 이번 수정의 실제 효과입니다.

---

# 2차 수정 (같은 날, 후속 배포)

## 4. 🔴 R6 시간 감쇠가 구현돼 있는데 작동하지 않았음

`engine.js` 는 `0.5^(last_days / half_life_days)` 로 반감기를 정확히 계산합니다.
그런데 `index.html` 이 넘기는 `last_days` 가 **전부 `0`** 이었습니다:

```js
song_feedback[id] = { ...splitSignal(...), last_days: 0 };
for (const id of LIKED_SONGS)    song_feedback[id] = { pos: 3, neg: 0, last_days: 0 };
for (const id of PLAYLIST_SONGS) song_feedback[id] = ... || { pos: 2, neg: 0, last_days: 0 };
```

`0.5^(0/14) = 1` 이므로 **모든 피드백이 항상 "오늘 것"** 이었고, 반감기 14일이 사실상
무한대였습니다. 규칙 파일에는 있고 엔진도 구현했는데 앱이 입력을 안 채워서 죽어 있던
상태입니다. R6 를 "적용됨"으로 보고하면 안 되는 상태였습니다.

**수정:**
- `context_events` 의 `created_at` 으로 곡별 경과일 계산
- 엔진이 곡당 감쇠계수를 하나만 받으므로 **기여도(|v|) 가중 평균 경과일**을 넘김
  (최신 1건만 쓰면 오래된 누적이 안 늙고, 단순평균은 큰 신호를 과소평가)
- 좋아요·벽 붙이기는 `users` 문서에 시각이 없으므로 이벤트 로그에서 최근 시각을 회수
- `song_stats`(전체 집계)는 시각 필드 자체가 없어 감쇠 없이 유지 — 시간축이 필요하면
  `song_stats` 에 최근 갱신 시각을 추가해야 함

**검증** (합성 카탈로그 120곡, 30곡에 좋아요):

```
last_days=0   → 좋아한 곡이 시퀀스에 4/5곡
last_days=140 → 좋아한 곡이 시퀀스에 0/5곡
```

## 5. full / preview 구분 로깅 추가

Spotify iFrame 은 로그인 상태에 따라 전곡 또는 30초 미리듣기를 줍니다(모바일은 항상 30초).
같은 `track_complete` 가 preview 에서는 "30초 완주", full 에서는 "4분 완주"를 뜻하는데
구분 없이 쌓이고 있었습니다. **모바일=preview 가 100% 겹쳐 기기와 노출량이 완전히
교락되므로, 미니 실험에서 "알고리즘 효과"와 "노출 시간 효과"를 분리할 수 없었습니다.**

**판정은 추정이 아니라 관측:** embed 가 실제로 준 재생 길이를 카탈로그 원곡 길이와 비교합니다.
`duration <= 30000` 같은 절대값 비교는 30초 미만 짧은 곡을 오판하므로 쓰지 않습니다.

```
available_ms < catalog_ms * 0.9  →  preview
그 외                            →  full
카탈로그 길이 없음 / 재생 전      →  unknown
```

**추가된 필드**

| 위치 | 필드 |
|---|---|
| `context_events` 신규 이벤트 `playback_mode` | `playback_mode` · `available_ms` · `catalog_ms` |
| `track_complete` | `playback_mode` · `available_ms` · `catalog_ms` (기존 `completion_rate` 는 이미 비율) |
| `track_milestone` | `playback_mode` |
| `post_change` · `after_unlock` · `sequence_complete` | `playback_mode_session` (`full`/`preview`/`mixed`/`unknown`) |
| `users/{uid}/listeningHistory` | `playbackMode` · `catalogSeconds` |
| `song_stats` | `completes_full` · `completes_preview` · `sum_completion` · `n_completion` |

마지막 줄이 **R4(통계 비율화)** 의 입력입니다. preview 30초 완주와 full 4분 완주가
`completes` 로는 똑같이 +1 이라, 비율 없이는 두 모집단이 섞입니다.

## 6. 문서 숫자 정정 — V–A 상관

기존 "V–A 상관 −0.564" 는 실제 배포 카탈로그에서 재현되지 않습니다.
`data/processed/music_catalog_v2_20260816.csv` (2,398곡) 직접 계산:

| | 실측 |
|---|---|
| step δ=0.20 (현재 채택) | **r(V, A) = +0.486** |
| linear λ=0.5 (직전) | r(V, A) = +0.435 |

부호가 반대입니다. V 와 A 는 원래 **양의 상관**(config 의 λ=0 기록: +0.739)이고,
각성 보정은 그 양의 상관을 깎으려고 존재합니다. 발표 자료의 −0.564 / −0.027 은
`build_v2_catalog.py` 가 실행할 때 찍는 `r(V,A) 보정전 → 보정후` 출력으로 교체하세요.

---

## 남은 것

- **계단 보정** — `CONFLICT_계단보정.md` 참고. **팀 결정 필요 — 이번 배포에 포함 안 됨.**
  경계 A∈[0.45,0.55] 373곡에서 위/아래 V 평균차가 step 은 −0.147, linear 는 +0.008.
  독립 37곡 검증은 provider 기준선 0.443 / step 0.399 / linear 0.373 로 **셋 다 구분 불가**
  (n=37, SE≈0.17). 사람 판단으로는 못 고르므로 경계 연속성·사분면 균형으로 고르는 것이 타당.
  linear 의 유일한 약점(β가 표본마다 흔들림)은 계수를 고정하면 사라짐.
- **모바일 전곡 재생** — 정책상 막힘 (로깅은 위 5번으로 해결)
- **좌표계** — 골드셋 906건으로는 판정 불가 (밝기 순서만 묻는 데이터라 퍼센타일에도 판정 동일).
  `post_change` 로그로 판정하는 것이 현실적
- **band=0.16 · step_limit_scale=1.8** — 합성 카탈로그 120곡 기준. 실카탈로그 2,398곡에서
  `variety_check.py` · `ablate.py` 로 재측정 필요
