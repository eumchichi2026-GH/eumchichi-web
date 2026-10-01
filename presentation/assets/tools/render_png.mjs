// svg/*.svg 를 Pretendard 로 그려 png/*.png(가로 1920px 기준)로 내보낸다. PDF 제출본·이미지로만 넣을 때 쓴다.
//   node presentation/assets/tools/render_png.mjs [id ...]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'png');
mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ROOT, 'figures.json'), 'utf8'));
const pick = process.argv.slice(2);
const list = pick.length ? manifest.filter((f) => pick.includes(f.id)) : manifest;

const { tab, close } = await launch();
try {
  await tab.setContent(`<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
    <style>html,body{margin:0;background:#fff}*{animation:none!important}#s svg{display:block;width:100%;height:auto}</style></head>
    <body><div id="s"></div></body></html>`);
  for (const f of list) {
    const svg = readFileSync(join(ROOT, f.file), 'utf8');
    const scale = 1920 / f.w;
    await tab.viewport(f.w, f.h, scale);
    await tab.eval(`document.getElementById('s').innerHTML = ${JSON.stringify(svg)}; document.fonts.ready.then(() => true)`);
    await tab.waitFor(`document.fonts.check('700 24px "Pretendard Variable"', '가')`, 20000, 'Pretendard');
    await tab.eval(`document.fonts.ready.then(() => true)`);
    await sleep(500);
    const buf = await tab.png({ x: 0, y: 0, width: f.w, height: f.h });
    writeFileSync(join(OUT, `${f.id}.png`), buf);
    console.log('  ✓', `${f.id}.png`, `${Math.round(buf.length / 1024)}KB`);
  }
} finally {
  await close();
}
