/* AZT PWA 부트스트랩
 * index.html 에 <script src="pwa.js" defer></script> 로 넣으면 끝.
 * - 서비스워커 등록 + 새 버전 나오면 상단 토스트
 * - 안드로이드/크롬: beforeinstallprompt 잡아서 "홈 화면에 추가" 버튼 노출
 * - iOS 사파리: 공유 → 홈 화면에 추가 안내 배너
 * - 이미 설치돼서 standalone 으로 열렸으면 아무것도 안 보여줌
 */
(() => {
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios|chrome/i.test(navigator.userAgent);

  // ---- 서비스워커 ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw?.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              showBar('새 버전이 있어요', '새로고침', () => {
                nw.postMessage({ type: 'SKIP_WAITING' });
                navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
              });
            }
          });
        });
      } catch (err) {
        console.warn('[AZT] SW 등록 실패', err);
      }
    });
  }

  if (isStandalone) return; // 설치된 상태면 설치 유도 불필요

  // ---- 안드로이드/데스크톱 크롬 설치 프롬프트 ----
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (dismissed()) return;
    showBar('AZT를 홈 화면에 두면 더 편해요', '추가하기', async () => {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') hideBar();
      deferredPrompt = null;
    });
  });

  window.addEventListener('appinstalled', () => {
    hideBar();
    track('pwa_installed');
  });

  // ---- iOS 안내 ----
  if (isIOS && isSafari && !dismissed()) {
    // 첫 진입 직후는 방해되니 살짝 늦게
    setTimeout(() => {
      showBar('공유 버튼 ▲ → "홈 화면에 추가"로 앱처럼 쓸 수 있어요', '알겠어요', hideBar);
    }, 4000);
  }

  // ---- 공용 바 UI (모노크롬 + 오렌지 포인트, 기존 디자인 시스템과 맞춤) ----
  const DISMISS_KEY = 'azt_pwa_dismissed';
  function dismissed() {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  }
  function hideBar() {
    document.getElementById('azt-pwa-bar')?.remove();
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {}
  }
  function showBar(text, cta, onCta) {
    hideBarSilently();
    const bar = document.createElement('div');
    bar.id = 'azt-pwa-bar';
    bar.innerHTML = `
      <style>
        #azt-pwa-bar{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 72px);
          z-index:9999;background:#111;color:#fff;border-radius:14px;padding:12px 14px;
          display:flex;align-items:center;gap:10px;font:14px/1.4 "SUIT Variable",SUIT,system-ui,sans-serif;
          box-shadow:0 8px 24px rgba(0,0,0,.18);animation:azt-up .25s ease-out}
        #azt-pwa-bar .t{flex:1}
        #azt-pwa-bar .cta{background:#E8763C;color:#fff;border:0;border-radius:10px;padding:8px 12px;
          font-weight:700;font-size:13px;letter-spacing:.02em}
        #azt-pwa-bar .x{background:none;border:0;color:#999;font-size:18px;padding:0 4px}
        @keyframes azt-up{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
      </style>
      <span class="t">${text}</span>
      <button class="cta">${cta}</button>
      <button class="x" aria-label="닫기">×</button>`;
    bar.querySelector('.cta').onclick = onCta;
    bar.querySelector('.x').onclick = hideBar;
    document.body.appendChild(bar);
  }
  function hideBarSilently() { document.getElementById('azt-pwa-bar')?.remove(); }

  // 설치 여부를 Firestore 로그에 남기고 싶으면 여기서 기존 로깅 함수 호출
  function track(event) {
    if (typeof window.aztTrack === 'function') window.aztTrack(event);
  }
})();
