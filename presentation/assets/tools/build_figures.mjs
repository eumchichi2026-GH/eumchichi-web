// 최종 발표(2026-10-07)용 인포그래픽을 SVG 로 만든다. 숫자는 전부 아래 출처 주석의 값 그대로다.
//   node presentation/assets/tools/build_figures.mjs   → ../svg/*.svg · ../figures.js · ../figures.json
// 색·글꼴은 앱(index.html :root — web2, 2026-10-01부터 저장소 루트)과 같은 토큰을 쓴다 — 발표에서 시연 화면으로 넘어갈 때 톤이 이어지게.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'svg');
mkdirSync(OUT, { recursive: true });

// ── 토큰 ─────────────────────────────────────────────────────────────
const C = {
  ink: '#161616', mid: '#6f6f6d', muted: '#9a9a97', panel: '#f4f4f3', panel2: '#fafaf9',
  line: '#e4e4e2', lineDark: '#d8d8d6', grid: '#ecebe9', gray: '#c9c9c5', gray2: '#b5b5b1',
  accent: '#E8763C', accentStrong: '#C9581F', accentSoft: '#FBE6D9', accentWash: '#FDF3EC',
  blue: '#3F68D1', blueSoft: '#E3EAF9', white: '#ffffff',
};
const FONT = `'Pretendard Variable', Pretendard, 'Malgun Gothic', 'Apple SD Gothic Neo', system-ui, sans-serif`;

// ── 기본 도형 ────────────────────────────────────────────────────────
let FID = 'fig';
const uid = (s) => `${FID}-${s}`;
const n1 = (v) => Math.round(v * 10) / 10;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// **굵게** · ^^강조색 굵게^^ · ~~흐리게~~
const rich = (s) => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<tspan font-weight="700">$1</tspan>')
  .replace(/\^\^(.+?)\^\^/g, `<tspan font-weight="700" fill="${C.accentStrong}">$1</tspan>`)
  .replace(/~~(.+?)~~/g, `<tspan fill="${C.muted}">$1</tspan>`);

function text(x, y, s, o = {}) {
  const { size = 24, weight = 400, fill = C.ink, anchor = 'start', lh = 1.4, ls, opacity, family } = o;
  const lines = Array.isArray(s) ? s : [s];
  const a = `x="${n1(x)}" y="${n1(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"`
    + (ls != null ? ` letter-spacing="${ls}"` : '') + (opacity != null ? ` opacity="${opacity}"` : '')
    + (family ? ` font-family="${family}"` : '');
  if (lines.length === 1) return `<text ${a}>${rich(lines[0])}</text>`;
  return `<text ${a}>${lines.map((l, i) => `<tspan x="${n1(x)}" dy="${i ? n1(size * lh) : 0}">${rich(l)}</tspan>`).join('')}</text>`;
}
const rect = (x, y, w, h, o = {}) => `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${o.r ?? 0}" fill="${o.fill ?? 'none'}"`
  + (o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"` : '') + (o.opacity != null ? ` opacity="${o.opacity}"` : '') + '/>';
const line = (x1, y1, x2, y2, o = {}) => `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" stroke="${o.stroke ?? C.line}" stroke-width="${o.sw ?? 1}" stroke-linecap="${o.cap ?? 'round'}"`
  + (o.marker ? ` marker-end="url(#${uid(o.marker)})"` : '') + (o.opacity != null ? ` opacity="${o.opacity}"` : '') + '/>';
const circle = (cx, cy, r, o = {}) => `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${r}" fill="${o.fill ?? 'none'}"`
  + (o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"` : '') + (o.opacity != null ? ` opacity="${o.opacity}"` : '') + (o.extra ?? '') + '/>';
const path = (d, o = {}) => `<path d="${d}" fill="${o.fill ?? 'none'}"` + (o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1}" stroke-linecap="round" stroke-linejoin="round"` : '')
  + (o.marker ? ` marker-end="url(#${uid(o.marker)})"` : '') + (o.opacity != null ? ` opacity="${o.opacity}"` : '') + (o.extra ?? '') + '/>';

// 글자 폭 어림(Pretendard 기준) — 알약·말풍선 크기를 정할 때만 쓴다.
function tw(s, size, weight = 400) {
  let w = 0;
  for (const ch of s.replace(/\*\*|\^\^|~~/g, '')) {
    const c = ch.codePointAt(0);
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f)) w += 0.93;
    else if (ch === ' ') w += 0.26;
    else if (/[0-9]/.test(ch)) w += 0.57;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else if (/[a-z]/.test(ch)) w += 0.52;
    else if ('.,·:;\'"!|()[]‘’“”'.includes(ch)) w += 0.3;
    else w += 0.62;
  }
  return w * size * (weight >= 600 ? 1.03 : 1);
}
function pill(x, y, label, o = {}) {
  const { size = 20, h = size * 1.75, padX = size * 0.75, fill = C.panel, color = C.ink, stroke, weight = 600, anchor = 'start', r = h / 2 } = o;
  const w = tw(label, size, weight) + padX * 2;
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return { w, svg: rect(left, y, w, h, { r, fill, stroke, sw: o.sw ?? 1.5 }) + text(left + w / 2, y + h / 2 + size * 0.36, label, { size, weight, fill: color, anchor: 'middle' }) };
}
// 진행 고리: 트랙은 같은 색 계열의 옅은 단계
function ring(cx, cy, r, sw, pct, color, track) {
  return circle(cx, cy, r, { stroke: track, sw })
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90 ${cx} ${cy})"/>`;
}
// 아래가 기준선인 세로 막대(윗 모서리만 둥글게)
function colBar(x, yBase, w, h, fill, r = 8) {
  r = Math.min(r, h, w / 2);
  return path(`M${n1(x)} ${n1(yBase)}V${n1(yBase - h + r)}Q${n1(x)} ${n1(yBase - h)} ${n1(x + r)} ${n1(yBase - h)}H${n1(x + w - r)}Q${n1(x + w)} ${n1(yBase - h)} ${n1(x + w)} ${n1(yBase - h + r)}V${n1(yBase)}Z`, { fill });
}
// 왼쪽이 기준선인 가로 막대(오른 끝만 둥글게)
function rowBar(x, y, w, h, fill, r = 8) {
  r = Math.min(r, w, h / 2);
  return path(`M${n1(x)} ${n1(y)}H${n1(x + w - r)}Q${n1(x + w)} ${n1(y)} ${n1(x + w)} ${n1(y + r)}V${n1(y + h - r)}Q${n1(x + w)} ${n1(y + h)} ${n1(x + w - r)} ${n1(y + h)}H${n1(x)}Z`, { fill });
}
function smooth(pts) {
  let d = `M${n1(pts[0][0])} ${n1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${n1(c1[0])} ${n1(c1[1])} ${n1(c2[0])} ${n1(c2[1])} ${n1(p2[0])} ${n1(p2[1])}`;
  }
  return d;
}
const arrowDefs = () => [['arr', C.gray2], ['arrInk', C.ink], ['arrA', C.accent], ['arrB', C.blue]].map(([id, c]) =>
  `<marker id="${uid(id)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join('');
const caption = (x, y, s, o = {}) => text(x, y, s, { size: 19, fill: C.muted, ...o });
// 번호 동그라미
const badge = (cx, cy, n, o = {}) => circle(cx, cy, o.r ?? 18, { fill: o.fill ?? C.ink }) + text(cx, cy + (o.size ?? 18) * 0.36, String(n), { size: o.size ?? 18, weight: 700, fill: o.color ?? C.white, anchor: 'middle' });

// ── 그림 등록 ────────────────────────────────────────────────────────
const FIGS = [];
function fig(meta, build) {
  FID = meta.id;
  const { w = 1600, h = 800 } = meta;
  const { body, defs = '', style = '' } = build();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="${uid('t')} ${uid('d')}" font-family="${FONT}" class="azt-fig" data-fig="${meta.id}">`
    + `<title id="${uid('t')}">${esc(meta.title)}</title><desc id="${uid('d')}">${esc(meta.desc)}</desc>`
    + (style ? `<style>${style}</style>` : '') + `<defs>${arrowDefs()}${defs}</defs>${body}</svg>\n`;
  writeFileSync(join(OUT, `${meta.id}.svg`), svg);
  FIGS.push({ ...meta, w, h, svg });
}

