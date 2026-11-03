import { BALL_R, bandColor, rgba, type Ctx2D, type View } from './theme.ts';
import type { Assets } from './assets.ts';
import { clamp } from '../util/math.ts';
import type { NaturalBoard, NaturalPath } from '../chart/natural.ts';

const TAU = Math.PI * 2;
/** 球在画面上的舒适锚点（54%）；镜头低通跟随，球在 40–65% 间浮动 */
const CY = 0.54;

export function drawNaturalFrame(
  ctx: Ctx2D,
  path: NaturalPath,
  t: number,
  view: View,
  assets: Assets,
  lite = false,
  backdrop = true,
): void {
  const scale = view.scale;
  const camY = path.camAt(t);
  const cy = view.h * CY;

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (backdrop) ctx.drawImage(assets.bg, 0, 0, view.w, view.h);
  drawGrid(ctx, view, camY, cy);
  drawBoards(ctx, path, t, view, assets, camY, cy, lite);
  drawImpacts(ctx, path, t, view, assets, camY, cy);
  if (!lite) drawTrail(ctx, path, t, view, assets, camY, cy);

  const ball = path.ballAt(t);
  const band = path.boards[ball.index]?.band ?? 'kick';
  const bx = view.w * 0.5 + ball.x * scale;
  const by = cy + (ball.y - camY) * scale;
  drawBall(ctx, view, assets, bx, by, band, ball.roll);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (backdrop) ctx.drawImage(assets.vignette, 0, 0, view.w, view.h);
}

function drawGrid(ctx: Ctx2D, view: View, camY: number, cy: number): void {
  const { w, h, scale } = view;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  const sp = 150 * scale;
  const base = cy - camY * 0.32 * scale;
  const off = ((base % sp) + sp) % sp;
  ctx.strokeStyle = rgba('#7fb0ff', 0.04);
  ctx.beginPath();
  for (let y = off - sp; y < h + sp; y += sp) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  ctx.strokeStyle = rgba('#7fb0ff', 0.05);
  const vsp = w * 0.135;
  ctx.beginPath();
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const x = w * 0.5 + k * vsp;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.stroke();
}

function drawBoards(
  ctx: Ctx2D,
  path: NaturalPath,
  t: number,
  view: View,
  assets: Assets,
  camY: number,
  cy: number,
  lite: boolean,
): void {
  const scale = view.scale;
  for (const b of path.boards) {
    const sy = cy + (b.centerY - camY) * scale;
    if (sy < -300 || sy > view.h + 300) continue;
    const sx = view.w * 0.5 + b.centerX * scale;
    const hw = b.halfW * scale;
    const th = Math.max(2, b.thick * scale);
    const edge = clamp(Math.min((sy + 200) / 200, (view.h + 200 - sy) / 200), 0, 1);
    const alpha = 0.25 + 0.75 * edge;
    const age = t - b.t;
    const hit = age >= 0 && age < 0.5 ? Math.exp(-age / 0.075) : 0;
    drawBoard(ctx, b, sx, sy, hw, th, alpha, hit, assets, lite);
  }
}

/** 板不滑入，提前存在；撞击时轻微胀亮 */
function drawBoard(
  ctx: Ctx2D,
  b: NaturalBoard,
  sx: number,
  sy: number,
  halfW: number,
  thick: number,
  alpha: number,
  hit: number,
  assets: Assets,
  lite: boolean,
): void {
  const color = bandColor(b.band);
  const hw = halfW * (1 + 0.07 * hit);
  const th = Math.max(2, thick * (1 - 0.38 * hit));

  if (!lite) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * 0.55;
    ctx.drawImage(assets.glow[b.band], sx - hw * 1.35, sy - th * 3.2, hw * 2.7, th * 6.4);
  }

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(b.angle);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha;
  ctx.drawImage(assets.glassBar, -hw, -th * 0.5, hw * 2, th);

  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha * 0.6;
  ctx.fillStyle = rgba(color, 0.55);
  ctx.beginPath();
  ctx.roundRect(-hw, -th * 0.5, hw * 2, th, Math.min(th * 0.5, hw));
  ctx.fill();

  ctx.globalAlpha = alpha * (0.38 + 0.55 * hit);
  ctx.fillStyle = rgba('#ffffff', 0.75);
  ctx.fillRect(-hw * 0.94, -th * 0.16, hw * 1.88, th * 0.32);

  ctx.globalAlpha = alpha * 0.7;
  ctx.strokeStyle = rgba('#ffffff', 0.5);
  ctx.lineWidth = Math.max(1, th * 0.1);
  ctx.beginPath();
  ctx.moveTo(-hw, -th * 0.5);
  ctx.lineTo(hw, -th * 0.5);
  ctx.stroke();

  ctx.restore();
}

