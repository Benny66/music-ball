/**
 * 玻璃珠编排几何诊断图：把每块板压成一行，检查外侧高点 → 内侧低点 → 对侧外侧高点。
 *
 *   node --experimental-strip-types scripts/bead-plot.mts
 *   → out/bead/geometry.png
 */
import { createCanvas } from '@napi-rs/canvas';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { MelodyResult } from '../src/analysis/melody.ts';
import { buildBeadChoreography, impactsFromNotes } from '../src/chart/bead.ts';

const notesPath = resolve(process.argv.find((a) => a.startsWith('--notes='))?.slice(8) ?? 'out/bead/notes.json');
const outPath = resolve(
  process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'out/bead/geometry.png',
);
if (!existsSync(notesPath)) {
  console.error(`找不到 ${notesPath}；先运行 bead:fixture`);
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(notesPath, 'utf8')) as MelodyResult;
const impacts = impactsFromNotes(parsed.notes, { minGap: 0.7 });
const path = buildBeadChoreography(impacts, { duration: 18 });

const W = 1100;
const ROW = 76;
const HEAD = 92;
const H = HEAD + path.boards.length * ROW + 40;
const WORLD_HALF = path.trackW / 2;
const X0 = 270;
const X1 = W - 70;
const xToPx = (x: number): number => W / 2 + (x / WORLD_HALF) * ((X1 - X0) / 2);

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#070a14';
ctx.fillRect(0, 0, W, H);

// 背景网格
ctx.strokeStyle = 'rgba(127,176,255,0.08)';
ctx.lineWidth = 1;
for (let k = -4; k <= 4; k++) {
  const px = xToPx((WORLD_HALF * k) / 4);
  ctx.beginPath();
  ctx.moveTo(px, HEAD - 10);
  ctx.lineTo(px, H - 20);
  ctx.stroke();
}
ctx.strokeStyle = 'rgba(127,176,255,0.22)';
ctx.setLineDash([5, 7]);
ctx.beginPath();
ctx.moveTo(W / 2, HEAD - 10);
ctx.lineTo(W / 2, H - 20);
ctx.stroke();
ctx.setLineDash([]);

// 标题
ctx.fillStyle = '#dfe9ff';
ctx.font = 'bold 22px sans-serif';
ctx.fillText('Glass-bead choreography — impact / slide / fall', 34, 38);
ctx.fillStyle = '#8ea6cc';
ctx.font = '13px sans-serif';
ctx.fillText(
  `${path.boards.length} impacts · ${(path.duration).toFixed(1)}s · L/R strict · slide → inner, fall → opposite outer`,
  34,
  62,
);

const colorOf = (band: string): string =>
  band === 'kick' ? '#2ce8ff' : band === 'snare' ? '#ff2f8e' : '#ffbe4a';

for (let i = 0; i < path.boards.length; i++) {
  const b = path.boards[i];
  const f = path.falls[i];
  const y = HEAD + i * ROW;
  const ox = xToPx(b.outerX);
  const ix = xToPx(b.innerX);
  const iy = y + 22;
  const color = colorOf(b.band);

  // 板：外侧高点 → 内侧低点
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ox, y);
  ctx.lineTo(ix, iy);
  ctx.stroke();

  // 滚动：沿板
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ox, y);
  ctx.lineTo(ix, iy);
  ctx.stroke();

  // 撞击点
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(ox, y, 5, 0, Math.PI * 2);
  ctx.fill();

  // 掉落：内侧低点 → 下一块板外侧高点
  if (f) {
    const nb = path.boards[i + 1];
    const nox = xToPx(nb.outerX);
    const ny = y + ROW;
    ctx.strokeStyle = '#8fb6ff';
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    ctx.quadraticCurveTo((ix + nox) / 2, (iy + ny) / 2 - 12, nox, ny);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#c7d6f2';
  ctx.font = '12px monospace';
  ctx.fillText(
    `#${String(i).padStart(2, '0')}  ${b.t.toFixed(2)}s  ${b.side === -1 ? 'L' : 'R'}  midi ${b.midi}  p ${b.power.toFixed(2)}  roll ${(b.innerY - b.impactY).toFixed(0)}`,
    34,
    y + 4,
  );
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log(`geometry → ${outPath}`);
console.log(
  `impacts=${path.boards.length} duration=${path.duration.toFixed(2)}s ` +
    `first=${path.impacts[0]?.t.toFixed(3)}s last=${path.impacts[path.impacts.length - 1]?.t.toFixed(3)}s`,
);