// ════════════════════════════════════════════════════════════════════
// 00 표지 — 감정 좌표 위 ISO 경로가 그려지는 애니메이션(인쇄·동작 줄이기 설정에서는 완성된 그림)
fig({ id: 'cover_path', w: 1000, h: 800, section: '표지', title: 'AZT 표지 그래픽 — 지금에서 목표로 가는 음악 경로',
  desc: '감정 좌표 평면 위에서 지금(긴장)에서 목표(차분)까지 8곡이 이어지는 경로가 그려진다. 개념도.' }, () => {
  const x0 = 60, y0 = 60, w = 880, h = 680;
  const P = (v, a) => [x0 + 80 + v * (w - 160), y0 + h - 80 - a * (h - 160)];
  const pts = [[0.2, 0.88], [0.26, 0.79], [0.33, 0.69], [0.41, 0.58], [0.49, 0.47], [0.56, 0.38], [0.63, 0.31], [0.7, 0.25]].map(([v, a]) => P(v, a));
  const style = `
    .${uid('path')}{stroke-dasharray:1;stroke-dashoffset:0;animation:${uid('draw')} 2.4s cubic-bezier(.3,.7,.3,1) .3s both}
    .${uid('dot')}{transform-box:fill-box;transform-origin:center;animation:${uid('pop')} .45s ease-out both}
    @keyframes ${uid('draw')}{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
    @keyframes ${uid('pop')}{from{opacity:0;transform:scale(.3)}to{opacity:1;transform:scale(1)}}
    @media print,(prefers-reduced-motion:reduce){.${uid('path')},.${uid('dot')}{animation:none}}`;
  const defs = `<linearGradient id="${uid('g')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7D9CF"/><stop offset=".5" stop-color="#EFE3E6"/><stop offset="1" stop-color="#D6E8DF"/></linearGradient>`;
  let b = rect(x0, y0, w, h, { r: 28, fill: `url(#${uid('g')})` });
  b += line(x0 + w / 2, y0 + 40, x0 + w / 2, y0 + h - 40, { stroke: C.white, sw: 2, opacity: 0.7 }) + line(x0 + 40, y0 + h / 2, x0 + w - 40, y0 + h / 2, { stroke: C.white, sw: 2, opacity: 0.7 });
  b += text(x0 + 36, y0 + 52, '긴장 · 불안', { size: 22, fill: C.mid }) + text(x0 + w - 36, y0 + h - 30, '편안 · 차분', { size: 22, fill: C.mid, anchor: 'end' });
  b += path(smooth(pts), { stroke: C.accent, sw: 5, extra: ` pathLength="1" class="${uid('path')}"` });
  pts.forEach(([x, y], i) => {
    const delay = (0.35 + i * 0.28).toFixed(2);
    b += `<g class="${uid('dot')}" style="animation-delay:${delay}s">` + circle(x, y, 17, { fill: C.ink, stroke: C.white, sw: 3 }) + text(x, y + 6.5, String(i + 1), { size: 17, weight: 700, fill: C.white, anchor: 'middle' }) + '</g>';
  });
  const [cx, cy] = P(0.15, 0.93), [tx, ty] = P(0.7, 0.25);
  b += circle(cx - 6, cy - 4, 15, { fill: C.accent, stroke: C.white, sw: 3 }) + text(cx - 6, cy - 34, '지금', { size: 24, weight: 700, anchor: 'middle' });
  b += circle(tx, ty, 30, { stroke: C.ink, sw: 4 }) + text(tx, ty + 66, '목표', { size: 24, weight: 700, anchor: 'middle' });
  return { body: b, defs, style };
});

// 01 문제 정의 — 사전 설문 73명
fig({ id: 'problem_survey73', section: '2. 프로젝트 개요 — 문제 정의', title: '대학생 음악 이용자 73명 사전 설문',
  desc: '스트레스 상황에서 음악 활용 77%, 곡 찾는 데 5분 이상 61%, 기존 추천이 기분과 불일치 62%, 서비스 사용 의향 84%.' }, () => {
  const cols = [
    { cx: 230, v: 77, l: ['스트레스 받을 때', '음악을 활용한다'], c: C.accent, t: C.accentSoft },
    { cx: 590, v: 61, l: ['들을 곡을 찾는 데', '5분 이상 쓴 적 있다'], c: C.accent, t: C.accentSoft },
    { cx: 950, v: 62, l: ['기존 추천이 지금 기분과', '맞지 않았던 적 있다'], c: C.accent, t: C.accentSoft },
    { cx: 1370, v: 84, l: ['이런 서비스가 있다면', '사용하겠다'], c: C.ink, t: C.panel },
  ];
  let b = text(110, 112, '겪고 있는 문제', { size: 24, weight: 700, fill: C.mid }) + line(110, 132, 1070, 132, { stroke: C.lineDark, sw: 2 });
  b += text(1240, 112, '기대', { size: 24, weight: 700, fill: C.mid }) + line(1240, 132, 1500, 132, { stroke: C.lineDark, sw: 2 });
  b += line(1155, 190, 1155, 600, { stroke: C.line, sw: 2 });
  for (const c of cols) {
    b += ring(c.cx, 335, 122, 26, c.v, c.c, c.t);
    b += `<text x="${c.cx}" y="${335 + 28}" text-anchor="middle" fill="${C.ink}" font-weight="800" font-size="84">${c.v}<tspan font-size="40" font-weight="700" dx="4">%</tspan></text>`;
    b += text(c.cx, 535, c.l, { size: 27, anchor: 'middle', lh: 1.35 });
  }
  b += caption(40, 760, '대학생 음악 이용자 대상 자체 설문 (2026.8, n=73)');
  return { body: b };
});

// 02 ISO 개념 — 기존 추천 vs AZT
fig({ id: 'iso_concept', section: '2. 프로젝트 개요 — 기존 서비스와의 차별성', title: '비슷한 곡 나열 vs 지금에서 목표로 가는 순서',
  desc: '기존 추천은 지금 기분 근처의 비슷한 곡만 이어져 기분이 그대로다. AZT는 지금 기분과 같은 곡에서 시작해 목표 분위기로 조금씩 옮겨 가고 목표에 머문다. 예시 좌표 개념도.' }, () => {
  const defs = [0, 1].map((i) => `<linearGradient id="${uid('g' + i)}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBE3D8"/><stop offset=".55" stop-color="#F3EEF0"/><stop offset="1" stop-color="#DDEDE4"/></linearGradient>`).join('');
  let b = '';
  const plane = (x0, i) => {
    const y0 = 100, w = 720, h = 580;
    let s = rect(x0, y0, w, h, { r: 22, fill: `url(#${uid('g' + i)})` });
    s += line(x0 + w / 2, y0 + 24, x0 + w / 2, y0 + h - 24, { stroke: C.white, sw: 2, opacity: 0.8 }) + line(x0 + 24, y0 + h / 2, x0 + w - 24, y0 + h / 2, { stroke: C.white, sw: 2, opacity: 0.8 });
    s += text(x0 + 26, y0 + 42, '긴장 · 불안', { size: 20, fill: C.mid }) + text(x0 + w - 26, y0 + 42, '신남 · 활기', { size: 20, fill: C.mid, anchor: 'end' });
    s += text(x0 + 26, y0 + h - 24, '우울 · 무기력', { size: 20, fill: C.mid }) + text(x0 + w - 26, y0 + h - 24, '편안 · 차분', { size: 20, fill: C.mid, anchor: 'end' });
    s += text(x0 + w / 2, y0 + h + 34, '← 기분 낮음   ·   기분 높음 →', { size: 19, fill: C.muted, anchor: 'middle' });
    const P = (v, a) => [x0 + 70 + v * (w - 140), y0 + h - 70 - a * (h - 140)];
    return { s, P };
  };
  // 왼쪽: 기존 추천
  const L = plane(40, 0);
  b += text(40, 70, '기존 추천 · 비슷한 곡 나열', { size: 30, weight: 700, fill: C.mid });
  b += L.s;
  const [tlx, tly] = L.P(0.6, 0.3);
  b += circle(tlx, tly, 18, { stroke: C.ink, sw: 4, opacity: 0.35 }) + text(tlx, tly + 50, '목표', { size: 22, weight: 700, anchor: 'middle', opacity: 0.4 });
  const cluster = [[0.2, 0.84], [0.28, 0.93], [0.31, 0.85], [0.22, 0.95], [0.16, 0.88], [0.26, 0.8], [0.33, 0.91], [0.24, 0.76]];
  for (const [v, a] of cluster) { const [x, y] = L.P(v, a); b += circle(x, y, 12, { fill: C.ink, stroke: C.white, sw: 2.5, opacity: 0.85 }); }
  const [lcx, lcy] = L.P(0.245, 0.89);
  b += circle(lcx, lcy, 15, { fill: C.accent, stroke: C.white, sw: 3 }) + text(lcx + 74, lcy - 40, '지금 · 긴장돼요', { size: 22, weight: 700 });
  b += rect(420, 236, 320, 96, { r: 14, fill: C.white, opacity: 0.92 }) + text(446, 276, ['비슷한 곡만 계속 이어져서', '**기분은 그대로**'], { size: 23, lh: 1.4 });
  b += line(418, 284, lcx + 66, lcy + 30, { stroke: C.gray2, sw: 2, marker: 'arr' });
  // 오른쪽: AZT
  const R = plane(840, 1);
  b += rect(840, 46, 8, 32, { r: 3, fill: C.accent }) + text(862, 70, 'AZT · 지금 → 목표로 가는 순서', { size: 30, weight: 700 });
  b += R.s;
  const songs = [[0.22, 0.86], [0.27, 0.8], [0.33, 0.7], [0.4, 0.59], [0.47, 0.49], [0.53, 0.41], [0.6, 0.345], [0.67, 0.285]].map(([v, a]) => R.P(v, a));
  const [rcx, rcy] = R.P(0.17, 0.92), [rtx, rty] = R.P(0.67, 0.285);
  b += path(smooth([[rcx, rcy], ...songs]), { stroke: C.accent, sw: 4 });
  b += circle(rtx, rty, 30, { stroke: C.ink, sw: 4 }) + text(rtx + 44, rty + 54, '목표 · 차분해지고 싶어요', { size: 22, weight: 700 });
  b += circle(rcx, rcy, 15, { fill: C.accent, stroke: C.white, sw: 3 }) + text(rcx + 26, rcy - 22, '지금 · 긴장돼요', { size: 22, weight: 700 });
  songs.forEach(([x, y], i) => { b += circle(x, y, 16, { fill: C.ink, stroke: C.white, sw: 3 }) + text(x, y + 6, String(i + 1), { size: 16, weight: 700, fill: C.white, anchor: 'middle' }); });
  const note = (x, y, s, ax, ay) => line(x - 8, y - 8, ax, ay, { stroke: C.gray2, sw: 1.5 }) + text(x, y, s, { size: 21, fill: C.ink });
  b += note(songs[1][0] + 70, songs[1][1] + 8, '① 지금 기분과 같은 곡으로 시작', songs[1][0] + 20, songs[1][1] + 4);
  b += note(songs[3][0] + 70, songs[3][1] + 8, '② 조금씩 목표 쪽으로', songs[3][0] + 20, songs[3][1] + 4);
  b += note(songs[5][0] + 70, songs[5][1] + 8, '③ 목표 분위기에 머묾', songs[5][0] + 20, songs[5][1] + 4);
  b += caption(40, 770, '음악치료의 ISO(동질성) 원리를 감정 좌표 위 경로 탐색 문제로 바꿨다 · 개념도 (예시: ‘긴장돼요’ → ‘차분해지고 싶어요’)');
  return { body: b, defs };
});

