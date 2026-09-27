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
 * env 를 local 로, 쓰기·서비스워커를 끈다(로컬 실행은 기본 쓰기 끔 — I9). */
(function () {
  var cfg = { app: "web-personal", env: "prod", writes: true, sw: true, personal: true, debug: false };
  var h = location.hostname;
  var local = location.protocol === "file:" || h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
    || /\.localhost$/.test(h) || /\.test$/.test(h);
  if (local) { cfg.env = "local"; cfg.writes = false; cfg.sw = false; }
  window.AZT_ENV = Object.assign(cfg, window.AZT_ENV || {});
})();
