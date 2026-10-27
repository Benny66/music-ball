import { boardIndexAt } from '../chart/ball.ts';
import { hashFloat } from '../util/prng.ts';
import { clamp, lerp } from '../util/math.ts';
import { BALL_R, BALL_SCREEN_RATIO, bandColor, rgba, type Ctx2D, type View } from './theme.ts';
import type { Assets } from './assets.ts';
import type { Band, Chart } from '../types.ts';

const TAU = Math.PI * 2;
/** 最长特效寿命，超过就没必要再往回扫 */
const MAX_LIFE = 0.95;

interface Fx {
  /** 冲击环膨胀速度（世界单位/秒）；0 = 不画环 */
  ringSpeed: number;
  ringLife: number;
  ringWidth: number;
  rings: number;
  /** 第二圈相对第一圈的延迟（秒） */
  ringDelay: number;
  count: [number, number];
  speed: [number, number];
  size: [number, number];
  /** 扇面宽度（×π）。越大越向两侧铺开 */
  spread: [number, number];
  flashLife: number;
  gravity: number;
}

/**
 * 三档撞击：底鼓沉、军鼓锐、踩镲轻。
 * 三种拍的差异体现在「有没有环」「环多快多粗」「粒子多大多快」「闪不闪白」四个维度上，
 * 而不是简单地整体缩放 —— 否则观众只会觉得"有的拍亮一点"，分不出是不同乐器。
 */
const FX: Record<Band, Fx> = {
  kick: {
    ringSpeed: 470,
    ringLife: 0.55,
    ringWidth: 10,
    rings: 1,
    ringDelay: 0,
    count: [8, 15],
    speed: [150, 560],
    size: [4.2, 9.5],
    spread: [0.30, 0.95],
    flashLife: 0.22,
    gravity: 1150,
  },
  snare: {
    ringSpeed: 880,
    ringLife: 0.34,
    ringWidth: 4,
    rings: 2,
    ringDelay: 0.055,
    count: [18, 32],
    speed: [240, 980],
    size: [1.7, 4.4],
    spread: [0.05, 1.0],
    flashLife: 0.1,
    gravity: 900,
  },
  hat: {
    ringSpeed: 0,
    ringLife: 0,
    ringWidth: 0,
    rings: 0,
    ringDelay: 0,
    count: [8, 14],
    speed: [300, 1050],
    size: [1.3, 3.0],
    spread: [0.0, 1.05],
    flashLife: 0,
    gravity: 760,
  },
};

/**
 * 绘制最近 1 秒内的所有撞击特效。
 *
 * 完全无状态：每个粒子的位置只由 (板索引, 粒子序号, t − 撞击时刻) 决定。
 * 因此 seek 到任意时刻、或者乱序并行渲染任何一帧，画面都是同一个。
 */
export function drawImpacts(
  ctx: Ctx2D,
  chart: Chart,
  t: number,
  view: View,
  assets: Assets,
  camY: number,
): void {
  const idx = boardIndexAt(chart, t);
  if (idx < 0) return;

  const cy = view.h * BALL_SCREEN_RATIO;
  ctx.save();

  for (let i = idx; i >= 0; i--) {
    const b = chart.boards[i];
    const age = t - b.t;
    if (age > MAX_LIFE) break;
    if (age < 0 || b.ghost) continue;

    const sx = view.w * 0.5 + b.x * view.scale;
    const sy = cy + (b.y - camY) * view.scale;
    if (sy < -320 || sy > view.h + 320) continue;

    const fx = FX[b.band];
    const color = bandColor(b.band);
    const glow = assets.glow[b.band];
    const accent = b.accent;

    // 本段的撞击强度 → 粒子fly得更开。弹得越高砸得越狠，两者应该一致。
    const seg = chart.segs[i - 1];
    let strength = 1;
    if (seg) {
      const dtS = seg.t1 - seg.t0;
      if (dtS > 1e-6) {
        const vBase = seg.dy / dtS;
        const vHit = vBase + (seg.g * dtS) / 2;
        strength = clamp(vHit / (3 * vBase), 0.6, 2.2);
      }
    }

    // ① 瞬时白闪（踩镲没有）
    if (fx.flashLife > 0 && age < fx.flashLife) {
      const f = 1 - age / fx.flashLife;
      const s = (42 + 140 * (1 - f)) * view.scale * (0.7 + 0.3 * strength);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = f * f * 0.85 * (0.55 + 0.45 * accent);
      ctx.drawImage(assets.glow.white, sx - s, sy - s, s * 2, s * 2);
    }

    // ② 重音追加一次放射光斑
    if (b.barPos === 0 && age < 0.22) {
      const f = 1 - age / 0.22;
      const s = (110 + 300 * (1 - f)) * view.scale;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = f * f * 0.38;
      ctx.drawImage(assets.glow.white, sx - s, sy - s, s * 2, s * 2);
    }

    // ③ 冲击环（军鼓两圈，第二圈延迟一点）
    for (let ring = 0; ring < fx.rings; ring++) {
      const a2 = age - fx.ringDelay * ring;
      if (a2 <= 0 || a2 > fx.ringLife) continue;
      const k = 1 - a2 / fx.ringLife;
      const r = (BALL_R * 0.7 + fx.ringSpeed * a2) * view.scale;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(color, 0.68 * k * k * (0.45 + 0.55 * accent) * (ring ? 0.6 : 1));
      ctx.lineWidth = Math.max(1, fx.ringWidth * k * view.scale * 0.8);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.stroke();
    }

    // ④ 粒子迸散
    const count = Math.round(lerp(fx.count[0], fx.count[1], accent));
    const lifeMax = 0.34 + 0.48;

    ctx.globalCompositeOperation = 'lighter';
    for (let j = 0; j < count; j++) {
      const h1 = hashFloat(i * 131 + 7, j * 17 + 1);
      const h2 = hashFloat(i * 7919 + 13, j * 31 + 5);
      const h3 = hashFloat(i * 104729 + 29, j * 57 + 11);

      const life = 0.3 + lifeMax * 0.6 * h1;
      const a = 1 - age / life;
      if (a <= 0) continue;

      // 扇面沿板法线倾斜：只改角度，不在 ctx 上旋转 ——
      // 否则 0.5·g·age² 的重力项会被一起转，粒子会朝侧下方掉。
      const spread = lerp(fx.spread[0], fx.spread[1], h2);
      const ang = -Math.PI * spread + b.angle;
      const speed = lerp(fx.speed[0], fx.speed[1], h3) * strength;
      const px = b.x + Math.cos(ang) * speed * age;
      const py = b.y + Math.sin(ang) * speed * age + 0.5 * fx.gravity * age * age;

      const size = lerp(fx.size[0], fx.size[1], h1) * (0.5 + 0.5 * a) * view.scale;
      const dx = view.w * 0.5 + px * view.scale;
      const dy = cy + (py - camY) * view.scale;
      if (dx < -320 || dx > view.w + 320) continue;

      ctx.globalAlpha = a * a;
      ctx.drawImage(glow, dx - size * 2.6, dy - size * 2.6, size * 5.2, size * 5.2);
    }
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}