// 03 서비스 구조 · AI 활용 위치
fig({ id: 'system_architecture', section: '4. AI 융합(활용) 내용', title: 'AZT 서비스 구조와 AI 활용 위치',
  desc: '입력 → Gemini 자연어 해석 → ISO 경로 엔진 → 재생·저장. 엔진은 곡 데이터(Gemini 가사 점수 포함)와 개인 모델을 받고, 피드백은 Gemini로 분류돼 개인 모델로 돌아간다. LLM은 변환만, 곡 순서는 수식이 정한다.' }, () => {
  let b = '';
  const box = (x, y, w, h, title, lines, o = {}) => {
    const dark = o.dark;
    let s = rect(x, y, w, h, { r: 18, fill: dark ? C.ink : o.fill ?? C.white, stroke: dark ? null : (o.stroke ?? C.lineDark), sw: o.sw ?? 2 });
    s += text(x + 28, y + 52, title, { size: 28, weight: 700, fill: dark ? C.white : C.ink });
    s += text(x + 28, y + 96, lines, { size: 21, fill: dark ? '#d9d9d6' : C.mid, lh: 1.45 });
    if (o.tag) s += pill(x + w - 20, y + 22, o.tag, { size: 17, anchor: 'end', fill: o.tagFill ?? C.accent, color: C.white, weight: 700 }).svg;
    return s;
  };
  b += box(40, 140, 300, 210, '입력', ['문장 · 감정 칩', '좌표 직접 끌기 (ver2)']);
  b += box(410, 140, 330, 210, '자연어 해석', ['문장 → 지금 · 목표 좌표', '장르 · 가사 조건 추출'], { tag: 'Gemini' });
  b += box(810, 140, 380, 210, 'ISO 경로 엔진', ['빔 서치 · 비용이 가장 작은 경로', '거리 + 역행 벌점', '+ 전환 비용 λ + 취향 비용 μ'], { dark: true });
  b += box(1260, 140, 300, 210, '재생 · 저장', ['Spotify 연속 재생', 'YouTube Music · Spotify', '플레이리스트로 가져가기']);
  b += line(342, 245, 402, 245, { stroke: C.gray2, sw: 3, marker: 'arr' }) + line(742, 245, 802, 245, { stroke: C.gray2, sw: 3, marker: 'arr' }) + line(1192, 245, 1252, 245, { stroke: C.gray2, sw: 3, marker: 'arr' });
  b += box(520, 470, 400, 200, '곡 데이터 4,117곡', ['V·A 감정 좌표 · 태그 · 장르 · 길이', '가사 감정 점수 1,768곡'], { tag: 'Gemini', fill: C.panel2 });
  b += box(980, 470, 250, 200, '개인 모델', ['기록 → 내 정책', '12가지 절차 (ver2)'], { fill: C.accentWash, stroke: C.accent });
  b += box(1290, 470, 270, 200, '피드백', ['좋아요 · 싫어요 · 벽', '청취 시간 · 한 줄 기록'], { tag: 'Gemini', fill: C.panel2 });
  b += line(860, 468, 860, 360, { stroke: C.gray2, sw: 3, marker: 'arr' });
  b += line(1105, 468, 1105, 360, { stroke: C.accent, sw: 3, marker: 'arrA' });
  b += line(1410, 352, 1410, 462, { stroke: C.gray2, sw: 3, marker: 'arr' });
  b += line(1288, 570, 1240, 570, { stroke: C.accent, sw: 3, marker: 'arrA' });
  b += text(1424, 418, '듣고 난 뒤', { size: 18, fill: C.mid });
  b += rect(40, 706, 1520, 66, { r: 14, fill: C.panel });
  b += text(800, 749, 'LLM은 **말 → 숫자** 변환만 맡고, **곡 순서는 수식**이 정한다  →  추천을 설명하고 검증할 수 있다', { size: 25, anchor: 'middle' });
  b += pill(40, 92, 'Gemini = AI 활용 지점', { size: 17, fill: C.white, stroke: C.lineDark, color: C.mid, weight: 600 }).svg;
  return { body: b };
});

// 04 한국 곡 감정 보정
fig({ id: 'korean_valence_fix', section: '3. 프로젝트 수행 과정 — 문제 해결', title: '가사를 더해 한국 곡 감정 정확도를 높이다',
  desc: '팀 골드셋과의 순위 상관: 전체 곡 Spotify만 0.399 → 가사 결합 0.495, 한국 곡 0.323 → 0.474. 해외 곡은 Spotify만으로 0.764. 보정식 V = 0.2466 + 0.3074×V(Spotify) + 0.3183×V(가사).' }, () => {
  const X0 = 130, X1 = 840, YB = 640, H = 500, max = 0.8;
  const y = (v) => YB - (v / max) * H;
  let b = '';
  for (let v = 0; v <= 0.8001; v += 0.2) { b += line(X0, y(v), X1, y(v), { stroke: v === 0 ? C.lineDark : C.grid, sw: v === 0 ? 2 : 1.5, cap: 'butt' }) + text(X0 - 14, y(v) + 6, v.toFixed(1), { size: 18, fill: C.muted, anchor: 'end' }); }
  b += line(X0, y(0.764), X1, y(0.764), { stroke: C.gray2, sw: 2, cap: 'butt' }) + text(X1, y(0.764) - 12, '해외 곡 (Spotify 값만) 0.764', { size: 19, fill: C.mid, anchor: 'end' });
  const groups = [{ cx: 320, l: '전체 곡', a: 0.399, b: 0.495 }, { cx: 650, l: '한국 곡', a: 0.323, b: 0.474 }];
  for (const g of groups) {
    b += colBar(g.cx - 84, YB, 72, (g.a / max) * H, C.gray) + colBar(g.cx + 12, YB, 72, (g.b / max) * H, C.accent);
    b += text(g.cx - 48, y(g.a) - 14, g.a.toFixed(3), { size: 24, weight: 700, anchor: 'middle', fill: C.mid });
    b += text(g.cx + 48, y(g.b) - 14, g.b.toFixed(3), { size: 26, weight: 800, anchor: 'middle' });
    b += text(g.cx, YB + 40, g.l, { size: 26, weight: 700, anchor: 'middle' });
    b += text(g.cx, YB + 74, `+${(g.b - g.a).toFixed(3)}`, { size: 22, weight: 700, anchor: 'middle', fill: C.accentStrong });
  }
  b += rect(X0, 84, 18, 18, { r: 4, fill: C.gray }) + text(X0 + 28, 100, 'Spotify 값만', { size: 21 });
  b += rect(X0 + 200, 84, 18, 18, { r: 4, fill: C.accent }) + text(X0 + 228, 100, '가사 결합 보정식', { size: 21 });
  // 오른쪽 설명 카드
  b += rect(920, 84, 640, 640, { r: 20, fill: C.panel2, stroke: C.line, sw: 1.5 });
  b += text(956, 136, '보정식 (회귀분석)', { size: 22, weight: 700, fill: C.mid });
  b += text(956, 192, ['V = 0.2466', '   + 0.3074 × V(Spotify)', '   + 0.3183 × V(가사 · Gemini)'], { size: 30, weight: 700, lh: 1.4 });
  b += line(956, 330, 1524, 330, { stroke: C.line, sw: 1.5 });
  b += text(956, 378, '최종 V를 정하는 순서', { size: 22, weight: 700, fill: C.mid });
  [['사람이 직접 태깅한 곡', '→ 사람 값'], ['가사 점수가 있는 곡', '→ 보정식'], ['나머지 곡', '→ Spotify 값']].forEach(([a, c], i) => {
    b += badge(974, 420 + i * 50, i + 1, { r: 15, size: 16 }) + text(1002, 428 + i * 50, `${a}  ~~${c}~~`, { size: 23 });
  });
  b += line(956, 586, 1524, 586, { stroke: C.line, sw: 1.5 });
  b += text(956, 630, ['한국 대학생은 가사를 이해하며 듣는다 —', '멜로디가 밝아도 가사가 슬프면 슬픈 곡으로 느낀다'], { size: 21, fill: C.mid, lh: 1.5 });
  b += caption(40, 772, '팀 골드셋(팀원 4인 판정)과의 순위 상관(Spearman) · 1에 가까울수록 사람이 느끼는 감정과 일치 · 해외 곡 비교 표본은 8곡');
  return { body: b };
});

