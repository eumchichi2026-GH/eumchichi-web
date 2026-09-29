/* web-personal 로컬 실행용 Firebase 대역 (APP · 명세 §9.3 · §11 H2·I — 2026-09-30)
 *
 * server.mjs 가 /env.js 로 { offline: true } 를 주면(로컬 기본 실행) 앱이 운영 Firebase 에 로그인·읽기·쓰기를 하지 않도록
 * window.firebase 를 이 대역으로 바꾼다. 배포(env.js 정적 파일)와 다른 정적 서버로 연 로컬에서는 offline 이 없어 아무것도 하지 않는다.
 *   · 곡 목록: 앱 init() 이 Firestore 대신 server.mjs 의 /api/local-catalog 에서 받는다(데이터 저장소를 git show 로 읽은 계약 곡 —
 *     시뮬레이터 tools/sim/catalog.mjs 와 같은 값이라 개발 픽스처(?fixture=)의 digest 를 Node 와 그대로 비교할 수 있다).
 *   · 로그인: 익명 로그인은 이 탭 안의 가짜 익명 사용자(uid "local-anon") — 네트워크를 쓰지 않는다. 이메일·구글 로그인은 거절한다
 *     (로컬 기본 실행은 계정을 만들지 않는다). 운영 Firebase 로 확인하려면 `node server.mjs --firebase`.
 *   · 읽기: 모든 컬렉션·문서가 빈 결과.
 *   · 쓰기: 모두 거절하고 AZT_LOCAL_FIREBASE.counts.blocked 에 센다. 앱의 fsWrite 는 로컬에서 writes:false 라 여기까지 오지 않는다(이중 방어).
 * 이 파일은 숫자를 만들지 않는다(추천·학습과 무관 — 실행 환경 대역).
 */
