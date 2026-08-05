# 음치치 데모 웹앱 (eumchichi-web)

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