// 05 데이터 구축 과정
fig({ id: 'data_pipeline', section: '3. 프로젝트 수행 과정 — 데이터', title: '4,117곡 감정 데이터를 만든 과정',
  desc: '곡 수 245 → 2,398 → 4,117곡. Spotify 특징 → 골드셋 249곡(쌍비교 964쌍) → Gemini 가사 감정 1,768곡 → 백분위 정규화 → 태그·장르·길이(장르 13, 연주곡 700, 가사 곡 3,417).' }, () => {
  let b = text(40, 70, '곡 데이터베이스', { size: 22, weight: 700, fill: C.mid });
  const rows = [['시작', 245], ['1차 확장', 2398], ['9/20 확장', 4117]];
  rows.forEach(([l, v], i) => {
    const yy = 100 + i * 66, w = (v / 4117) * 1040;
    b += text(220, yy + 33, l, { size: 23, anchor: 'end', fill: C.mid }) + rowBar(240, yy + 8, w, 36, i === 2 ? C.accent : C.gray);
    b += text(240 + w + 16, yy + 36, `${v.toLocaleString('en-US')}곡`, { size: i === 2 ? 30 : 24, weight: i === 2 ? 800 : 700, fill: i === 2 ? C.ink : C.mid });
  });
  b += text(1560, 300, '메인 플레이리스트 1,719곡 추가 · 기존 곡 값은 그대로 고정', { size: 19, fill: C.muted, anchor: 'end' });
  const steps = [
    ['Spotify 특징', ['곡별 밝기 · 에너지 ·', '템포 등 오디오 특징'], '4,117곡'],
    ['골드셋 판정', ['팀원 4인이 두 곡씩', '비교해 정답 감정 판정'], '249곡 · 964쌍'],
    ['가사 감정 점수', ['Gemini가 가사를', '감정 점수로 변환'], '1,768곡'],
    ['백분위 정규화', ['가운데 몰린 값을', '전체 순위로 펼침'], '0 ~ 1 균등'],
    ['태그 · 장르 · 길이', ['연주곡 판정 99곡 보정', '장르 13개 대분류'], '연주곡 700'],
  ];
  steps.forEach(([t, d, s], i) => {
    const x = 40 + i * 310, y0 = 360;
    b += rect(x, y0, 280, 330, { r: 18, fill: i === 2 ? C.accentWash : C.panel2, stroke: i === 2 ? C.accent : C.line, sw: 1.5 });
    b += badge(x + 42, y0 + 46, i + 1, { r: 19, fill: i === 2 ? C.accent : C.ink });
    if (i === 2) b += pill(x + 262, y0 + 30, 'Gemini', { size: 16, anchor: 'end', fill: C.accent, color: C.white, weight: 700 }).svg;
    b += text(x + 28, y0 + 118, t, { size: 26, weight: 700 });
    b += text(x + 28, y0 + 162, d, { size: 20, fill: C.mid, lh: 1.45 });
    b += line(x + 28, y0 + 236, x + 252, y0 + 236, { stroke: C.line, sw: 1.5 });
    b += text(x + 28, y0 + 290, s, { size: 30, weight: 800 });
    if (i < 4) b += line(x + 284, y0 + 165, x + 306, y0 + 165, { stroke: C.gray2, sw: 2.5, marker: 'arr' });
  });
  b += caption(40, 760, '가사 곡 3,417 · 연주곡 700 · 전곡 재생 길이 반영 (2026.9.30) · 비상업 라이선스·원본 오디오 부재로 오디오 모델 대신 특징 기반 유지 (9/14 결정)');
  return { body: b };
});

// 06 개발 타임라인 · 버전
fig({ id: 'version_timeline', section: '3. 프로젝트 수행 과정 — 추진 과정', title: '개발 과정 — v1에서 ver2까지',
  desc: '7월 전문가 자문, 8월 감정 데이터 구축, 8/16 엔진 v2, 9/14 가중치 근거 문제 제기, 9/15–21 v1 배포와 사용 후기 설문, 9/20–28 fix-web 재설계, 9/27–30 ver2(web2), 10/7 최종 발표.' }, () => {
  // 카드는 위·아래 두 줄로 번갈아 놓고, 점은 각 카드의 가운데(200, 370, …, 1390 — 170 간격)에 둔다.
  const AX = 400, xs = Array.from({ length: 8 }, (_, i) => 200 + i * 170);
  const ms = [
    ['7월', '전문가 자문', ['음악중재전문가 “핵심은 선호 음악”', '→ ISO 순차 추천 · 취향 조사']],
    ['8월', '감정 데이터 구축', ['골드셋으로 한국 곡 V 오차 발견', '→ Gemini 가사 보정식']],
    ['8/16', '추천 엔진 v2', ['그리디 → 빔 서치', '도착 오차 −63% · 반복 20% → 0%']],
    ['9/14', '“가중치에 근거가 없다”', ['회의에서 문제 제기', '→ 기록으로 성장하는 개인화로']],
    ['9/15–21', 'v1 배포 · 사용 후기 설문', ['실사용 36명 · 추천 71건', '사용 후기 설문 22명']],
    ['9/20–28', 'fix-web 재설계', ['4,117곡 · λ·μ 민감도 실험', '장르 규칙 · 연주곡 판정 보정']],
    ['9/27–30', 'ver2 (web2)', ['12가지 절차 전면 개인화', '합성 사용자 검증 · main 병합']],
    ['10/7', '최종 발표', ['시연: 문장 한 줄 →', '나에게 맞춘 감정 경로']],
  ];
  let b = line(60, AX, 1540, AX, { stroke: C.lineDark, sw: 3 });
  b += rect(xs[2] - 20, AX - 6, xs[4] - xs[2] + 50, 12, { r: 6, fill: C.gray2 });
  b += rect(xs[4] + 50, AX - 6, xs[5] - xs[4] + 20, 12, { r: 6, fill: C.ink });
  b += rect(xs[6] - 40, AX - 6, xs[7] - xs[6] + 80, 12, { r: 6, fill: C.accent });
  ms.forEach(([d, t, s], i) => {
    const x = xs[i], up = i % 2 === 0, ver2 = i >= 6;
    const cy0 = up ? 96 : 484, ch = 220, cw = 320;
    const left = x - cw / 2;
    b += line(x, up ? cy0 + ch : AX + 12, x, up ? AX - 12 : cy0, { stroke: C.lineDark, sw: 2 });
    b += rect(left, cy0, cw, ch, { r: 16, fill: ver2 ? C.accentWash : C.white, stroke: ver2 ? C.accent : C.line, sw: 1.5 });
    b += text(left + 24, cy0 + 42, d, { size: 21, weight: 700, fill: ver2 ? C.accentStrong : C.mid });
    b += text(left + 24, cy0 + 84, t, { size: 24, weight: 800 });
    b += text(left + 24, cy0 + 130, s, { size: 18, fill: C.mid, lh: 1.55 });
    b += circle(x, AX, 11, { fill: ver2 ? C.accent : C.ink, stroke: C.white, sw: 3 });
  });
  const lg = [[C.gray2, 'v1 · 설문 배포판'], [C.ink, 'fix-web · 설문 기반 재설계'], [C.accent, 'ver2 (web2) · 최종 서비스']];
  let lx = 40;
  for (const [c, l] of lg) { b += rect(lx, 754, 34, 12, { r: 6, fill: c }) + text(lx + 46, 766, l, { size: 20, fill: C.mid }); lx += 46 + tw(l, 20) + 48; }
  return { body: b };
});

// 07 설문 → 재설계 → ver2
fig({ id: 'survey_to_redesign', section: '3. 프로젝트 수행 과정 — 의사결정', title: '사용 후기 설문이 바꾼 것',
  desc: '설문 의견별로 fix-web 재설계와 ver2(web2)에서 무엇을 바꿨는지 보여 준다.' }, () => {
  const rows = [
    ['AI가 내 감정을 정확히 못 읽어요', ['자연어 입력 해석 개선'], ['좌표를 직접 끌어 옮기기', '+ 내 감정 단어 좌표 학습']],
    ['곡 분위기가 오락가락해요', ['전환 비용 λ = 0.1', '도착 구간 정렬'], ['빠르기 · 목소리 · 장르 전환', '민감도를 사람마다 학습']],
    ['K-pop을 눌렀는데 J-pop이 나와요', ['장르 규칙 재작성', 'J-pop 버튼 추가'], ['~~그대로 이어받음~~']],
    ['가사 없는 곡을 원했는데', ['연주곡 판정 99곡 바로잡기'], ['‘목소리가 거슬려요’ 기록 →', '말 많은 곡 자동 제외']],
    ['추천 곡이 마음에 안 들어요', ['좋아요 비율 개인화', '반영 강도 μ = 1.0 (실험)'], ['플레이리스트를 만드는', '**12가지 절차 전면 개인화**']],
  ];
  let b = text(40, 66, '사용 후기 설문에서 나온 말', { size: 24, weight: 700, fill: C.mid });
  b += text(626, 66, 'fix-web 재설계', { size: 24, weight: 700, fill: C.mid });
  b += rect(1130, 44, 8, 30, { r: 3, fill: C.accent }) + text(1150, 66, 'ver2 (web2)', { size: 24, weight: 700 });
  rows.forEach(([q, f, v], i) => {
    const y0 = 96 + i * 124, h = 108, cy = y0 + h / 2;
    b += rect(40, y0, 520, h, { r: 16, fill: C.panel });
    b += text(68, cy + 22, '“', { size: 58, weight: 800, fill: C.accent });
    b += text(112, cy + 9, q, { size: 25, weight: 600 });
    b += line(568, cy, 616, cy, { stroke: C.gray2, sw: 2.5, marker: 'arr' });
    b += rect(626, y0, 440, h, { r: 16, fill: C.white, stroke: C.line, sw: 1.5 });
    b += text(654, f.length === 1 ? cy + 8 : cy - 8, f, { size: 22, lh: 1.45 });
    b += line(1074, cy, 1122, cy, { stroke: C.accent, sw: 2.5, marker: 'arrA' });
    b += rect(1130, y0, 430, h, { r: 16, fill: C.accentWash, stroke: C.accent, sw: 1.5 });
    b += text(1158, v.length === 1 ? cy + 8 : cy - 8, v, { size: 22, lh: 1.45 });
  });
  b += caption(40, 770, '응답 요지(원문 줄임) · AZT 사용 후기 설문 2026.9.15–21, n=22 · 가장 낮은 점수: ‘첫 곡이 기분과 맞았다’ 3.8 · ‘원하는 상태로 옮겨 가는 느낌’ 3.8 (5점)');
  return { body: b };
});

