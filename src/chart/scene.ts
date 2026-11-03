import { buildChart, type BuildOptions } from './build.ts';
import {
  buildBeadChoreography,
  impactsFromBeats,
  type BeadPath,
} from './bead.ts';
import { buildNaturalPath, type NaturalPath } from './natural.ts';
import { selectSurfaceImpacts } from './salience.ts';
import type { AnalysisResult, Chart } from '../types.ts';

export type Motion = 'natural' | 'bead' | 'classic';
export type MotionChoice = 'auto' | 'bead' | 'classic';

export interface SceneOptions extends BuildOptions {
  motion?: MotionChoice;
  /** 拍点撞击抽稀间隔（秒）。玻璃珠需要 >0.9s 才够滚动+掉落 */
  gridMinGap?: number;
}

export interface Scene {
  chart: Chart;
  /** 音符驱动：自然滚动玻璃珠 */
  natural: NaturalPath | null;
  /** 网格/鼓组：拍点玻璃珠 */
  bead: BeadPath | null;
  motion: Motion;
  /** 给 UI/自检的运动选择说明 */
  reason: string;
}

/**
 * 构建一帧画面所需的全部数据。
 *
 * 经典 chart 始终构建：它提供时间轴、统计、经典回退与音频时长。
 * 运动默认玻璃珠：有音符走表面节奏 + 自然滚动，没有音符走抽稀拍点；
 * 经典只在手动选择或路径构建失败时回退。
 */
export function buildScene(
  analysis: AnalysisResult,
  opts: SceneOptions = {},
): Scene {
  const { motion = 'auto', gridMinGap = 0.9, ...chartOpts } = opts;
  const chart = buildChart(analysis, chartOpts);

  if (motion === 'classic') {
    return { chart, natural: null, bead: null, motion: 'classic', reason: '经典运动' };
  }

  let noteIssue = '';
  if (opts.noteSource && opts.noteSource.length > 0) {
    if (!chart.noteDriven) {
      noteIssue = '音符不足';
    } else {
      try {
        const impacts = selectSurfaceImpacts(opts.noteSource, {
          duration: chart.duration,
          beats: analysis.beats,
          onsets: analysis.onsets,
        });
        if (impacts.length >= 2) {
          const natural = buildNaturalPath(impacts, {
            duration: chart.duration,
            trackW: chart.trackW,
            viewH: chart.viewH,
          });
          return {
            chart,
            natural,
            bead: null,
            motion: 'natural',
            reason: `玻璃珠 · 表面节奏 ${impacts.length} 次撞击`,
          };
        }
        noteIssue = '音符撞击不足';
      } catch (err) {
        console.warn('[scene] 自然滚动路径失败，改用拍点', err);
        noteIssue = '自然滚动失败';
      }
    }
  }

  try {
    const impacts = impactsFromBeats(analysis.beats, { minGap: gridMinGap });
    if (impacts.length >= 2) {
      const bead = buildBeadChoreography(impacts, {
        duration: chart.duration,
        trackW: chart.trackW,
        viewH: chart.viewH,
      });
      return {
        chart,
        natural: null,
        bead,
        motion: 'bead',
        reason: `玻璃珠 · 拍点 ${impacts.length} 次撞击${noteIssue ? `（${noteIssue}，改用拍点）` : ''}`,
      };
    }
    noteIssue = noteIssue || '拍点不足';
  } catch (err) {
    console.warn('[scene] 拍点玻璃珠路径失败，回退经典', err);
    return {
      chart,
      natural: null,
      bead: null,
      motion: 'classic',
      reason: `拍点玻璃珠失败，回退经典：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    chart,
    natural: null,
    bead: null,
    motion: 'classic',
    reason: `${noteIssue || '拍点不足'}，回退经典运动`,
  };
}
