import type { Band } from '../types.ts';

/**
 * 渲染层只依赖这一份最小 Canvas2D 接口。
 * 浏览器给 CanvasRenderingContext2D、Node 给 @napi-rs/canvas 的 SKRSContext2D，
 * 两者都能结构化满足 —— 这样同一份 draw() 可以在浏览器预览和 Node 出片之间零改动复用。
 */
export interface Ctx2D {
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): any;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): any;
  clearRect(x: number, y: number, w: number, h: number): void;
}

/** 离屏画布只需要宽高 + 拿得到 2d 上下文 */
export interface OffscreenCanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
}

export type MakeCanvas = (w: number, h: number) => OffscreenCanvasLike;

export interface View {
  /** 输出像素宽 */
  w: number;
  /** 输出像素高 */
  h: number;
  /** 每世界单位对应的像素数 */
  scale: number;
}

export const COLORS = {
  bgTop: '#0b1022',
  bgBottom: '#020308',
  grid: '#7fb0ff',
  kick: '#2ce8ff',
  snare: '#ff2f8e',
  hat: '#ffbe4a',
  white: '#ffffff',
} as const;

export const bandColor = (band: Band): string =>
  band === 'kick' ? COLORS.kick : band === 'snare' ? COLORS.snare : COLORS.hat;

/**
 * 世界单位常量。
 * 板子几何的唯一真相在 chart/styles.ts（因为「弹跳高度上界」要用板的垂直半高反算），
 * 这里只做转出，避免两处各写一份而对不上。
 */
export {
  BALL_R,
  BOARD_H,
  BOARD_HALF_MIN,
  BOARD_HALF_MAX,
  BOARD_TILT_MAX,
  boardHalfH,
} from '../chart/styles.ts';

/** 球心在屏幕上的高度比例。撞击那一帧球精确停在这条线上。 */
export const BALL_SCREEN_RATIO = 0.58;

/** 拖尾：32 个采样点，每 1/150 秒一个（共 267ms）—— 拉长变细才有方向感 */
export const TRAIL_COUNT = 32;
export const TRAIL_DT = 1 / 120;

/** 把 #rrggbb 转成 rgba() */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

/** 往白色方向混合，用于「亮点」 */
export function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const m = (c: number): number => Math.round(c + (255 - c) * amount);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}