// 08 사용 후기 — 스트레스 전후 (실측)
const STRESS = [[5, 4], [6, 3], [8, 5], [5, 2], [6, 4], [8, 7], [8, 5], [10, 1], [8, 5], [4, 2], [7, 5], [1, 8], [5, 2], [6, 5], [2, 2], [4, 3], [3, 2], [7, 4], [7, 4], [7, 2], [6, 4], [4, 3]];
fig({ id: 'post_use_stress', section: '6. 검증 및 평가 — 사용자 평가 (실측)', title: '사용 후기 설문 — 듣기 전과 후의 스트레스',
  desc: '22명의 스트레스 자기보고(0–10)가 평균 5.8에서 3.7로 낮아졌고 20명이 감소, 1명 그대로, 1명 증가. 스트레스 상황이던 11명은 7.0에서 3.7. 비교군 없는 사용 직후 자기보고.' }, () => {
  const XA = 240, XB = 700, y = (s) => 690 - s * 51;
  const pairs = new Map();
  for (const [a, c] of STRESS) pairs.set(`${a},${c}`, (pairs.get(`${a},${c}`) || 0) + 1);
  let b = text(XA, 140, '듣기 전', { size: 25, weight: 700, anchor: 'middle' }) + text(XB, 140, '듣고 난 후', { size: 25, weight: 700, anchor: 'middle' });
  b += line(XA, y(10), XA, y(0), { stroke: C.lineDark, sw: 2 }) + line(XB, y(10), XB, y(0), { stroke: C.lineDark, sw: 2 });
  b += text(XA - 22, y(10) + 7, '10', { size: 18, fill: C.muted, anchor: 'end' }) + text(XA - 22, y(0) + 7, '0', { size: 18, fill: C.muted, anchor: 'end' });
  b += text(XA - 22, y(10) + 32, '매우 심함', { size: 16, fill: C.muted, anchor: 'end' }) + text(XA - 22, y(0) - 18, '없음', { size: 16, fill: C.muted, anchor: 'end' });
  const order = [...pairs.entries()].sort(([k1], [k2]) => { const d = (k) => { const [a, c] = k.split(',').map(Number); return c < a ? 1 : 0; }; return d(k1) - d(k2); });
  for (const [k, cnt] of order) {
    const [a, c] = k.split(',').map(Number);
    const col = c < a ? C.accent : c === a ? C.muted : C.mid;
    b += line(XA, y(a), XB, y(c), { stroke: col, sw: 2.5 + 2.5 * (cnt - 1), opacity: c < a ? 0.62 : 0.9 });
    b += circle(XA, y(a), 5.5, { fill: col }) + circle(XB, y(c), 5.5, { fill: col });
  }
  const ma = 127 / 22, mb = 82 / 22;
  b += line(XA, y(ma), XB, y(mb), { stroke: C.ink, sw: 6 }) + circle(XA, y(ma), 9, { fill: C.ink, stroke: C.white, sw: 3 }) + circle(XB, y(mb), 9, { fill: C.ink, stroke: C.white, sw: 3 });
  b += text(XA - 22, y(ma) + 8, '평균 5.8', { size: 22, weight: 800, anchor: 'end' }) + text(XB + 22, y(mb) + 8, '평균 3.7', { size: 22, weight: 800 });
  const lg = [[C.accent, '감소 20명'], [C.muted, '그대로 1명'], [C.mid, '증가 1명']];
  lg.forEach(([c, l], i) => { b += line(760, 214 + i * 40, 800, 214 + i * 40, { stroke: c, sw: 4 }) + text(812, 221 + i * 40, l, { size: 20 }); });
  b += rect(990, 120, 570, 560, { r: 22, fill: C.panel2, stroke: C.line, sw: 1.5 });
  b += text(1030, 190, '22명 중', { size: 28, weight: 700, fill: C.mid });
  b += `<text x="1030" y="296" font-size="112" font-weight="800" fill="${C.ink}">20<tspan font-size="48" font-weight="700" dx="8">명</tspan></text>`;
  b += text(1030, 346, '스트레스가 줄었다', { size: 30, weight: 700 });
  b += line(1030, 392, 1520, 392, { stroke: C.line, sw: 1.5 });
  b += text(1030, 440, '평균 **5.8 → 3.7** (−2.1점)', { size: 26 });
  b += text(1030, 492, '스트레스 상황이던 11명  **7.0 → 3.7**', { size: 24 });
  b += text(1030, 544, '친구에게 추천할 의향  **7.9** / 10', { size: 24 });
  b += text(1030, 630, ['과제·시험 전 8명 · 발표 전 · 취준 · 스트레스 각 1명', '나머지 11명은 ‘특별한 스트레스 없음’'], { size: 18, fill: C.muted, lh: 1.5 });
  b += caption(40, 770, 'AZT 사용 후기 설문 (2026.9.15–21, n=22) · 0~10점 자기보고 · 사용 직후 측정 · 비교군 없음 · 선 굵기 = 같은 응답을 한 사람 수');
  return { body: b };
});

// 08b 사용 후기 — 문항별 점수
fig({ id: 'post_use_items', h: 520, section: '6. 검증 및 평가 — 사용자 평가 (실측)', title: '사용 후기 설문 문항별 평균 (5점)',
  desc: '첫 곡이 기분과 맞음 3.8, 원하는 상태로 옮겨 가는 느낌 3.8, 추천 만족 3.9, 사용 편의 4.2. 낮은 두 항목이 ver2 재설계의 출발점.' }, () => {
  const X0 = 560, PX = 150;
  const items = [['첫 곡이 지금 기분과 맞았다', 84 / 22], ['원하는 상태로 옮겨 가는 느낌', 83 / 22], ['전체적으로 추천 결과에 만족', 86 / 22], ['앱 사용이 쉬웠다', 93 / 22]];
  let b = '';
  for (let s = 0; s <= 5; s++) b += line(X0 + s * PX, 50, X0 + s * PX, 436, { stroke: s === 0 ? C.lineDark : C.grid, sw: s === 0 ? 2 : 1.5, cap: 'butt' }) + text(X0 + s * PX, 466, String(s), { size: 18, fill: C.muted, anchor: 'middle' });
  items.forEach(([l, v], i) => {
    const yy = 70 + i * 92, low = i < 2;
    b += text(X0 - 24, yy + 34, l, { size: 25, anchor: 'end', weight: low ? 700 : 400 });
    b += rowBar(X0, yy + 10, v * PX, 40, low ? C.accent : C.gray);
    b += text(X0 + v * PX + 16, yy + 40, v.toFixed(1), { size: 28, weight: 800 });
  });
  b += path(`M1340 82 H1356 V246 H1340`, { stroke: C.accent, sw: 2.5 });
  b += text(1378, 152, ['가장 낮은 두 항목', '→ ver2에서', '집중 개선'], { size: 22, weight: 700, lh: 1.4 });
  b += caption(40, 505, 'AZT 사용 후기 설문 (2026.9.15–21, n=22) · 5점 척도 평균');
  return { body: b };
});

// 09 엔진 재평가 (실제 요청 45건)
fig({ id: 'engine_reeval45', section: '6. 검증 및 평가 — 성능 분석 (실측 요청)', title: '실제 요청 45건으로 엔진 다시 평가 (v1 → 개선판)',
  desc: '목표 도착 오차 0.058 → 0.036 (−38%), 거꾸로 가는 곡 12.2% → 7.7% (−37%), 가장 큰 곡 간 변화 0.209 → 0.189 (−10%). 빔 서치 도입으로 도착 오차 −63%, 최근 곡 제외로 반복 추천 20% → 0%.' }, () => {
  const panels = [
    ['목표 도착 오차', '낮을수록 목표에 정확히 도착', 0.058, 0.036, '−38%', (v) => v.toFixed(3)],
    ['거꾸로 가는 곡', '목표 반대로 움직인 곡의 비율', 12.2, 7.7, '−37%', (v) => `${v}%`],
    ['가장 큰 곡 간 변화', '곡이 바뀔 때 분위기가 튄 정도', 0.209, 0.189, '−10%', (v) => v.toFixed(3)],
  ];
  let b = '';
  panels.forEach(([t, s, a, c, d, f], i) => {
    const x = 40 + i * 520, y0 = 60, w = 480;
    b += rect(x, y0, w, 500, { r: 20, fill: C.panel2, stroke: C.line, sw: 1.5 });
    b += text(x + 32, y0 + 62, t, { size: 30, weight: 800 }) + text(x + 32, y0 + 100, s, { size: 20, fill: C.mid });
    b += text(x + 32, y0 + 222, d, { size: 92, weight: 800 });
    const bw = 250;
    b += text(x + 32, y0 + 318, 'v1', { size: 22, fill: C.mid }) + rowBar(x + 120, y0 + 292, bw, 38, C.gray) + text(x + 120 + bw + 14, y0 + 320, f(a), { size: 22, weight: 700, fill: C.mid });
    b += text(x + 32, y0 + 398, '개선판', { size: 22, weight: 700 }) + rowBar(x + 120, y0 + 372, bw * c / a, 38, C.accent) + text(x + 120 + bw * c / a + 14, y0 + 400, f(c), { size: 24, weight: 800 });
  });
  b += rect(40, 600, 750, 110, { r: 18, fill: C.panel }) + text(76, 650, '그리디 → 빔 서치', { size: 22, fill: C.mid }) + text(76, 690, '목표 도착 오차 **−63%**', { size: 28 });
  b += rect(810, 600, 750, 110, { r: 18, fill: C.panel }) + text(846, 650, '최근 재생한 곡 제외', { size: 22, fill: C.mid }) + text(846, 690, '같은 곡 반복 추천 **20% → 0%**', { size: 28 });
  b += caption(40, 770, '실제 요청 45건을 같은 곡 목록(4,117곡)으로 이전 엔진과 개선 엔진에서 다시 실행해 오프라인 비교');
  return { body: b };
});

