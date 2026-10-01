// 배포된 web2 데모 모드(?demo=P1, 합성 사용자 · 기록 저장 안 함)를 헤드리스 Edge 로 돌려 발표용 화면을 찍는다.
//   node presentation/assets/tools/capture_screens.mjs [--only desktop|mobile]
// 주의: 페이지를 한 번 열 때마다 운영 Firestore 에서 곡 4,117개를 읽는다(무료 한도 하루 약 12회).
//       이 스크립트는 데스크톱 1회 + 모바일 1회만 연다. Gemini 해석도 1회씩 부른다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'screens');
const BASE = process.env.AZT_URL || 'https://eumchichi-web.vercel.app/';
const SENTENCE = '내일 발표라 너무 떨리고 긴장돼요. 차분해지고 싶어요.';
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

mkdirSync(OUT, { recursive: true });
const js = (v) => JSON.stringify(v);

async function save(tab, file, clip) {
  const buf = await tab.png(clip);
  writeFileSync(join(OUT, file), buf);
  console.log('  ✓', file, `${Math.round(buf.length / 1024)}KB`);
}

async function scrollTopAll(tab) {
  await tab.eval(`(() => { document.scrollingElement.scrollTop = 0;
    for (const e of document.querySelectorAll('*')) if (e.scrollTop > 0) e.scrollTop = 0; })()`);
  await sleep(400);
}

async function clickButton(tab, text, scope = 'document') {
  const ok = await tab.eval(`(() => { const b = [...${scope}.querySelectorAll('button')]
    .find(b => b.innerText.replace(/\\s+/g,' ').trim().includes(${js(text)}) && b.offsetParent);
    if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`버튼 없음: ${text}`);
}

// 요소를 화면 가운데로 옮겨 그 영역만 찍는다. 요소가 화면보다 크면 잠깐 화면을 늘린다.
async function shotEl(tab, sel, file, view, pad = 16) {
  const measure = () => tab.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return null;
    if (e.tagName === 'DETAILS') e.open = true;
    e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect();
    return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height, vh: innerHeight, vw: innerWidth }; })()`);
  let r = await measure();
  if (!r) throw new Error(`요소 없음: ${sel}`);
  const need = Math.ceil(r.h + pad * 2 + 140);
  const grew = need > r.vh;
  if (grew) { await tab.viewport(view.w, need, view.scale, view.mobile); await sleep(600); }
  await sleep(300);
  r = await measure();
  await sleep(300);
  const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
  await save(tab, file, { x, y, width: Math.min(r.w + pad * 2, r.vw - x), height: r.h + pad * 2 });
  if (grew) { await tab.viewport(view.w, view.h, view.scale, view.mobile); await sleep(600); }
}

async function dismissInstall(tab) {
  const closed = await tab.eval(`(() => { const b = [...document.querySelectorAll('button, a')]
    .find(b => b.innerText.trim() === '나중에 할게요' && b.offsetParent); if (b) { b.click(); return true; } return false; })()`);
  if (closed) await sleep(800);
}

async function enterAndRead(tab) {
  await clickButton(tab, '아지트 들어가기');
  await tab.waitFor(`document.getElementById('nlText')?.offsetParent`, 20000, '입력 화면');
  await tab.waitFor(`document.body.innerText.includes('곡 준비됨')`, 60000, '곡 목록 준비');
  await tab.eval(`(() => { const t = document.getElementById('nlText');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${js(SENTENCE)});
    t.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('nlApply').click(); })()`);
  await tab.waitFor(`document.getElementById('nlReadBox')?.innerText.includes('이렇게 이해했어요')`, 40000, 'Gemini 해석');
  await sleep(1200);
}

async function recommend(tab) {
  await tab.eval(`document.getElementById('go').click()`);
  await tab.waitFor(`document.getElementById('wpMe')?.offsetParent && document.body.innerText.includes('이번 추천에 반영된 나')`, 40000, '추천 결과');
  await sleep(3500);
}

