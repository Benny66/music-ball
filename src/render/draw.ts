import { boardIndexAt, evalBall, evalCamera } from '../chart/ball.ts';
import { hash32, hashFloat } from '../util/prng.ts';
import { clamp } from '../util/math.ts';
import {
  BALL_R,
  BALL_SCREEN_RATIO,
  COLORS,
  TRAIL_COUNT,
  TRAIL_DT,
  bandColor,
  boardHalfH,
  rgba,
  type Ctx2D,
  type View,
} from './theme.ts';
import type { Assets } from './assets.ts';
import { drawImpacts } from './particles.ts';
import type { BallState, Chart } from '../types.ts';

const TAU = Math.PI * 2;

export interface Scratch {
  ball: BallState;
  tmp: BallState;
  shakeX: number;
  shakeY: number;
}

export function createScratch(): Scratch {
  return {
    ball: { x: 0, y: 0, seg: 0 },
    tmp: { x: 0, y: 0, seg: 0 },
    shakeX: 0,
    shakeY: 0,
  };
}

/**
 * 唯一的一帧绘制入口。纯函数：输出完全由 (chart, t, view) 决定。
 *
 * 硬性约束（导出可复现的前提）：
 *   - 不允许 Math.random / Date.now / performance.now
 *   - 不允许创建渐变对象（已全部预烘焙成 sprite）
 *   - 不允许依赖任何「上一帧」留下的状态
 */
export function draw(
  ctx: Ctx2D,
  chart: Chart,
  t: number,
  view: View,
  assets: Assets,
  scratch: Scratch,
): void {
  const { w, h, scale } = view;
  const cy = h * BALL_SCREEN_RATIO;

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(assets.bg, 0, 0, w, h);

  const camY = evalCamera(chart, t);
  evalBall(chart, t, scratch.ball);

  drawGrid(ctx, view, camY);

  const bx = w * 0.5 + scratch.ball.x * scale;
  const by = cy + (scratch.ball.y - camY) * scale;

  // 球周围的氛围光：一小团加法光斑，只负责把四周微微提亮，不能糊住画面
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.10;
  const halo = 150 * scale;
  ctx.drawImage(assets.glow[bandKey(chart, scratch.ball.seg)], bx - halo, by - halo, halo * 2, halo * 2);
  ctx.globalAlpha = 1;

  computeShake(chart, t, scratch, scale);
  ctx.save();
  ctx.translate(scratch.shakeX, scratch.shakeY);

  drawBoards(ctx, chart, t, view, assets, camY);
  drawImpacts(ctx, chart, t, view, assets, camY);
  drawTrail(ctx, chart, t, view, assets, scratch);
  drawBall(ctx, view, assets, scratch, bx, by, chart);

  ctx.restore();

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(assets.vignette, 0, 0, w, h);
}

/**
 * 球当前的颜色 = 它刚刚撞上的那块板的颜色。
 * segs[i] 连接 node i → node i+1，所以「刚撞的板」是 boards[i]。
 */
function bandKey(chart: Chart, seg: number): 'kick' | 'snare' | 'hat' {
  const b = chart.boards[seg];
  return b ? b.band : 'kick';
}