// 10 숫자마다 근거 — μ·λ 실험
fig({ id: 'parameter_evidence', section: '6. 검증 및 평가 — 실험', title: '숫자마다 근거 만들기 — 반영 강도 μ와 전환 비용 λ',
  desc: 'μ를 0에서 4까지 바꾸면 벽에 붙인 가수 등장 비율은 4, 27, 52, 73, 82, 84%로 μ=1.0 뒤 거의 늘지 않고, 목표 도착 오차는 0.015에서 0.037로 계속 나빠져 μ=1.0을 채택. λ=0.1은 곡 간 최대 분위기 차이를 0.224에서 0.197로 줄였다.' }, () => {
  const MU = ['0', '0.25', '0.5', '1.0', '2.0', '4.0'];
  const A = [4, 27, 52, 73, 82, 84], B = [0.015, 0.016, 0.019, 0.024, 0.03, 0.037];
  let b = '';
  const panel = (x0, title, vals, max, ticks, fmt, labels) => {
    const px = (i) => x0 + 60 + i * 116, py = (v) => 520 - (v / max) * 380;
    let s = text(x0, 78, title, { size: 25, weight: 700 });
    s += rect(px(3) - 44, 110, 88, 410, { r: 12, fill: C.accentSoft });
    s += text(px(3), 136, '채택', { size: 19, weight: 700, anchor: 'middle', fill: C.accentStrong });
    for (const t of ticks) s += line(x0 + 30, py(t), x0 + 670, py(t), { stroke: t === 0 ? C.lineDark : C.grid, sw: t === 0 ? 2 : 1.5, cap: 'butt' }) + text(x0 + 18, py(t) + 6, fmt(t), { size: 17, fill: C.muted, anchor: 'end' });
    s += path(vals.map((v, i) => `${i ? 'L' : 'M'}${n1(px(i))} ${n1(py(v))}`).join(''), { stroke: C.ink, sw: 3 });
    vals.forEach((v, i) => {
      s += circle(px(i), py(v), i === 3 ? 10 : 7, { fill: i === 3 ? C.accent : C.ink, stroke: C.white, sw: 3 });
      if (i === 3) s += text(px(i) - 18, py(v) - 16, fmt(v, true), { size: 26, weight: 800, anchor: 'end' });
      else if (labels.includes(i)) s += text(px(i), py(v) - 20, fmt(v, true), { size: 21, weight: 700, anchor: 'middle' });
      s += text(px(i), 556, MU[i], { size: 19, fill: i === 3 ? C.ink : C.mid, weight: i === 3 ? 700 : 400, anchor: 'middle' });
    });
    s += text(x0 + 350, 592, '반영 강도 μ', { size: 19, fill: C.mid, anchor: 'middle' });
    return s;
  };
  b += panel(70, '벽에 붙인 가수가 추천에 나온 비율', A, 100, [0, 25, 50, 75, 100], (v, l) => `${v}%`, [0, 3, 5]);
  b += panel(860, '목표 도착 오차 (낮을수록 좋음)', B, 0.04, [0, 0.01, 0.02, 0.03, 0.04], (v, l) => (l ? v.toFixed(3) : v.toFixed(2)), [0, 3, 5]);
  b += rect(40, 624, 1000, 108, { r: 16, fill: C.panel });
  b += text(72, 666, '전환 비용 λ = 0.1', { size: 23, weight: 800 });
  b += text(72, 706, '곡 간 최대 분위기 차이 0.224 → 0.197 (−13%) · 역행 0.05 → 0.03 · 도착 오차 0.031 → 0.033', { size: 20, fill: C.mid });
  b += rect(1060, 624, 500, 108, { r: 16, fill: C.panel });
  b += text(1092, 666, '스트레스 단계별 λ?', { size: 23, weight: 800 });
  b += text(1092, 706, '이득 0.003 이하 → 단일값 채택', { size: 20, fill: C.mid });
  b += caption(40, 776, 'μ: 가상 사용자 50명 × 12회 = 600회 추천 · λ: 4,117곡 · 가상 시나리오 400~600개로 값을 하나씩 바꿔 비교(민감도 분석)');
  return { body: b };
});

// 11 ver2 — 개인화되는 12가지 절차
fig({ id: 'web2_12_steps', section: '5. 최종 결과물 — ver2 개인화', title: 'ver2(web2)에서 개인화되는 12가지 절차',
  desc: '입력 해석(지금·목표 좌표), 경로 설계(속도·시작점·길이·도착 후 구간), 곡 고르기(취향·곡 사이 연결·후보 거르기·다양성·더 들을 곡), 보여 주기(내 취향 모델). 경로를 바꾸는 값과 곡만 고르는 값을 분리한다.' }, () => {
  const stages = [
    { x: 40, w: 300, t: '① 입력 해석', items: [[1, '지금 기분 좌표', '내가 끌어 옮긴 위치'], [2, '목표 좌표', '끌어 옮긴 만큼만 (자동 이동 없음)']] },
    { x: 380, w: 340, t: '② 경로 설계', items: [[3, '경로 속도', '속도 버튼 · ‘더 빨리/천천히’'], [4, '시작점', '첫 곡 넘김 · ‘기분과 달라요’'], [5, '감상 길이', '‘길었어요 / 짧았어요’'], [6, '도착 후 구간', '‘끝 분위기 달라요’ · ‘너무 자주’']] },
    { x: 760, w: 420, t: '③ 곡 고르기', items: [[7, '곡 취향', '좋아요 · 싫어요 · 벽 · 청취 시간'], [8, '곡 사이 연결', '전환 직후 넘김 (취향 몫은 뺌)'], [9, '후보 거르기', '‘가사·목소리가 거슬려요’'], [10, '다양성', '‘너무 자주 나와요’ · 노출 기록'], [11, '더 들을 곡', '위 모든 값으로 엔진이 고름']] },
    { x: 1220, w: 340, t: '④ 보여 주기', items: [[12, '「내 취향 모델」', '이번 추천에 반영된 나 · 기본 추천과 비교']] },
  ];
  let b = '';
  stages.forEach((s, si) => {
    b += text(s.x, 72, s.t, { size: 27, weight: 800 });
    if (si < 3) b += line(s.x + s.w + 6, 64, stages[si + 1].x - 8, 64, { stroke: C.gray2, sw: 2.5, marker: 'arr' });
    s.items.forEach(([n, name, sig], i) => {
      const y0 = 104 + i * 108, col = n <= 6 ? C.blue : n <= 11 ? C.accent : C.ink;
      b += rect(s.x, y0, s.w, 94, { r: 14, fill: C.white, stroke: C.line, sw: 1.5 }) + rect(s.x, y0, 8, 94, { r: 4, fill: col });
      b += badge(s.x + 42, y0 + 34, n, { r: 16, size: 16, fill: col });
      b += text(s.x + 70, y0 + 42, name, { size: 23, weight: 700 }) + text(s.x + 26, y0 + 76, sig, { size: 17.5, fill: C.mid });
    });
  });
  b += rect(1220, 230, 340, 170, { r: 16, fill: C.accentWash });
  b += text(1246, 278, ['들을수록 기록이 쌓이고', '다음 추천에 다시 반영된다'], { size: 22, weight: 700, lh: 1.45 });
  b += text(1246, 370, '쓸수록 나를 아는 추천', { size: 19, fill: C.accentStrong, weight: 700 });
  b += path('M1390 402 V690 H190 V330', { stroke: C.accent, sw: 3, marker: 'arrA' });
  b += rect(40, 742, 26, 12, { r: 4, fill: C.blue }) + text(76, 754, '경로를 바꾸는 값 (1–6)', { size: 20 });
  b += rect(340, 742, 26, 12, { r: 4, fill: C.accent }) + text(376, 754, '곡만 고르는 값 (7–11) — 취향은 경로를 바꾸지 않는다', { size: 20 });
  return { body: b };
});