async function desktop(tab) {
  const view = { w: 1440, h: 810, scale: 2, mobile: false };
  console.log('데스크톱', `${view.w}x${view.h} @${view.scale}x`);
  await tab.viewport(view.w, view.h, view.scale);
  await tab.goto(`${BASE}?demo=P1`);
  await tab.waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('아지트 들어가기'))`, 30000, '홈');
  await sleep(2000);
  await save(tab, 'screen_home.png');

  await enterAndRead(tab);
  await tab.eval(`(() => { let e = document.getElementById('nlText'); const va = document.getElementById('vaWrap');
    while (e && !e.contains(va)) e = e.parentElement; if (e) e.setAttribute('data-cap', 'inputCard'); })()`);
  await tab.eval(`document.getElementById('nlReadBox').scrollIntoView({ block: 'center' })`);
  await sleep(500);
  await save(tab, 'screen_input.png');
  await shotEl(tab, '[data-cap=inputCard]', 'screen_input_card.png', view);

  await recommend(tab);
  await scrollTopAll(tab);
  await save(tab, 'screen_result.png');
  await clickButton(tab, '기본 추천과 비교', `document.getElementById('wpMe')`);
  await sleep(1500);
  await scrollTopAll(tab);
  await save(tab, 'screen_result_compare.png');
  await shotEl(tab, '#wpMe', 'screen_wpme_compare.png', view);
  await shotEl(tab, '#emotionCard', 'screen_emotion_map.png', view);
  await tab.eval(`(() => { let e = document.getElementById('songListToggle'); const m = document.getElementById('emotionCard');
    while (e && !e.contains(m)) e = e.parentElement; if (e) e.setAttribute('data-cap', 'seqColumn'); })()`);
  await shotEl(tab, '[data-cap=seqColumn]', 'screen_sequence_column.png', view);
  await shotEl(tab, '#exportCard', 'screen_export.png', view);
  await shotEl(tab, '#afterCard', 'screen_after.png', view);

  await clickButton(tab, '내 방');
  await tab.waitFor(`document.getElementById('wpModelCard')?.offsetParent`, 20000, '내 방');
  await sleep(1500);
  await scrollTopAll(tab);
  await save(tab, 'screen_myroom.png');
  await shotEl(tab, '#wpModelCard', 'screen_model_panel.png', view);
}

async function mobile(tab) {
  const view = { w: 390, h: 844, scale: 3, mobile: true };
  console.log('모바일', `${view.w}x${view.h} @${view.scale}x`);
  await tab.send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA });
  await tab.viewport(view.w, view.h, view.scale, true);
  await tab.goto(`${BASE}?demo=P1`);
  await tab.waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('아지트 들어가기'))`, 30000, '홈');
  await sleep(2500);
  await dismissInstall(tab); // 모바일에서 뜨는 「앱으로 설치하면 훨씬 편해요」 안내를 닫는다
  await save(tab, 'mobile_home.png');
  await enterAndRead(tab);
  await dismissInstall(tab);
  await tab.eval(`document.getElementById('nlReadBox').scrollIntoView({ block: 'center' })`);
  await sleep(500);
  await save(tab, 'mobile_input.png');
  await recommend(tab);
  await scrollTopAll(tab);
  await save(tab, 'mobile_result.png');
  await clickButton(tab, '기본 추천과 비교', `document.getElementById('wpMe')`);
  await sleep(1500);
  await tab.eval(`(() => { const c = document.getElementById('emotionCard'); c.open = true; c.scrollIntoView({ block: 'center' }); })()`);
  await sleep(600);
  await save(tab, 'mobile_emotion.png');
}

const { tab, close } = await launch();
try {
  if (only !== 'mobile') await desktop(tab);
  if (only !== 'desktop') await mobile(tab);
} finally {
  await close();
}
