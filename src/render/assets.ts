import {
  bandColor,
  COLORS,
  rgba,
  type Ctx2D,
  type MakeCanvas,
  type OffscreenCanvasLike,
  type View,
} from './theme.ts';

export type GlowKey = 'kick' | 'snare' | 'hat' | 'white';

export interface Assets {
  glow: Record<GlowKey, OffscreenCanvasLike>;
  bg: OffscreenCanvasLike;
  vignette: OffscreenCanvasLike;
  /** 玻璃球（128px，径向渐变体 + 偏心高光 + rim light） */
  glassBall: OffscreenCanvasLike;
  /** 玻璃横条（256×32，上缘亮/下缘暗/中央高光条），运行时拉伸到板宽 */
  glassBar: OffscreenCanvasLike;
}

const GLOW_SIZE = 128;

/**
 * 把径向渐变预烘焙成一张贴图。
 *
 * 每帧 new 一个 createRadialGradient() 在 1080×1920、几十个对象的情况下
 * 会产生明显的 GC 抖动（实测差 3–8 倍）。shadowBlur 更糟：慢且不同引擎的
 * 高斯半径算法不一致，浏览器预览和 Node 出片会长得不一样。
 */
function makeGlow(make: MakeCanvas, hex: string): OffscreenCanvasLike {
  const c = make(GLOW_SIZE, GLOW_SIZE);
  const g = c.getContext('2d') as Ctx2D;
  const r = GLOW_SIZE / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, rgba('#ffffff', 0.95));
  grad.addColorStop(0.16, rgba(hex, 0.72));
  grad.addColorStop(0.4, rgba(hex, 0.26));
  grad.addColorStop(0.72, rgba(hex, 0.06));
  grad.addColorStop(1, rgba(hex, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
  return c;
}

function makeBackground(make: MakeCanvas, view: View): OffscreenCanvasLike {
  const c = make(view.w, view.h);
  const g = c.getContext('2d') as Ctx2D;

  const lin = g.createLinearGradient(0, 0, 0, view.h);
  lin.addColorStop(0, COLORS.bgTop);
  lin.addColorStop(0.45, '#06070f');
  lin.addColorStop(1, COLORS.bgBottom);
  g.fillStyle = lin;
  g.fillRect(0, 0, view.w, view.h);

  // 顶部一层极淡的光晕，避免纯黑背景显得死板
  const halo = g.createRadialGradient(
    view.w * 0.5,
    view.h * 0.12,
    0,
    view.w * 0.5,
    view.h * 0.12,
    view.w * 0.9,
  );
  halo.addColorStop(0, 'rgba(60,90,255,0.13)');
  halo.addColorStop(0.5, 'rgba(40,60,180,0.05)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, view.w, view.h);

  return c;
}

function makeVignette(make: MakeCanvas, view: View): OffscreenCanvasLike {
  const c = make(view.w, view.h);
  const g = c.getContext('2d') as Ctx2D;
  const grad = g.createRadialGradient(
    view.w * 0.5,
    view.h * 0.55,
    view.w * 0.18,
    view.w * 0.5,
    view.h * 0.55,
    view.w * 0.95,
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.65, 'rgba(0,0,0,0.16)');
  grad.addColorStop(1, 'rgba(0,0,0,0.62)');
  g.fillStyle = grad;
  g.fillRect(0, 0, view.w, view.h);
  return c;
}

const TAU = Math.PI * 2;

/**
 * 玻璃球：径向渐变的玻璃体 + 偏心主高光 + 底部反射的次高光 + 边缘全内反射亮环。
 * 只用渐变和 arc —— 刻意避开 ctx.filter / backdrop-filter（Safari 不支持，
 * 且 @napi-rs/canvas 与浏览器行为不一致，同一个 draw() 必须两边长得一样）。
 */
function makeGlassBall(make: MakeCanvas): OffscreenCanvasLike {
  const S = 128;
  const c = make(S, S);
  const g = c.getContext('2d') as Ctx2D;
  const r = S / 2;

  // 玻璃体：中心薄、边缘厚（全内反射让边缘发亮）
  const body = g.createRadialGradient(r * 0.85, r * 0.82, r * 0.08, r, r, r);
  body.addColorStop(0, 'rgba(255,255,255,0.32)');
  body.addColorStop(0.5, 'rgba(196,220,255,0.13)');
  body.addColorStop(0.84, 'rgba(150,190,255,0.20)');
  body.addColorStop(0.96, 'rgba(255,255,255,0.52)');
  body.addColorStop(1, 'rgba(255,255,255,0.14)');
  g.fillStyle = body;
  g.beginPath();
  g.arc(r, r, r, 0, TAU);
  g.fill();

  // 主高光（左上，光源方向）
  const hi = g.createRadialGradient(r * 0.6, r * 0.52, 0, r * 0.6, r * 0.52, r * 0.36);
  hi.addColorStop(0, 'rgba(255,255,255,0.98)');
  hi.addColorStop(0.45, 'rgba(255,255,255,0.34)');
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hi;
  g.beginPath();
  g.arc(r * 0.6, r * 0.52, r * 0.36, 0, TAU);
  g.fill();

  // 底部反射的次高光（用缩放的圆代替 ellipse —— Ctx2D 不暴露 ellipse）
  g.save();
  g.translate(r * 1.06, r * 1.3);
  g.scale(1, 0.42);
  g.fillStyle = 'rgba(255,255,255,0.30)';
  g.beginPath();
  g.arc(0, 0, r * 0.24, 0, TAU);
  g.fill();
  g.restore();

  // rim light：内缘一圈亮线
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = S * 0.02;
  g.beginPath();
  g.arc(r, r, r * 0.9, 0, TAU);
  g.stroke();

  return c;
}

/** 玻璃横条：上缘亮、下缘暗、中央高光条，运行时拉伸到板的宽度 */
function makeGlassBar(make: MakeCanvas): OffscreenCanvasLike {
  const W = 256;
  const H = 32;
  const c = make(W, H);
  const g = c.getContext('2d') as Ctx2D;
  const r = H / 2;

  const body = g.createLinearGradient(0, 0, 0, H);
  body.addColorStop(0, 'rgba(255,255,255,0.52)');
  body.addColorStop(0.28, 'rgba(202,226,255,0.20)');
  body.addColorStop(0.62, 'rgba(158,198,255,0.15)');
  body.addColorStop(0.9, 'rgba(255,255,255,0.40)');
  body.addColorStop(1, 'rgba(255,255,255,0.60)');
  g.fillStyle = body;
  g.beginPath();
  g.roundRect(0, 0, W, H, r);
  g.fill();

  // 上缘高光条（玻璃顶面的反光）
  const streak = g.createLinearGradient(0, H * 0.06, 0, H * 0.5);
  streak.addColorStop(0, 'rgba(255,255,255,0.9)');
  streak.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = streak;
  g.beginPath();
  g.roundRect(W * 0.02, H * 0.08, W * 0.96, H * 0.4, r * 0.35);
  g.fill();

  // 下缘暗边（厚度感）
  const under = g.createLinearGradient(0, H * 0.6, 0, H);
  under.addColorStop(0, 'rgba(0,0,0,0)');
  under.addColorStop(1, 'rgba(0,0,0,0.32)');
  g.fillStyle = under;
  g.beginPath();
  g.roundRect(0, H * 0.55, W, H * 0.45, r);
  g.fill();

  return c;
}

export function createAssets(make: MakeCanvas, view: View): Assets {
  return {
    glow: {
      kick: makeGlow(make, COLORS.kick),
      snare: makeGlow(make, COLORS.snare),
      hat: makeGlow(make, COLORS.hat),
      white: makeGlow(make, '#cfe4ff'),
    },
    bg: makeBackground(make, view),
    vignette: makeVignette(make, view),
    glassBall: makeGlassBall(make),
    glassBar: makeGlassBar(make),
  };
}

export { bandColor };