(function () {
  var env = window.AZT_ENV || {};
  if (env.offline !== true) return;

  var counts = { blocked: 0, reads: 0, auth_refused: 0 };
  var refuse = function (what) {
    counts.blocked++;
    console.info("[AZT][로컬 Firebase 대역] 쓰기 거절:", what);
    var e = new Error("로컬 실행(offline)에서는 Firestore 에 쓰지 않아요: " + what);
    e.code = "permission-denied";
    return Promise.reject(e);
  };
  var authRefuse = function (what) {
    counts.auth_refused++;
    var e = new Error("로컬 실행(offline)에서는 로그인하지 않아요 — 운영 Firebase 는 node server.mjs --firebase: " + what);
    e.code = "auth/operation-not-allowed";
    return Promise.reject(e);
  };
  var emptySnap = function () { return { empty: true, size: 0, docs: [], forEach: function () {} }; };
  var ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var autoId = function () {
    var a = new Uint8Array(20), s = "";
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ID_CHARS.charAt(a[i] % ID_CHARS.length);
    return s;
  };

  function DocRef(path, id) {
    this.id = id || autoId();
    this.path = path + "/" + this.id;
  }
  DocRef.prototype.get = function () {
    counts.reads++;
    var id = this.id;
    return Promise.resolve({ exists: false, id: id, data: function () { return undefined; }, get: function () { return undefined; } });
  };
  DocRef.prototype.set = function () { return refuse(this.path + " set"); };
  DocRef.prototype.update = function () { return refuse(this.path + " update"); };
  DocRef.prototype["delete"] = function () { return refuse(this.path + " delete"); };
  DocRef.prototype.collection = function (name) { return new ColRef(this.path + "/" + name); };
  DocRef.prototype.onSnapshot = function (cb) { if (typeof cb === "function") setTimeout(function () { cb({ exists: false, data: function () { return undefined; } }); }, 0); return function () {}; };

  function ColRef(path) { this.path = path; this.id = String(path).split("/").pop(); }
  ColRef.prototype.doc = function (id) { return new DocRef(this.path, id); };
  ColRef.prototype.add = function () { return refuse(this.path + " add"); };
  ["where", "orderBy", "limit", "limitToLast", "startAfter", "startAt", "endBefore", "endAt"].forEach(function (k) {
    ColRef.prototype[k] = function () { return this; };
  });
  ColRef.prototype.get = function () { counts.reads++; return Promise.resolve(emptySnap()); };
  ColRef.prototype.onSnapshot = function (cb) { if (typeof cb === "function") setTimeout(function () { cb(emptySnap()); }, 0); return function () {}; };

  function FieldValue(kind, arg) { this._local = kind; this._arg = arg; }
  FieldValue.serverTimestamp = function () { return new FieldValue("serverTimestamp"); };
  FieldValue.increment = function (n) { return new FieldValue("increment", n); };
  FieldValue.arrayUnion = function () { return new FieldValue("arrayUnion", Array.prototype.slice.call(arguments)); };
  FieldValue.arrayRemove = function () { return new FieldValue("arrayRemove", Array.prototype.slice.call(arguments)); };
  FieldValue["delete"] = function () { return new FieldValue("delete"); };

  var db = {
    collection: function (name) { return new ColRef(name); },
    batch: function () {
      var n = 0;
      var b = { set: function () { n++; return b; }, update: function () { n++; return b; }, "delete": function () { n++; return b; },
                commit: function () { return refuse("batch(" + n + ")"); } };
      return b;
    },
  };
  var firestore = function () { return db; };
  firestore.FieldValue = FieldValue;
  firestore.Timestamp = { now: function () { var ms = Date.now(); return { toMillis: function () { return ms; } }; },
                          fromMillis: function (ms) { return { toMillis: function () { return ms; } }; } };

  var user = null, listeners = [];
  var notify = function () { listeners.slice().forEach(function (cb) { try { cb(user); } catch (e) { console.warn(e); } }); };
  var makeUser = function () {
    return {
      uid: "local-anon", isAnonymous: true, displayName: null, email: null, providerData: [],
      getIdToken: function () { return Promise.resolve(""); },
      linkWithCredential: function () { return authRefuse("linkWithCredential"); },
      linkWithPopup: function () { return authRefuse("linkWithPopup"); },
      linkWithRedirect: function () { return authRefuse("linkWithRedirect"); },
      "delete": function () { return authRefuse("user.delete"); },
    };
  };
  var authObj = {
    get currentUser() { return user; },
    getRedirectResult: function () { return Promise.resolve({ user: null, credential: null }); },
    onAuthStateChanged: function (cb) {
      listeners.push(cb);
      setTimeout(function () { if (listeners.indexOf(cb) >= 0) cb(user); }, 0);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    signInAnonymously: function () { user = makeUser(); setTimeout(notify, 0); return Promise.resolve({ user: user }); },
    signOut: function () { user = null; setTimeout(notify, 0); return Promise.resolve(); },
    signInWithCredential: function () { return authRefuse("signInWithCredential"); },
    signInWithEmailAndPassword: function () { return authRefuse("signInWithEmailAndPassword"); },
    createUserWithEmailAndPassword: function () { return authRefuse("createUserWithEmailAndPassword"); },
    signInWithPopup: function () { return authRefuse("signInWithPopup"); },
    signInWithRedirect: function () { return authRefuse("signInWithRedirect"); },
  };
  var auth = function () { return authObj; };
  auth.EmailAuthProvider = { credential: function () { return null; } };
  auth.GoogleAuthProvider = function () { this.addScope = function () {}; this.setCustomParameters = function () {}; };

  window.firebase = {
    apps: [],
    initializeApp: function (cfg) { var app = { name: "[local]", options: cfg || {} }; this.apps.push(app); return app; },
    auth: auth,
    firestore: firestore,
  };
  window.AZT_LOCAL_FIREBASE = { counts: counts };
  console.info("[AZT] 로컬 실행 — 운영 Firebase 대신 대역을 씁니다(로그인·Firestore 쓰기 없음). 운영으로 확인하려면 node server.mjs --firebase");
})();
