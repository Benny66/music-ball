import { bandColor } from '../render/theme.ts';
import type { AnalysisResult } from '../types.ts';

/**
 * 波形 + 拍点条。
 * 这不是装饰：它是用户唯一能用来判断「分析到底准不准」的东西。
 * 拍点竖线如果和鼓点对不上，用户会立刻改用下面的时间微调去修。
 */
export function drawWaveform(canvas: HTMLCanvasElement, a: AnalysisResult): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 320;
  const cssH = 64;

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const env = a.envelope;
  if (env.length === 0) return;

  // 包络柱
  const bars = Math.max(1, Math.floor(cssW));
  const per = env.length / bars;
  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
  const norm = peak > 0 ? 1 / peak : 1;

  ctx.fillStyle = 'rgba(120, 170, 255, 0.34)';
  for (let x = 0; x < bars; x++) {
    let m = 0;
    const from = Math.floor(x * per);
    const to = Math.min(env.length, Math.floor((x + 1) * per));
    for (let i = from; i < to; i++) if (env[i] > m) m = env[i];
    const h = Math.max(0.6, (m * norm) ** 1.4 * (cssH - 8));
    ctx.fillRect(x, cssH - 4 - h, 1, h);
  }

  // 拍点刻度：只画底部一小段，否则 120 多拍的全高竖线会把包络糊成一片
  const tickTop = cssH - 16;
  for (const b of a.beats) {
    if (b.synthetic) continue;
    const x = (b.t / Math.max(0.01, a.duration)) * cssW;
    ctx.fillStyle = bandColor(b.band);
    ctx.globalAlpha = 0.45 + 0.5 * b.power;
    ctx.fillRect(x, tickTop, 1, cssH - 2 - tickTop);
  }
  ctx.globalAlpha = 1;
}
