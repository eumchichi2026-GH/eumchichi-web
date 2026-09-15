/* AZT service worker
 * - 앱 셸(HTML/CSS/JS/아이콘/규칙 JSON)만 캐시
 * - HTML은 network-first (배포 즉시 반영), 정적 파일은 stale-while-revalidate
 * - Firebase / Spotify / Gemini 등 API 요청은 건드리지 않음
 * 배포할 때마다 VERSION 을 올리면 구캐시가 자동 삭제됩니다.
 */
const VERSION = 'azt-v5';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/rules.compiled.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

// 캐시하지 않을 호스트 (API/실시간 데이터)
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'generativelanguage.googleapis.com',
  'api.spotify.com',
  'accounts.spotify.com',
  'open.spotify.com',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL).catch(() => {})) // 일부 파일이 없어도 설치는 진행
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (BYPASS_HOSTS.includes(url.hostname)) return;          // API는 그대로 네트워크
  if (url.origin !== self.location.origin) return;           // CDN 등 외부 정적 파일도 그대로

  const isHTML = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html');

  if (isHTML) {
    // network-first: 최신 HTML 우선, 실패 시 캐시
    e.respondWith(
      fetch(req)
        .then((res) => { caches.open(VERSION).then((c) => c.put(req, res.clone())); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  // stale-while-revalidate: 캐시 즉시 응답 + 백그라운드 갱신
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// 앱에서 postMessage({type:'SKIP_WAITING'}) 보내면 즉시 새 버전 적용
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// 알림 탭 → 앱 열고 피드백 시트 열기
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate(target); return c.focus(); } }
      return self.clients.openWindow(target);
    })
  );
});