// 12 ver2 — 안전장치
fig({ id: 'web2_safety', section: '5. 최종 결과물 — ver2 설계 원칙', title: '개인화를 해도 경로가 무너지지 않게',
  desc: '개인화는 기하적으로 가장 잘 맞는 밴드와 그다음 밴드(코리도어) 안에서만 곡을 바꾼다. 끄면 기존 엔진과 100% 같고, 경로와 곡 선택을 분리하며, 목표를 자동으로 옮기지 않고, 스트레스가 높으면 보수적으로, 강화학습 대신 결정식 추정을 쓴다.' }, () => {
  let b = text(40, 70, '개인화는 ‘코리도어’ 안에서만 곡을 바꾼다', { size: 27, weight: 800 });
  const bands = [['가장 잘 맞음', 80, 300], ['+1 밴드', 300, 500], ['+2', 500, 680], ['+3 이상', 680, 840]];
  b += rect(80, 130, 420, 290, { r: 18, fill: C.accentWash, stroke: C.accent, sw: 2 });
  b += text(290, 166, '코리도어 (가장 잘 맞음 + 1밴드)', { size: 20, weight: 700, anchor: 'middle', fill: C.accentStrong });
  bands.forEach(([l, x1, x2], i) => {
    if (i) b += line(x1, 190, x1, 400, { stroke: i === 2 ? C.accent : C.line, sw: i === 2 ? 0 : 1.5 });
    b += text((x1 + x2) / 2, 452, l, { size: 19, fill: C.mid, anchor: 'middle' });
  });
  const dots = [[130, 250], [190, 340], [240, 290], [340, 236], [450, 240], [470, 380], [540, 300], [610, 250], [640, 380], [700, 300], [800, 330], [790, 240]];
  for (const [x, y] of dots) b += circle(x, y, 11, { fill: C.gray });
  b += circle(390, 290, 14, { fill: C.accent, stroke: C.white, sw: 3 }) + circle(390, 290, 24, { stroke: C.accent, sw: 2.5 });
  b += text(390, 344, ['내 취향 곡', '→ 선택 가능'], { size: 19, weight: 700, anchor: 'middle', lh: 1.3 });
  b += circle(740, 360, 14, { stroke: C.accent, sw: 3, fill: C.white }) + path('M732 352 L748 368 M748 352 L732 368', { stroke: C.accent, sw: 3 });
  b += rect(560, 112, 290, 70, { r: 12, fill: C.white, stroke: C.line, sw: 1.5 }) + text(578, 142, ['취향 곡이어도 경로에서', '멀면 고르지 않는다'], { size: 18, lh: 1.35 });
  b += line(745, 184, 741, 340, { stroke: C.gray2, sw: 1.5 });
  b += text(460, 496, '← 감정 경로에 더 잘 맞음        덜 맞음 →', { size: 19, fill: C.muted, anchor: 'middle' });
  b += rect(40, 540, 820, 190, { r: 18, fill: C.panel });
  b += text(72, 592, '걸음마다  개인 비용 = clamp( μ·취향 + 전환 비용, −J, +J )', { size: 23, weight: 700 });
  b += text(72, 640, ['→ 개인화가 고른 곡은 기하적으로 가장 잘 맞는 곡보다', '   한 밴드 넘게 나빠지지 않는다 (정리로 보장)'], { size: 21, fill: C.mid, lh: 1.5 });
  const cards = [
    ['끄면 기존 엔진과 100% 같다', '회귀 1,959 시나리오 일치 · 끄는 스위치 3개'],
    ['경로와 곡 선택을 분리', '취향 때문에 넘긴 곡은 경로를 바꾸지 않는다'],
    ['목표는 자동으로 옮기지 않는다', '속도·장르·가사 등 내 선언이 모델보다 우선'],
    ['스트레스가 높으면 보수적으로', '새 가수 탐색 없음 · 자동으로 빨라지지 않음'],
    ['강화학습 대신 결정식 추정', '사용자당 1~10회 규모에 맞춘 방향 신호 학습'],
  ];
  cards.forEach(([t, s], i) => {
    const y0 = 40 + i * 140;
    b += rect(920, y0, 640, 124, { r: 16, fill: C.white, stroke: C.line, sw: 1.5 });
    b += badge(966, y0 + 62, i + 1, { r: 20, size: 19 });
    b += text(1004, y0 + 54, t, { size: 25, weight: 800 }) + text(1004, y0 + 92, s, { size: 19, fill: C.mid });
  });
  return { body: b };
});

// 13 ver2 — 검증 (합성 사용자)
fig({ id: 'web2_validation', section: '6. 검증 및 평가 — ver2 (합성 사용자)', title: 'ver2 검증 — 합성 사용자 시뮬레이션',
  desc: '수용 기준 65개 중 52개 합격(1차 49개), 단위 시험 177/177, 회귀 1,959 시나리오 일치, 추천 재현 140/140. P1은 속도를 응답 2번 만에 학습했지만 들려준 적 없는 재즈는 배우지 못했고, P2는 연주곡 비율이 2/8에서 8/8로 올랐다.' }, () => {
  let b = pill(40, 26, '합성 사용자 시뮬레이션 결과 · 실사용 효과는 로그가 쌓인 뒤 측정', { size: 19, fill: C.accentWash, stroke: C.accent, color: C.accentStrong, weight: 700 }).svg;
  b += rect(40, 90, 500, 230, { r: 20, fill: C.panel2, stroke: C.line, sw: 1.5 });
  b += ring(140, 205, 72, 20, 80, C.accent, C.accentSoft) + text(140, 216, '80%', { size: 30, weight: 800, anchor: 'middle' });
  b += `<text x="250" y="200" font-size="64" font-weight="800" fill="${C.ink}">52<tspan font-size="34" font-weight="700" fill="${C.mid}" dx="6">/ 65</tspan></text>`;
  b += text(252, 246, '수용 기준 합격', { size: 24, weight: 700 }) + text(252, 282, '1차 49 → 2차 수정 후 52', { size: 19, fill: C.mid });
  const tiles = [['177 / 177', '단위 시험'], ['1,959', '회귀 시나리오 100% 일치'], ['140 / 140', '추천 기록 재현']];
  tiles.forEach(([v, l], i) => {
    const x = 570 + i * 336;
    b += rect(x, 90, 316, 230, { r: 20, fill: C.panel2, stroke: C.line, sw: 1.5 });
    b += text(x + 30, 200, v, { size: 52, weight: 800 }) + text(x + 30, 250, l, { size: 22, fill: C.mid });
  });
  const scale = (x0, yy, from, to, l0, l1) => {
    const X = (v) => x0 + (v + 1) / 2 * 300;
    let s = line(x0, yy, x0 + 300, yy, { stroke: C.lineDark, sw: 3 });
    s += line(X(0), yy - 9, X(0), yy + 9, { stroke: C.gray2, sw: 2 });
    s += text(x0, yy + 32, '천천히', { size: 16, fill: C.muted, anchor: 'middle' }) + text(X(0), yy + 32, '기본', { size: 16, fill: C.muted, anchor: 'middle' }) + text(x0 + 300, yy + 32, '빠르게', { size: 16, fill: C.muted, anchor: 'middle' });
    s += line(X(from), yy, X(to) + (to > from ? -14 : 14), yy, { stroke: C.accent, sw: 4, marker: 'arrA' });
    s += circle(X(from), yy, 8, { fill: C.gray, stroke: C.white, sw: 2 }) + circle(X(to), yy, 10, { fill: C.accent, stroke: C.white, sw: 3 });
    s += text(X(to), yy - 20, l1, { size: 18, weight: 700, anchor: 'middle' });
    return s;
  };
  // P1
  b += rect(40, 360, 740, 380, { r: 20, fill: C.white, stroke: C.line, sw: 1.5 });
  b += text(72, 412, 'P1 · 재즈 · 빠르게 선호', { size: 26, weight: 800 });
  b += text(72, 470, '경로 속도', { size: 21, fill: C.mid }) + scale(220, 470, 0, 0.55, '', 'π 0.55');
  b += text(72, 548, '**응답 2번** 만에 학습 → 5회차부터 5번째 곡에 도착', { size: 21 });
  b += rect(72, 588, 676, 120, { r: 14, fill: C.panel });
  b += text(96, 628, ['한계: 6회 48곡 동안 재즈가 한 곡도 안 나와 취향을 못 배움', '→ 들려준 적 없는 취향은 배울 수 없다 · 탐색 설계가 필요'], { size: 19, fill: C.mid, lh: 1.6 });
  // P2
  b += rect(820, 360, 740, 380, { r: 20, fill: C.white, stroke: C.line, sw: 1.5 });
  b += text(852, 412, 'P2 · 연주곡 · 천천히 · 전환 민감', { size: 26, weight: 800 });
  b += text(852, 470, '경로 속도', { size: 21, fill: C.mid }) + scale(1000, 470, 0, -0.52, '', 'π −0.52');
  b += text(852, 548, '경로 속 연주곡', { size: 21, fill: C.mid });
  const sq = (x0, yy, filled, label) => {
    let s = text(x0, yy + 24, label, { size: 18, fill: C.mid });
    for (let i = 0; i < 8; i++) s += rect(x0 + 70 + i * 34, yy, 26, 26, { r: 5, fill: i < filled ? C.accent : C.panel, stroke: i < filled ? null : C.lineDark, sw: 1.5 });
    return s;
  };
  b += sq(1010, 528, 2, '1회차') + text(1384, 548, '2 / 8', { size: 20, weight: 700 });
  b += sq(1010, 572, 8, '4회차') + text(1384, 592, '8 / 8', { size: 20, weight: 800 });
  b += text(852, 668, '보컬 ↔ 연주 전환 민감도 **×2.0** 학습 · 6회 내내 안전 폴백 0회', { size: 21 });
  return { body: b };
});

