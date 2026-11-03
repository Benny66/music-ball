import type { Scene } from '../chart/scene.ts';
import { createScratch, draw, type Scratch } from './draw.ts';
import { createBeadScratch, drawBead, type BeadScratch } from './bead.ts';
import { drawNaturalFrame } from './natural.ts';
import type { Assets } from './assets.ts';
import type { Ctx2D, View } from './theme.ts';

export interface SceneScratch {
  classic: Scratch;
  bead: BeadScratch;
}

export function createSceneScratch(): SceneScratch {
  return { classic: createScratch(), bead: createBeadScratch() };
}

/** 预览与导出共用的唯一逐帧入口：自然滚动 / 拍点玻璃珠 / 经典。 */
export function drawScene(
  ctx: Ctx2D,
  scene: Scene,
  t: number,
  view: View,
  assets: Assets,
  scratch: SceneScratch,
  quality: 'full' | 'lite' = 'full',
  backdrop = true,
): void {
  const lite = quality === 'lite';
  if (!backdrop) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, view.w, view.h);
  }
  if (scene.motion === 'natural' && scene.natural) {
    drawNaturalFrame(ctx, scene.natural, t, view, assets, lite, backdrop);
  } else if (scene.motion === 'bead' && scene.bead) {
    drawBead(ctx, scene.bead, t, view, assets, scratch.bead, lite, backdrop);
  } else {
    draw(ctx, scene.chart, t, view, assets, scratch.classic, lite, backdrop);
  }
}
