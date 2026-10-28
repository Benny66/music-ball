import type { Scene } from '../chart/scene.ts';
import { createScratch, draw, type Scratch } from './draw.ts';
import { createBeadScratch, drawBead, type BeadScratch } from './bead.ts';
import type { Assets } from './assets.ts';
import type { Ctx2D, View } from './theme.ts';

export interface SceneScratch {
  classic: Scratch;
  bead: BeadScratch;
}

export function createSceneScratch(): SceneScratch {
  return { classic: createScratch(), bead: createBeadScratch() };
}

/** 预览与导出共用的唯一逐帧入口：按场景选择经典或玻璃珠。 */
export function drawScene(
  ctx: Ctx2D,
  scene: Scene,
  t: number,
  view: View,
  assets: Assets,
  scratch: SceneScratch,
): void {
  if (scene.motion === 'bead' && scene.bead) {
    drawBead(ctx, scene.bead, t, view, assets, scratch.bead);
  } else {
    draw(ctx, scene.chart, t, view, assets, scratch.classic);
  }
}