// 14 기대효과 · 확장
fig({ id: 'expected_effects', section: '7. 기대효과 및 확장 가능성', title: '기대효과와 확장 가능성',
  desc: '사전 설문: 사용 의향 84%, 유료 지불 의사 56%(그중 30%는 월 3천 원 이상), 피드백 반영 기능 희망 78%(가장 원하는 기능 1위, 이미 구현). 확장: 캠퍼스 스트레스 자기관리, 구독형·플랫폼 연동, 스마트워치 생체신호, 상황 정보·다른 세대.' }, () => {
  const rings = [[160, 84, '서비스 사용 의향', ''], [410, 56, '유료 지불 의사', '그중 30%는 월 3천 원 이상'], [660, 78, '‘피드백 반영’ 희망', '원하는 기능 1위 — 이미 구현']];
  let b = text(40, 70, '수요', { size: 22, weight: 700, fill: C.mid });
  for (const [cx, v, l, s] of rings) {
    b += ring(cx, 230, 96, 22, v, C.accent, C.accentSoft);
    b += `<text x="${cx}" y="252" text-anchor="middle" font-size="62" font-weight="800" fill="${C.ink}">${v}<tspan font-size="30" font-weight="700" dx="3">%</tspan></text>`;
    b += text(cx, 380, l, { size: 23, weight: 700, anchor: 'middle' });
    if (s) b += text(cx, 414, s, { size: 17, fill: C.mid, anchor: 'middle' });
  }
  b += rect(40, 480, 740, 210, { r: 20, fill: C.panel });
  b += text(76, 540, '“', { size: 60, weight: 800, fill: C.accent });
  b += text(118, 538, ['감정 단어를 고르는 입력 방식이', '상담 현장의 ‘감정단어 카드’ 기법과 맞는다'], { size: 23, weight: 600, lh: 1.5 });
  b += text(118, 650, '— 학생상담센터 책임상담원 자문 · 상담을 대신하지 않고 상담 사이사이 쓰는 도구', { size: 17, fill: C.mid });
  b += text(860, 70, '활용과 확장', { size: 22, weight: 700, fill: C.mid });
  const road = [
    ['캠퍼스 스트레스 자기관리', '시험 · 과제 마감 시기 · 고위험 시 전문기관(109 등) 안내'],
    ['구독형 · 음악 플랫폼 연동', '유료 지불 의사 56% · 플레이리스트 저장 확대'],
    ['스마트워치 생체신호', '심박 변이(HRV)로 입력 없이 지금 상태 측정'],
    ['상황 정보 · 다른 세대', '날씨 · 시간 · 일정 반영 · 노년층 회상 음악'],
  ];
  b += line(902, 140, 902, 640, { stroke: C.lineDark, sw: 3 });
  road.forEach(([t, s], i) => {
    const yy = 140 + i * 166;
    b += badge(902, yy, i + 1, { r: 22, size: 20, fill: i === 0 ? C.accent : C.ink });
    b += text(946, yy + 9, t, { size: 26, weight: 800 }) + text(946, yy + 48, s, { size: 19, fill: C.mid });
  });
  b += caption(40, 770, '대학생 음악 이용자 대상 자체 설문 (2026.8, n=73) · 자문 의견 · 치료 효과를 확정한 결과가 아님');
  return { body: b };
});

// 15 시연 시나리오 (+QR)
fig({ id: 'demo_scenario', section: '5. 최종 결과물 — 시연 직전', title: '시연 시나리오',
  desc: '문장 입력 → Gemini 해석(긴장돼요 → 차분해지고 싶어요) → ISO 경로 8곡과 이번 추천에 반영된 나 → 기본 추천과 비교. 오른쪽 QR은 기본 앱 주소(eumchichi-web.vercel.app — ver2).' }, () => {
  const steps = [
    ['문장 한 줄 입력', '“내일 발표라 너무 떨리고 긴장돼요. 차분해지고 싶어요.”'],
    ['Gemini가 읽기', '지금: 긴장돼요 (아주)  →  목표: 차분해지고 싶어요'],
    ['ISO 경로 8곡', '격정에서 시작해 차분으로 · 감정 변화 지도에 경로 표시'],
    ['나에게 맞춤', '‘기본 추천과 비교’ — 8곡 중 7곡이 내 기록으로 바뀜 (예시)'],
  ];
  let b = text(40, 70, '지금부터 시연', { size: 30, weight: 800 });
  b += line(84, 150, 84, 600, { stroke: C.lineDark, sw: 3 });
  steps.forEach(([t, s], i) => {
    const yy = 150 + i * 150;
    b += badge(84, yy, i + 1, { r: 26, size: 22, fill: i === 3 ? C.accent : C.ink });
    b += text(134, yy + 10, t, { size: 30, weight: 800 }) + text(134, yy + 56, s, { size: 22, fill: C.mid });
  });
  let qr = '';
  const qf = join(OUT, 'qr_app.svg');   // [10-01] 청중용 QR 은 데모가 아니라 기본 앱(루트 = ver2)
  if (existsSync(qf)) {
    const raw = readFileSync(qf, 'utf8');
    const vb = raw.match(/viewBox="0 0 (\d+) (\d+)"/)[1];
    const inner = raw.replace(/^[\s\S]*?<\/title>/, '').replace(/<\/svg>\s*$/, '');
    qr = `<svg x="1170" y="150" width="320" height="320" viewBox="0 0 ${vb} ${vb}" shape-rendering="crispEdges">${inner}</svg>`;
  }
  b += rect(1130, 110, 400, 520, { r: 24, fill: C.white, stroke: C.line, sw: 2 }) + qr;
  b += text(1330, 520, '직접 써 보기', { size: 26, weight: 800, anchor: 'middle' });
  b += text(1330, 556, 'eumchichi-web.vercel.app', { size: 18, fill: C.mid, anchor: 'middle' });
  b += text(1330, 590, '기본 앱 · ver2', { size: 16, fill: C.muted, anchor: 'middle' });
  b += caption(40, 770, '시연 주소: eumchichi-web.vercel.app/?demo=P1 (합성 사용자 P1의 기록으로 개인화된 화면)');
  return { body: b };
});

// 16 팀 소개
fig({ id: 'team_roles', section: '1. 팀 소개', title: '팀 음치치 — 역할 분담',
  desc: '김서진(앱 기능·모바일), 박혜빈(UI·개인화), 정다솔(연구·설문), 황지민(데이터·모델). 회의록 기준.' }, () => {
  const team = [
    ['김서진', '앱 기능 · 모바일', ['입장 · 마이페이지 화면', '모바일 · PWA 설치', '플레이리스트 공유', '가수 선택 · 내 방 편집', '한 줄 평가 LLM 분석']],
    ['박혜빈', 'UI · 개인화', ['UI 디자인', '추천 알고리즘 개인화', '(재생 시간 · 좋아요 · 싫어요)']],
    ['정다솔', '연구 · 설문', ['논문 · 사전 연구', '사전 · 사용 후기 설문', '설계와 운영', '알고리즘 기본값 근거']],
    ['황지민', '데이터 · 모델', ['감정 데이터 파이프라인', '플레이리스트 흐름 평가', 'ver2 개인화 엔진']],
  ];
  let b = '';
  team.forEach(([n, r, l], i) => {
    const x = 40 + i * 390;
    b += rect(x, 90, 360, 580, { r: 22, fill: C.panel2, stroke: C.line, sw: 1.5 });
    b += circle(x + 70, 170, 38, { fill: C.ink }) + text(x + 70, 182, n.slice(1), { size: 26, weight: 800, fill: C.white, anchor: 'middle' });
    b += text(x + 32, 270, n, { size: 38, weight: 800 });
    b += pill(x + 32, 296, r, { size: 19, fill: C.white, stroke: C.lineDark, color: C.ink }).svg;
    b += line(x + 32, 370, x + 328, 370, { stroke: C.line, sw: 1.5 });
    b += text(x + 32, 418, l, { size: 21, fill: C.mid, lh: 1.6 });
  });
  b += caption(40, 760, '회의록(8/11 · 9/14 · 9/20) 기준 — 발표 전에 팀원 확인 후 문구 조정');
  return { body: b };
});

// ── 묶음 파일 ────────────────────────────────────────────────────────
const manifest = FIGS.map(({ svg, ...m }) => ({ ...m, file: `svg/${m.id}.svg`, png: `png/${m.id}.png` }));
writeFileSync(join(ROOT, 'figures.json'), JSON.stringify(manifest, null, 2) + '\n');
const bundle = `/* AZT 발표 인포그래픽 묶음 — build_figures.mjs 가 만든 파일. 직접 고치지 말 것.
   file:// 로 열어도 동작한다. 사용: <div data-azt-fig="iso_concept"></div> 를 두고 AZTFigures.mountAll().
   같은 그림을 다시 넣으면(AZTFigures.mount(el)) 표지 애니메이션이 처음부터 다시 돈다. */
(function () {
  var FIGS = ${JSON.stringify(Object.fromEntries(FIGS.map((f) => [f.id, f.svg.trim()])))};
  function mount(el) { var id = el.getAttribute('data-azt-fig'); if (!FIGS[id]) { console.warn('[AZTFigures] 없음:', id); return; } el.innerHTML = FIGS[id]; var s = el.firstElementChild; s.removeAttribute('width'); s.removeAttribute('height'); s.style.width = '100%'; s.style.height = 'auto'; s.style.display = 'block'; }
  function mountAll(root) { (root || document).querySelectorAll('[data-azt-fig]').forEach(mount); }
  window.AZTFigures = { svg: FIGS, list: Object.keys(FIGS), mount: mount, mountAll: mountAll };
})();
`;
writeFileSync(join(ROOT, 'figures.js'), bundle);
console.log(`그림 ${FIGS.length}개 → svg/ · figures.js · figures.json`);
