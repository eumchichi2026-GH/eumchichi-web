# 음치치 데모 웹앱 (eumchichi-web) — 구버전 v1

> **2026-10-01 — 구버전입니다.** 이 폴더는 예전 저장소 루트 앱(설문 배포판)으로, 주소 **https://eumchichi-web.vercel.app/v1/** 에서 돕니다.
> 기본 앱은 저장소 루트의 web2(ver2) → https://eumchichi-web.vercel.app/ ([루트 README](../README.md)).
> 옮기면서 바꾼 것은 `/v1/` 아래에서 돌기 위한 주소 네 곳뿐입니다: `index.html` 첫 줄(슬래시 없는 `/v1` 보정) · `pwa.js`(상대 `sw.js` 등록) ·
> `sw.js`(자기 위치 기준 경로, 캐시 `azt-v1-legacy-*`) · `manifest.webmanifest`(`id` `/v1/`, 상대 주소, 이름 "AZT 구버전(v1)").
> 아래 본문은 옮기기 전 기록입니다(`api/` 는 저장소 루트에 그대로 있습니다).

음악을 통한 대학생 맞춤형 스트레스 관리 시스템 — 배포용 데모.

## 구조

- `index.html` — 데모 전체 (Firebase Auth/Firestore + 추천 + Spotify 연속재생)
- `api/gemini.js` — Gemini 중계 서버리스 함수. **API 키는 이 저장소에 없고
  Vercel 환경변수 `GEMINI_API_KEY` 에만 존재한다.**

## 배포 (Vercel)

1. 이 저장소를 Vercel에 Import
2. Settings → Environment Variables 에 `GEMINI_API_KEY` 등록
3. 배포 도메인을 Firebase 콘솔 → Authentication → 승인된 도메인에 추가

`master`(또는 `main`)에 push 하면 자동으로 재배포된다.

## 보안 메모

- Firebase 설정값(apiKey 등)은 공개되어도 되는 값 — 실제 접근 제어는
  Firestore 보안규칙 + Authentication 이 담당
- Gemini 키는 서버에만 존재. 프록시는 허용 action 2개, 서버 고정 프롬프트,
  입력 길이 제한으로 도용을 방지
