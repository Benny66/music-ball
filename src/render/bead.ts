import { BALL_R, BALL_SCREEN_RATIO, bandColor, rgba, type Ctx2D, type View } from './theme.ts';
import type { Assets } from './assets.ts';
import { clamp } from '../util/math.ts';
import {
  evalBead,
  evalBeadCamera,
  evalBeadRoll,
  evalBoardEntry,
  type BeadBoard,
  type BeadPath,
  type BeadState,
} from '../chart/bead.ts';

const TAU = Math.PI * 2;

export interface BeadScratch {
  ball: BeadState;
  tmp: BeadState;
}

export function createBeadScratch(): BeadScratch {
  return {
    ball: { x: 0, y: 0, phase: 'empty', index: -1 },
    tmp: { x: 0, y: 0, phase: 'empty', index: -1 },
  };
}

export interface BeadScreenPoint {
  x: number;
  y: number;
  state: BeadState;
}

/** 世界坐标 → 屏幕坐标。撞击帧相机等于球 y，所以球精确落在 58%。 */
export function beadScreen(
  path: BeadPath,
  view: View,
  t: number,
  outState: BeadState = { x: 0, y: 0, phase: 'empty', index: -1 },
): BeadScreenPoint {
  const state = evalBead(path, t, outState);
  const camY = evalBeadCamera(path, t);
  return {
    x: view.w * 0.5 + state.x * view.scale,
    y: view.h * BALL_SCREEN_RATIO + (state.y - camY) * view.scale,
    state,
  };
}

const smoothstep = (u: number): number => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

export function drawBead(
  ctx: Ctx2D,
  path: BeadPath,
  t: number,
  view: View,
  assets: Assets,
  scratch: BeadScratch = createBeadScratch(),
): void {
  const camY = evalBeadCamera(path, t);
  const point = beadScreen(path, view, t, scratch.ball);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(assets.bg, 0, 0, view.w, view.h);
  drawGrid(ctx, view, camY);
  drawBoards(ctx, path, t, view, assets, camY);
  drawImpacts(ctx, path, t, view, assets, camY);
  drawTrail(ctx, path, t, view, assets, camY, scratch);
  drawBall(ctx, path, view, assets, point.x, point.y, scratch.ball, evalBeadRoll(path, t));
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(assets.vignette, 0, 0, view.w, view.h);
}

function drawGrid(ctx: Ctx2D, view: View, camY: number): void {
  const { w, h, scale } = view;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  const sp = 150 * scale;
  const base = h * BALL_SCREEN_RATIO - camY * 0.32 * scale;
  const off = ((base % sp) + sp) % sp;
  ctx.strokeStyle = rgba('#7fb0ff', 0.045);
  ctx.beginPath();
  for (let y = off - sp; y < h + sp; y += sp) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  ctx.strokeStyle = rgba('#7fb0ff', 0.06);
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
  path: BeadPath,
  t: number,
  view: View,
  assets: Assets,
  camY: number,
): void {
  const scale = view.scale;
  const cy = view.h * BALL_SCREEN_RATIO;

  for (const b of path.boards) {
    if (t < b.entryStart) continue;
    const entry = evalBoardEntry(b, t);
    const sx = view.w * 0.5 + (b.centerX + entry) * scale;
    const sy = cy + (b.centerY - camY) * scale;
    const halfW = b.halfW * scale;
    const thick = Math.max(2, b.thick * scale);
    if (sx < -halfW - 80 || sx > view.w + halfW + 80) continue;
    if (sy < -300 || sy > view.h + 300) continue;

    const entryU =
      b.entryEnd > b.entryStart ? clamp((t - b.entryStart) / (b.entryEnd - b.entryStart), 0, 1) : 1;
    const alpha = 0.2 + 0.8 * smoothstep(entryU);
    const age = t - b.t;
    const hit = age >= 0 && age < 0.5 ? Math.exp(-age / 0.075) : 0;
    drawBoard(ctx, b, sx, sy, halfW, thick, alpha, hit, assets);
  }
}

function drawBoard(
  ctx: Ctx2D,
  b: BeadBoard,
  sx: number,
  sy: number,
  halfW: number,
  thick: number,
  alpha: number,
  hit: number,
  assets: Assets,
): void {
  const color = bandColor(b.band);
  const hw = halfW * (1 + 0.07 * hit);
  const th = Math.max(2, thick * (1 - 0.38 * hit));

  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha * 0.55;
  ctx.drawImage(assets.glow[b.band], sx - hw * 1.35, sy - th * 3.2, hw * 2.7, th * 6.4);

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
  path: BeadPath,
  t: number,
  view: View,
  assets: Assets,
  camY: number,
): void {
  const scale = view.scale;
  const cy = view.h * BALL_SCREEN_RATIO;
  ctx.globalCompositeOperation = 'lighter';
  for (const b of path.boards) {
    const age = t - b.t;
    if (age < 0 || age > 0.55) continue;
    const px = view.w * 0.5 + b.outerX * scale;
    const py = cy + (b.impactY - camY) * scale;
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
  path: BeadPath,
  t: number,
  view: View,
  assets: Assets,
  camY: number,
  scratch: BeadScratch,
): void {
  const scale = view.scale;
  const cy = view.h * BALL_SCREEN_RATIO;
  const band = path.boards[Math.max(0, scratch.ball.index)]?.band ?? 'kick';
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 28; k >= 1; k--) {
    const tt = t - k / 120;
    if (tt < 0) continue;
    const p = evalBead(path, tt, scratch.tmp);
    const f = 1 - k / 28;
    const alpha = f * f * 0.7;
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
  path: BeadPath,
  view: View,
  assets: Assets,
  bx: number,
  by: number,
  state: BeadState,
  roll: number,
): void {
  const scale = view.scale;
  const band = path.boards[Math.max(0, state.index)]?.band ?? 'kick';
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

  // 玻璃内的偏心内含物：按滚动角转，给“滚过板面”一个可读的方向。
  // 用 source-over 的深色斑点，否则会被球体高光洗掉。
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(roll);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(10, 24, 46, 0.62)';
  ctx.beginPath();
  ctx.arc(R * 0.30, -R * 0.10, R * 0.17, 0, TAU);
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
