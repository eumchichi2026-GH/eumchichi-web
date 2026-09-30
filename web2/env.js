/* web-personal 실행 설정 (배포용 고정값 · 명세 §9.3·§7.5)
 * index.html 이 앱 스크립트보다 먼저 읽는다. 로컬 서버(node server.mjs)는 같은 주소(/env.js)로
 * { env:"local", writes:false(기본), sw:false } 를 직접 돌려주므로 이 파일은 배포(Vercel)에서만 쓰인다.
 *   app       로그·문서에 붙는 앱 표시("web-personal")
 *   env       prod | local | demo — 추천 문서·이벤트의 env 필드
 *   writes    false 면 Firestore 를 부르지 않는다(fsWrite 가 console.info + 메모리 SESSION_LOG 에만 남김)
 *   sw        false 면 서비스워커를 등록하지 않고 예전 등록을 해제한다(pwa.js)
 *   personal  false 면 개인화를 끈다(?personal=1 로만 켬 — 단계 공개용). 규칙 스위치·?personal=0·사용자 끄기는 따로 있다
 *   debug     true 면 track_milestone·전환 추적 이벤트도 쓰고, 콘솔에 모델 빌드 시간을 찍는다
 * 안전장치: 이 정적 파일이 로컬 주소(다른 정적 서버로 연 경우 등)에서 그대로 서빙되면 운영 Firestore 에 쓰지 않도록
 * env 를 local 로, 쓰기·서비스워커를 끈다(로컬 실행은 기본 쓰기 끔 — I9).
 * [web2 2026-09-30] 두 번째 안전장치(하위 경로): 이 앱은 도메인 루트에서만 운영값으로 돈다(별도 Vercel 프로젝트, Root Directory = web2).
 * web 저장소 루트를 배포하는 기존 web 프로젝트에 이 폴더가 딸려 올라가 /web2/ 같은 하위 경로로 열리면
 * API·서비스워커 주소(/api/…, /sw.js)가 web 의 것이라, 쓰기·서비스워커를 끄고 읽기 전용 미리보기로만 돈다(subpath:true).
 * 이때 pwa.js 는 로컬 주소가 아니므로 web 의 서비스워커 등록을 건드리지 않는다. */
(function () {
  var cfg = { app: "web-personal", env: "prod", writes: true, sw: true, personal: true, debug: false };
  var h = location.hostname;
  var local = location.protocol === "file:" || h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
    || /\.localhost$/.test(h) || /\.test$/.test(h);
  if (local) { cfg.env = "local"; cfg.writes = false; cfg.sw = false; }
  else if (!/^\/(?:index\.html?)?$/.test(location.pathname)) {
    cfg.writes = false; cfg.sw = false; cfg.subpath = true;
    if (window.console) console.warn("[AZT] web-personal 이 하위 경로(" + location.pathname + ")에서 열렸어요 — 읽기 전용 미리보기(Firestore 쓰기·서비스워커 끔). 운영은 Root Directory = web2 인 별도 배포에서만.");
  }
  window.AZT_ENV = Object.assign(cfg, window.AZT_ENV || {});
})();
