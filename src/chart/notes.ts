import { clamp } from '../util/math.ts';
import type { Band, Beat } from '../types.ts';
import type { MelodyNote } from '../analysis/melody.ts';

/**
 * 音符驱动的板子生成（钢琴 / 器乐用）。
 *
 * 钢琴曲没有鼓，「节奏」就是音符本身——而 basic-pitch 给的音符起点实测精度
 * 中位 3ms、p90 7ms（234 个真值音符 ±50ms 命中率 100%），比节拍网格更适合做板子。
 *
 * 与鼓组驱动的差异：
 *   - 板子落在**音符起点**上，而不是节拍网格上 → 切分、rubato、装饰音都能看到
 *   - 和弦（同时起音）合成一块更宽的板 → 和声的「重量」可视化
 *   - 颜色按音区映射（低音青/中音粉/高音金），而不是按不存在的鼓组
 */

export interface NoteBoardOpts {
  /** 同时起音的音合并为一块板（和弦）的窗口（秒） */
  chordWindow?: number;
  /** 最小拍间隔（秒），与 buildChart 的 dtMin 一致 */
  minGap?: number;
  /** 忽略短于这个时值的装饰音（秒） */
  minDur?: number;
  /** 起始时间偏移（让第一块板对齐 T0） */
  tOffset?: number;
}

const DEF = { chordWindow: 0.06, minGap: 0.125, minDur: 0.08, tOffset: 0 };

/** 音区 → 颜色分类：低音青、中音粉、高音金 */
function bandByPitch(minMidi: number, maxMidi: number): Band {
  if (minMidi < 48) return 'kick'; // 低音区（含左手八度）
  if (maxMidi > 76) return 'hat'; // 高音区（旋律亮音）
  return 'snare'; // 中音区
}

/**
 * 音符事件 → 板子序列。
 * 同时起音（窗口内）的音合成一块和弦板：音越多、时值越长，板越宽、弹得越高。
 */
export function boardsFromNotes(
  notes: MelodyNote[],
  opts: NoteBoardOpts = {},
): Beat[] {
  const cfg = { ...DEF, ...opts };
  if (notes.length === 0) return [];

  // 1) 过滤装饰音、排序
  const usable = notes
    .filter((n) => n.end - n.start >= cfg.minDur && Number.isFinite(n.start))
    .map((n) => ({ ...n, t: n.start + cfg.tOffset }))
    .sort((a, b) => a.t - b.t || b.midi - a.midi);
  if (usable.length === 0) return [];

  // 2) 和弦分组：起点差 < 窗口 的音合为一板
  interface Chord {
    t: number;
    minMidi: number;
    maxMidi: number;
    count: number;
    isMelody: boolean;
    dur: number;
  }
  const chords: Chord[] = [];
  let cur: Chord | null = null;
  for (const n of usable) {
    if (cur && n.t - cur.t < cfg.chordWindow) {
      cur.minMidi = Math.min(cur.minMidi, n.midi);
      cur.maxMidi = Math.max(cur.maxMidi, n.midi);
      cur.count++;
      cur.isMelody = cur.isMelody || n.amplitude >= 0.8;
      cur.dur = Math.max(cur.dur, n.end - n.start);
      continue;
    }
    cur = {
      t: n.t,
      minMidi: n.midi,
      maxMidi: n.midi,
      count: 1,
      isMelody: n.amplitude >= 0.8,
      dur: n.end - n.start,
    };
    chords.push(cur);
  }

  // 3) 和弦 → 板（power 由和声规模与时值决定）
  const out: Beat[] = [];
  let prevT = -1e9;
  for (const c of chords) {
    const t = c.t;
    if (t - prevT < cfg.minGap) {
      // 比最小间隔还密：并到前一块（更新它的规模，板变宽）
      const last = out[out.length - 1];
      if (last) last.power = clamp(last.power + 0.12, 0, 1);
      continue;
    }
    prevT = t;

    const span = c.count >= 3 ? 0.85 : c.count === 2 ? 0.65 : 0.42;
    const long = clamp(c.dur / 1.2, 0, 0.25);
    const power = clamp(span * 0.8 + long, 0.15, 1);

    out.push({
      t,
      power,
      band: bandByPitch(c.minMidi, c.maxMidi),
      synthetic: false,
    });
  }
  return out;
}
