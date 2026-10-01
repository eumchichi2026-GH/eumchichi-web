// 헤드리스 Edge 를 Chrome DevTools Protocol 로 조종하는 최소 도구 (Node 24 내장 WebSocket·fetch 만 사용).
// 캡처(capture_screens.mjs)와 PNG 렌더(render_png.mjs)가 같이 쓴다.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.AZT_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'azt-edge-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' });

  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error('Edge 가 디버깅 포트를 열지 않았습니다');
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let seq = 0;
  const pending = new Map();
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(`${m.error.message}`)) : res(m.result);
    } else if (m.method) {
      for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.res(m.params); }
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method, timeout = 30000) => new Promise((res, rej) => {
    const w = { method, res };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error(`${method} 시간 초과`)); } }, timeout);
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const tab = {
    send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async viewport(width, height, scale = 2, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    },
    async goto(url) {
      const loaded = once('Page.loadEventFired', 60000);
      await send('Page.navigate', { url });
      await loaded;
    },
    async setContent(html) {
      const { frameTree } = await send('Page.getFrameTree');
      const loaded = once('Page.loadEventFired', 60000);
      await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
      await loaded.catch(() => {});
    },
    async waitFor(expression, timeout = 30000, label = expression) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await tab.eval(`!!(${expression})`).catch(() => false)) return;
        await sleep(250);
      }
      throw new Error(`기다리다 시간 초과: ${label}`);
    },
    // clip 은 CSS 픽셀(문서 기준). scale 은 viewport 의 deviceScaleFactor 를 따른다.
    async png(clip) {
      const params = { format: 'png', captureBeyondViewport: false };
      if (clip) params.clip = { ...clip, scale: 1 };
      const { data } = await send('Page.captureScreenshot', params);
      return Buffer.from(data, 'base64');
    },
  };

  const close = async () => {
    ws.close();
    try { proc.kill(); } catch {}
    for (let i = 0; i < 20; i++) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  };
  return { tab, close };
}
