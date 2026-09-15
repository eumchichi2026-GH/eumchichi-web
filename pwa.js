/* AZT PWA 부트스트랩 v3
 * - 서비스워커 등록 + 새 버전 토스트
 * - 첫 진입(브라우저로 열었을 때) 전체화면 설치 안내:
 *     안드로이드/크롬 → [홈 화면에 추가] 버튼이 진짜 설치 프롬프트를 띄움
 *     아이폰 사파리   → 공유 → 홈 화면에 추가 단계 안내 (iOS는 앱이 직접 설치를 띄울 수 없음)
 *     카톡·인스타 등 인앱 브라우저 → "사파리/크롬으로 열기" 안내 (+ 카톡은 외부 브라우저로 바로 열기)
 * - X 로 닫으면 이 기기에서 7일간 안 뜸. 홈 화면에 "앱으로 설치하기" 버튼은 계속 남음.
 * - 설치된 앱(standalone)으로 열리면 아무것도 안 보여줌
 */
(() => {
  const ua = navigator.userAgent || "";
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const inApp = /kakaotalk|instagram|fbav|fban|line\/|naver\(inapp|twitter|daumapps|whale/i.test(ua) || (isIOS && !/safari/i.test(ua) && !/crios|fxios/i.test(ua));
  const isKakao = /kakaotalk/i.test(ua);
  const iosSafari = isIOS && !inApp && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  const isMobile = isIOS || isAndroid || (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 820);
  const DISMISS_KEY = "azt_install_gate_dismissed_until";
  const SNOOZE_DAYS = 7;

  // ---- 서비스워커 ----
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          nw?.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              showToast("새 버전이 있어요", "새로고침", () => {
                nw.postMessage({ type: "SKIP_WAITING" });
                navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
              });
            }
          });
        });
      } catch (err) { console.warn("[AZT] SW 등록 실패", err); }
    });
  }

  // ---- 알림 탭 진입 / 첫 피드백 후 권한 요청 ----
  if (new URLSearchParams(location.search).get("open") === "feedback") {
    const t = setInterval(() => { if (window.aztLog) { clearInterval(t); window.aztLog.openFeedback(); } }, 200);
    setTimeout(() => clearInterval(t), 8000);
  }
  window.addEventListener("azt:first-feedback", () => {
    if ("Notification" in window && Notification.permission === "default" && isStandalone && !isIOS) Notification.requestPermission();
  });

  if (isStandalone || !isMobile) return;   // 설치된 앱 / PC 에서는 설치 안내 없음

  // ---- 설치 프롬프트 (안드로이드/데스크톱 크롬) ----
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); deferredPrompt = e;
    const btn = document.getElementById("azt-gate-install");
    if (btn) { btn.disabled = false; btn.textContent = "홈 화면에 추가"; }
  });
  window.addEventListener("appinstalled", () => { closeGate(true); track("pwa_installed"); });

  // ---- 첫 진입 전체화면 안내 ----
  function dismissedUntil() { try { return Number(localStorage.getItem(DISMISS_KEY) || 0); } catch { return 0; } }
  function snooze() { try { localStorage.setItem(DISMISS_KEY, String(Date.now() + SNOOZE_DAYS * 86400000)); } catch {} }

  function boot() {
    injectStyles();
    addHomeButton();
    if (Date.now() < dismissedUntil()) return;
    setTimeout(openGate, 600);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  function openGate() {
    if (document.getElementById("azt-gate")) return;
    const g = document.createElement("div");
    g.id = "azt-gate";
    g.setAttribute("role", "dialog");
    g.innerHTML = `
      <button class="x" aria-label="닫기">×</button>
      <div class="wrap">
        <div class="mark"><span></span></div>
        <div class="tag">AZT · 나만의 아지트</div>
        <h1>앱으로 설치하면<br>훨씬 편해요</h1>
        <p class="lead">홈 화면 아이콘으로 바로 열리고, 전체 화면으로 음악을 들을 수 있어요. 30초면 끝나요.</p>
        ${body()}
        <button class="later">나중에 할게요</button>
      </div>`;
    document.body.appendChild(g);
    document.documentElement.classList.add("azt-gate-open");
    g.querySelector(".x").onclick = () => closeGate();
    g.querySelector(".later").onclick = () => closeGate();
    g.querySelector("#azt-gate-install")?.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") closeGate(true);
      deferredPrompt = null;
    });
    g.querySelector("#azt-gate-kakao")?.addEventListener("click", () => {
      location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href);
    });
    g.querySelector("#azt-gate-copy")?.addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText(location.origin + "/"); e.target.textContent = "복사됐어요"; }
      catch { e.target.textContent = location.origin + "/"; }
    });
    track("install_gate_shown");
  }

  function body() {
    if (inApp) {
      return `
        <div class="steps">
          <div class="step"><b>1</b><div>지금은 ${isKakao ? "카카오톡" : "앱 안"} 브라우저라 설치가 안 돼요</div></div>
          <div class="step"><b>2</b><div>${isIOS ? "오른쪽 위 ··· 또는 ↗ 메뉴 → <em>Safari로 열기</em>" : "오른쪽 위 ⋮ 메뉴 → <em>다른 브라우저로 열기</em> (Chrome)"}</div></div>
          <div class="step"><b>3</b><div>거기서 다시 이 안내를 따라 설치해 주세요</div></div>
        </div>
        ${isKakao ? `<button class="cta" id="azt-gate-kakao">${isIOS ? "Safari" : "Chrome"}로 바로 열기</button>` : ""}
        <button class="ghost" id="azt-gate-copy">주소 복사하기</button>`;
    }
    if (isIOS) {
      return `
        <div class="steps">
          <div class="step"><b>1</b><div>화면 아래 <span class="ic">⎋</span> <em>공유</em> 버튼을 누르세요</div></div>
          <div class="step"><b>2</b><div>아래로 내려 <span class="ic">⊞</span> <em>홈 화면에 추가</em></div></div>
          <div class="step"><b>3</b><div>오른쪽 위 <em>추가</em> → 홈 화면에 AZT 아이콘이 생겨요</div></div>
        </div>
        ${iosSafari ? "" : `<p class="note">지금 브라우저에서는 안 될 수 있어요. <em>Safari</em>로 열어주세요.</p>`}
        <div class="arrow" aria-hidden="true">↓ 공유 버튼은 이 아래에 있어요</div>`;
    }
    if (isAndroid) {
      return `
        <button class="cta" id="azt-gate-install" ${deferredPrompt ? "" : "disabled"}>${deferredPrompt ? "홈 화면에 추가" : "준비 중…"}</button>
        <p class="note">버튼이 안 열리면: 오른쪽 위 ⋮ 메뉴 → <em>홈 화면에 추가</em> 또는 <em>앱 설치</em></p>`;
    }
    return `
      <button class="cta" id="azt-gate-install" ${deferredPrompt ? "" : "disabled"}>${deferredPrompt ? "앱으로 설치" : "준비 중…"}</button>
      <p class="note">주소창 오른쪽 끝 설치 아이콘을 눌러도 돼요. 폰에서는 이 주소를 열어 홈 화면에 추가하세요.</p>`;
  }

  function closeGate(installed) {
    document.getElementById("azt-gate")?.remove();
    document.documentElement.classList.remove("azt-gate-open");
    if (installed) { try { localStorage.setItem(DISMISS_KEY, String(Date.now() + 3650 * 86400000)); } catch {} document.getElementById("azt-home-install")?.remove(); }
    else snooze();
  }

  // 홈 화면 상단에 작게 남는 진입점 (닫은 뒤에도 다시 볼 수 있게)
  function addHomeButton() {
    const host = document.querySelector("#ground .scene-inner");
    if (!host || document.getElementById("azt-home-install")) return;
    const b = document.createElement("button");
    b.id = "azt-home-install"; b.type = "button";
    b.textContent = "📲 앱으로 설치하기";
    b.onclick = openGate;
    host.prepend(b);
  }

  // ---- 토스트 ----
  function showToast(text, cta, onCta) {
    document.getElementById("azt-toast")?.remove();
    const t = document.createElement("div");
    t.id = "azt-toast";
    t.innerHTML = `<span>${text}</span><button>${cta}</button>`;
    t.querySelector("button").onclick = onCta;
    document.body.appendChild(t);
  }

  function track(ev) { if (typeof window.aztTrack === "function") window.aztTrack(ev); }

  function injectStyles() {
    if (document.getElementById("azt-pwa-css")) return;
    const s = document.createElement("style"); s.id = "azt-pwa-css";
    s.textContent = `
    html.azt-gate-open{overflow:hidden}
    #azt-gate{position:fixed;inset:0;z-index:100000;background:#111;color:#fff;font-family:"SUIT Variable",SUIT,system-ui,sans-serif;
      overflow:auto;-webkit-overflow-scrolling:touch;animation:azt-fade .25s ease-out}
    #azt-gate .x{position:absolute;top:calc(env(safe-area-inset-top,0px) + 14px);right:14px;width:40px;height:40px;border-radius:50%;
      border:1px solid #444;background:transparent;color:#fff;font-size:22px;line-height:1}
    #azt-gate .wrap{max-width:440px;margin:0 auto;padding:calc(env(safe-area-inset-top,0px) + 64px) 24px calc(env(safe-area-inset-bottom,0px) + 32px);min-height:100%;
      box-sizing:border-box;display:flex;flex-direction:column;justify-content:center}
    #azt-gate .mark{width:56px;height:56px;border-radius:50%;background:#E8763C;display:grid;place-items:center;margin-bottom:18px}
    #azt-gate .mark span{width:38px;height:38px;border-radius:50%;background:#111;box-shadow:inset 0 0 0 5px #111,inset 0 0 0 7px #fff}
    #azt-gate .tag{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#999;margin-bottom:10px}
    #azt-gate h1{font-size:28px;line-height:1.25;font-weight:800;margin:0 0 12px;letter-spacing:-.02em}
    #azt-gate .lead{font-size:15px;line-height:1.55;color:#bbb;margin:0 0 26px}
    #azt-gate .steps{display:flex;flex-direction:column;gap:12px;margin-bottom:22px}
    #azt-gate .step{display:flex;gap:14px;align-items:flex-start;font-size:15px;line-height:1.5}
    #azt-gate .step b{flex:0 0 28px;height:28px;border-radius:50%;background:#fff;color:#111;display:grid;place-items:center;font-size:13px;font-weight:800}
    #azt-gate em{font-style:normal;color:#E8763C;font-weight:700}
    #azt-gate .ic{display:inline-block;border:1px solid #666;border-radius:5px;padding:0 5px;font-size:13px;margin:0 2px}
    #azt-gate .cta{width:100%;background:#E8763C;color:#fff;border:0;border-radius:14px;padding:16px;font-size:16px;font-weight:800;margin-bottom:10px;font-family:inherit}
    #azt-gate .cta:disabled{opacity:.45}
    #azt-gate .ghost{width:100%;background:transparent;color:#fff;border:1px solid #555;border-radius:14px;padding:14px;font-size:14px;font-weight:600;margin-bottom:10px;font-family:inherit}
    #azt-gate .note{font-size:13px;color:#999;line-height:1.5;margin:0 0 14px}
    #azt-gate .arrow{margin-top:auto;padding-top:28px;text-align:center;color:#E8763C;font-weight:700;font-size:14px;animation:azt-bob 1.2s ease-in-out infinite}
    #azt-gate .later{background:none;border:0;color:#777;font-size:13px;padding:12px;margin-top:6px;text-decoration:underline;font-family:inherit}
    #azt-home-install{display:block;width:100%;margin:0 0 14px;padding:12px;border:1px solid var(--ink,#111);background:var(--ink,#111);color:var(--on-ink,#fff);
      font-size:.8rem;font-weight:700;letter-spacing:.04em;font-family:inherit}
    #azt-toast{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 72px);z-index:99999;background:#111;color:#fff;border-radius:14px;
      padding:12px 14px;display:flex;align-items:center;gap:10px;font:14px/1.4 "SUIT Variable",SUIT,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18)}
    #azt-toast span{flex:1}
    #azt-toast button{background:#E8763C;color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:700;font-size:13px}
    @keyframes azt-fade{from{opacity:0}to{opacity:1}}
    @keyframes azt-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(6px)}}`;
    document.head.appendChild(s);
  }
})();