function drawImpacts(
  ctx: Ctx2D,
  path: NaturalPath,
  t: number,
  view: View,
  assets: Assets,
  camY: number,
  cy: number,
): void {
  const scale = view.scale;
  ctx.globalCompositeOperation = 'lighter';
  for (const b of path.boards) {
    const age = t - b.t;
    if (age < 0 || age > 0.55) continue;
    const px = view.w * 0.5 + b.x * scale;
    const py = cy + (b.y - camY) * scale;
    if (py < -200 || py > view.h + 200) continue;

    const fade = Math.max(0, 1 - age / 0.45);
    const r = (BALL_R * 1.1 + age * 900) * scale;
    ctx.globalAlpha = fade * 0.55;
    ctx.strokeStyle = rgba('#ffffff', 0.8);
    ctx.lineWidth = Math.max(1, 3.2 * scale * fade);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.stroke();

    const flash = Math.exp(-age / 0.13);
    if (flash > 0.02) {
      const size = BALL_R * scale * (2.4 + 1.8 * (1 - flash));
      ctx.globalAlpha = flash * 0.8;
      ctx.drawImage(assets.glow.white, px - size, py - size, size * 2, size * 2);
    }
  }
  ctx.globalAlpha = 1;
}

function drawTrail(
  ctx: Ctx2D,
  path: NaturalPath,
  t: number,
  view: View,
  assets: Assets,
  camY: number,
  cy: number,
): void {
  const scale = view.scale;
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 24; k >= 1; k--) {
    const tt = t - k / 120;
    if (tt < 0) continue;
    const p = path.ballAt(tt);
    const band = path.boards[p.index]?.band ?? 'kick';
    const f = 1 - k / 24;
    const alpha = f * f * 0.5;
    if (alpha < 0.01) continue;
    const px = view.w * 0.5 + p.x * scale;
    const py = cy + (p.y - camY) * scale;
    const size = BALL_R * scale * (0.3 + 0.55 * f);
    ctx.globalAlpha = alpha;
    ctx.drawImage(assets.glow[band], px - size * 1.6, py - size * 1.6, size * 3.2, size * 3.2);
  }
  ctx.globalAlpha = 1;
}

function drawBall(
  ctx: Ctx2D,
  view: View,
  assets: Assets,
  bx: number,
  by: number,
  band: NaturalBoard['band'],
  roll: number,
): void {
  const scale = view.scale;
  const color = bandColor(band);
  const R = BALL_R * scale;

  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.85;
  ctx.drawImage(assets.glow[band], bx - R * 2.1, by - R * 2.1, R * 4.2, R * 4.2);
  ctx.globalAlpha = 0.6;
  ctx.drawImage(assets.glow.white, bx - R * 1.4, by - R * 1.4, R * 2.8, R * 2.8);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(assets.glassBall, bx - R, by - R, R * 2, R * 2);

  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = rgba(color, 0.55);
  ctx.beginPath();
  ctx.arc(bx, by, R * 0.3, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba('#ffffff', 0.92);
  ctx.beginPath();
  ctx.arc(bx - R * 0.08, by - R * 0.1, R * 0.17, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(roll);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(10, 24, 46, 0.62)';
  ctx.beginPath();
  ctx.arc(R * 0.3, -R * 0.1, R * 0.17, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-R * 0.26, R * 0.22, R * 0.065, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(10, 24, 46, 0.45)';
  ctx.lineWidth = Math.max(1, R * 0.045);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.62, -0.9, 0.35);
  ctx.stroke();
  ctx.restore();

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}