function drawGrid(ctx: Ctx2D, view: View, camY: number): void {
  const { w, h, scale } = view;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  // 横线：视差 0.42，滚动速度慢于相机，产生纵深
  const sp = 150 * scale;
  const base = h * BALL_SCREEN_RATIO - camY * 0.42 * scale;
  const off = ((base % sp) + sp) % sp;

  ctx.strokeStyle = rgba(COLORS.grid, 0.055);
  ctx.beginPath();
  for (let y = off - sp; y < h + sp; y += sp) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  // 中线：最便宜的位移参照物 —— 球在中心左侧还是右侧，一眼可读
  ctx.strokeStyle = rgba(COLORS.grid, 0.07);
  ctx.beginPath();
  ctx.moveTo(w * 0.5, 0);
  ctx.lineTo(w * 0.5, h);
  ctx.stroke();

  // 竖线：静态，标出赛道宽度
  ctx.strokeStyle = rgba(COLORS.grid, 0.06);
  ctx.beginPath();
  const vsp = w * 0.135;
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
  chart: Chart,
  t: number,
  view: View,
  assets: Assets,
  camY: number,
): void {
  const boards = chart.boards;
  if (boards.length === 0) return;
  const cy = view.h * BALL_SCREEN_RATIO;
  const scale = view.scale;

  // 可见范围：上方留 1.6 屏（刚撞过的板还要看得到），下方留 0.5 屏
  let i = Math.max(0, boardIndexAt(chart, t));
  let guard = 0;
  while (i > 0 && boards[i].y > camY - 1500 && guard++ < 64) i--;

  for (; i < boards.length; i++) {
    const b = boards[i];
    const sy = cy + (b.y - camY) * scale;
    const sx = view.w * 0.5 + b.x * scale;
    if (sy > view.h + 400) break;
    if (sy < -400) continue;

    const age = t - b.t;
    const hit = age >= 0 && age < 0.6 ? Math.exp(-age / 0.075) : 0;
    let alpha = b.ghost ? 0.085 : b.synthetic ? 0.32 : 0.92;

    // 碎板：撞后 0.12s 内淡出，碎片继续飞 0.5s
    const broken = b.kind === 'break' && age > 0;
    if (broken) {
      if (age < 0.5) drawShards(ctx, b, age, sx, sy, scale, assets);
      alpha *= Math.max(0, 1 - age / 0.075);
      if (alpha <= 0.004) continue;
    }

    const halfW = b.halfW * scale * (1 + 0.06 * hit);
    const bh = Math.max(2.5, b.thick * scale * (1 - 0.42 * hit));
    // 圆角半径必须随 bh 重新夹取：厚度被压到 1–2px 时浏览器与 Skia 的退化行为不一致
    const rOuter = Math.min(bh * 0.5, halfW);
    const color = bandColor(b.band);
    const glow = assets.glow[b.band];

    // 辉光不进旋转：它本来就是把方形 sprite 非等比拉伸成椭圆，
    // 再套旋转会丢轴对齐快路径、明显发糊，而径向软斑旋不旋转肉眼无差。
    // 竖向按「倾斜后的板子垂直半高」扩张，保证斜板的辉光也盖得住。
    const halfHWorld = boardHalfH(b.halfW, b.angle, b.thick);
    const glowH = 2 * (halfHWorld + 34) * scale;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * (0.5 + 1.1 * hit);
    ctx.drawImage(glow, sx - halfW * 1.5, sy - glowH * 0.5, halfW * 3, glowH);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(b.angle);

    // 玻璃板体：预烘焙的玻璃条拉伸到板宽（高光跟着拉伸），再染上该鼓组的颜色
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.drawImage(assets.glassBar, -halfW, -bh * 0.5, halfW * 2, bh);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * 0.6;
    ctx.fillStyle = rgba(color, 0.55);
    ctx.beginPath();
    ctx.roundRect(-halfW, -bh * 0.5, halfW * 2, bh, rOuter);
    ctx.fill();

    // 高亮核心：加法混合，撞击瞬间烧白
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgba('#ffffff', 0.34 + 0.62 * hit);
    ctx.beginPath();
    ctx.roundRect(
      -halfW * 0.94,
      -bh * 0.16,
      halfW * 1.88,
      bh * 0.32,
      Math.min(bh * 0.16, rOuter),
    );
    ctx.fill();

    if (b.kind === 'spring') {
      // 板下两道 V 形刻线；球逼近时呼吸式发亮，给一个「这一下会弹很高」的预告
      const pre = b.t - t;
      const breathe = pre > 0 && pre < 0.25 ? 1 - pre / 0.25 : 0;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba('#ffffff', 0.5 + 0.45 * breathe);
      ctx.lineWidth = Math.max(1.5, 2.6 * scale);
      ctx.beginPath();
      for (const dir of [-1, 1]) {
        const cx = dir * halfW * 0.30;
        const armW = halfW * 0.19;
        const y0 = bh * 0.5 + 3 * scale;
        const drop = (11 + 9 * breathe) * scale;
        ctx.moveTo(cx - armW, y0);
        ctx.lineTo(cx, y0 + drop);
        ctx.lineTo(cx + armW, y0);
      }
      ctx.stroke();
    } else if (b.kind === 'break') {
      // 一道锯齿状暗色裂纹，提示这块板会碎
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = rgba('#04060c', 0.75);
      ctx.lineWidth = Math.max(1.5, 2.2 * scale);
      ctx.beginPath();
      ctx.moveTo(-halfW * 0.3, -bh * 0.5);
      ctx.lineTo(-halfW * 0.12, -bh * 0.12);
      ctx.lineTo(-halfW * 0.22, bh * 0.18);
      ctx.lineTo(-halfW * 0.04, bh * 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }
}

/** 碎板的 8 块碎片。位置/旋转只由 (板序号, 碎片序号, age) 决定，无状态。 */
function drawShards(
  ctx: Ctx2D,
  b: Chart['boards'][number],
  age: number,
  sx: number,
  sy: number,
  scale: number,
  assets: Assets,
): void {
  const k = 1 - age / 0.5;
  if (k <= 0) return;
  const color = bandColor(b.band);
  const glow = assets.glow[b.band];

  for (let j = 0; j < 8; j++) {
    const h1 = hashFloat(b.index * 977 + 3, j * 41 + 7);
    const h2 = hashFloat(b.index * 613 + 11, j * 23 + 3);
    const h3 = hashFloat(b.index * 271 + 19, j * 59 + 13);

    const ang = (h1 - 0.5) * Math.PI * 1.15 + b.angle;
    const spd = 190 + 640 * h2;
    const px = Math.cos(ang) * spd * age;
    const py = Math.sin(ang) * spd * age + 0.5 * 1500 * age * age;
    const size = (7 + 13 * h3) * scale * (0.55 + 0.45 * k);

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = k * k * 0.9;
    ctx.drawImage(glow, sx + px - size * 2.2, sy + py - size * 2.2, size * 4.4, size * 4.4);

    ctx.save();
    ctx.translate(sx + px, sy + py);
    ctx.rotate(ang + age * (h3 - 0.5) * 9);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = k;
    ctx.fillStyle = rgba(color, 0.9);
    ctx.beginPath();
    ctx.roundRect(-size, -size * 0.3, size * 2, size * 0.6, size * 0.18);
    ctx.fill();
    ctx.restore();
  }
}

function drawTrail(
  ctx: Ctx2D,
  chart: Chart,
  t: number,
  view: View,
  assets: Assets,
  scratch: Scratch,
): void {
  const scale = view.scale;
  const cy = view.h * BALL_SCREEN_RATIO;
  const camY = evalCamera(chart, t);

  ctx.globalCompositeOperation = 'lighter';
  for (let k = TRAIL_COUNT; k >= 1; k--) {
    const tt = t - k * TRAIL_DT;
    if (tt < 0) continue;
    evalBall(chart, tt, scratch.tmp, scratch.ball.seg);
    const f = 1 - k / TRAIL_COUNT;
    const alpha = f * f * 0.85;
    if (alpha < 0.01) continue;

    const px = view.w * 0.5 + scratch.tmp.x * scale;
    const py = cy + (scratch.tmp.y - camY) * scale;
    const size = BALL_R * scale * (0.35 + 0.55 * f);
    ctx.globalAlpha = alpha;
    ctx.drawImage(
      assets.glow[bandKey(chart, scratch.tmp.seg)],
      px - size * 1.5,
      py - size * 1.5,
      size * 3,
      size * 3,
    );
  }
  ctx.globalAlpha = 1;
}

function drawBall(
  ctx: Ctx2D,
  view: View,
  assets: Assets,
  scratch: Scratch,
  bx: number,
  by: number,
  chart: Chart,
): void {
  const scale = view.scale;
  const band = bandKey(chart, scratch.ball.seg);
  const color = bandColor(band);
  const R = BALL_R * scale;

  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.85;
  ctx.drawImage(assets.glow[band], bx - R * 2.1, by - R * 2.1, R * 4.2, R * 4.2);
  ctx.globalAlpha = 0.7;
  ctx.drawImage(assets.glow.white, bx - R * 1.4, by - R * 1.4, R * 2.8, R * 2.8);

  // 白色实心核
  // 玻璃球体：预烘焙 sprite（径向渐变体 + 偏心高光 + rim light）
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(assets.glassBall, bx - R, by - R, R * 2, R * 2);

  // 能量核：玻璃球中央的一点颜色 + 白热核心
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = rgba(color, 0.55);
  ctx.beginPath();
  ctx.arc(bx, by, R * 0.3, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.arc(bx - R * 0.08, by - R * 0.1, R * 0.17, 0, TAU);
  ctx.fill();

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

/** 不同鼓组的震动权重：底鼓最沉、踩镲几乎不震 */
const SHAKE_BY_BAND = { kick: 1.5, snare: 1.0, hat: 0.32 } as const;

/**
 * 震屏。刻意不做进 camY：
 * 一旦相机被震偏，球就不再精确停在 58% 线上，而且位移会跨帧累积。
 * 这里全部由 t 反推、按拍独立相位叠加，指数衰减，可 seek、可确定性导出。
 */
function computeShake(chart: Chart, t: number, s: Scratch, scale: number): void {
  let dx = 0;
  let dy = 0;
  const idx = boardIndexAt(chart, t);
  for (let i = idx; i >= 0 && idx - i < 12; i--) {
    const b = chart.boards[i];
    const age = t - b.t;
    if (age > 0.34) break;
    if (age < 0 || b.ghost) continue;
    const amp = (0.8 + 7.0 * b.accent) * SHAKE_BY_BAND[b.band] * (scale / 1.2);
    const d = Math.exp(-age / 0.055);
    const ph = (hash32(i, 0x9e37) / 4294967296) * TAU;
    dx += amp * d * Math.sin(TAU * 37 * age + ph);
    dy += amp * d * Math.cos(TAU * 29 * age + ph * 1.7);
  }
  s.shakeX = clamp(dx, -22, 22);
  s.shakeY = clamp(dy, -22, 22);
}
