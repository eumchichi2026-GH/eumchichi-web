// 체험용 QR 코드를 SVG 로 만든다 (qrcode-generator 를 헤드리스 Edge 에서 불러 모듈 행렬만 받아 온다).
//   node presentation/assets/tools/make_qr.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'svg');
mkdirSync(OUT, { recursive: true });

export const QR_TARGETS = {
  qr_web2_demo: 'https://eumchichi-web.vercel.app/web2/?demo=P1',
  qr_app: 'https://eumchichi-web.vercel.app/',
};

const { tab, close } = await launch();
try {
  await tab.setContent('<!doctype html><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>');
  await tab.waitFor('window.qrcode', 20000, 'qrcode-generator');
  for (const [name, url] of Object.entries(QR_TARGETS)) {
    const rows = await tab.eval(`(() => { const q = qrcode(0, 'M'); q.addData(${JSON.stringify(url)}); q.make();
      const n = q.getModuleCount(); const out = [];
      for (let r = 0; r < n; r++) { let s = ''; for (let c = 0; c < n; c++) s += q.isDark(r, c) ? '1' : '0'; out.push(s); }
      return out; })()`);
    const n = rows.length, quiet = 4, size = n + quiet * 2;
    let d = '';
    rows.forEach((row, r) => {
      for (let c = 0; c < n; c++) {
        if (row[c] !== '1') continue;
        let run = 1;
        while (c + run < n && row[c + run] === '1') run++;
        d += `M${c + quiet} ${r + quiet}h${run}v1h-${run}z`;
        c += run - 1;
      }
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 10}" height="${size * 10}" shape-rendering="crispEdges" role="img" aria-label="QR: ${url}"><title>${url}</title><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${d}" fill="#161616"/></svg>\n`;
    writeFileSync(join(OUT, `${name}.svg`), svg);
    console.log('  ✓', `${name}.svg`, url, `${n}×${n}`);
  }
} finally {
  await close();
}
