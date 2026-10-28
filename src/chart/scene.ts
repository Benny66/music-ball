import { buildChart, type BuildOptions } from './build.ts';
import { buildBeadChoreography, impactsFromNotes, type BeadPath } from './bead.ts';
import type { AnalysisResult, Chart } from '../types.ts';

export type Motion = 'bead' | 'classic';
export type MotionChoice = 'auto' | 'bead' | 'classic';

export interface SceneOptions extends BuildOptions {
  motion?: MotionChoice;
  /** 玻璃珠撞击抽稀间隔（秒） */
  beadMinGap?: number;
}

export interface Scene {
  chart: Chart;
  /** 音符驱动 + 玻璃珠时存在；经典运动为 null */
  bead: BeadPath | null;
  motion: Motion;
  /** 给 UI/自检的运动选择说明 */
  reason: string;
}

/**
 * 构建一帧画面所需的全部数据。
 *
 * 经典 chart 始终构建：它提供时间轴、统计、经典回退与音频时长。
 * 只有音符驱动且选择玻璃珠时才额外烘焙 BeadPath；网格/鼓组保持经典。
 */
export function buildScene(
  analysis: AnalysisResult,
  opts: SceneOptions = {},
): Scene {
  const { motion = 'auto', beadMinGap = 0.7, ...chartOpts } = opts;
  const chart = buildChart(analysis, chartOpts);
  const choice = motion;

  if (choice === 'classic') {
    return { chart, bead: null, motion: 'classic', reason: '经典运动' };
  }
  if (!opts.noteSource || opts.noteSource.length === 0) {
    return {
      chart,
      bead: null,
      motion: 'classic',
      reason:
        choice === 'bead' ? '网格/鼓组暂用经典运动' : '经典运动（网格/鼓组）',
    };
  }
  if (!chart.noteDriven) {
    return {
      chart,
      bead: null,
      motion: 'classic',
      reason: choice === 'bead' ? '音符不足，回退经典运动' : '经典运动（音符不足）',
    };
  }

  try {
    const impacts = impactsFromNotes(opts.noteSource, {
      minGap: beadMinGap,
    });
    if (impacts.length < 2) {
      return { chart, bead: null, motion: 'classic', reason: '音符不足，回退经典运动' };
    }
    const bead = buildBeadChoreography(impacts, {
      duration: chart.duration,
      trackW: chart.trackW,
      viewH: chart.viewH,
    });
    return {
      chart,
      bead,
      motion: 'bead',
      reason: `玻璃珠 · ${impacts.length} 次撞击`,
    };
  } catch (err) {
    console.warn('[scene] 玻璃珠路径失败，回退经典', err);
    return {
      chart,
      bead: null,
      motion: 'classic',
      reason: `玻璃珠路径失败，回退经典：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
