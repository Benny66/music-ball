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

/** 把旋律音折回 C4–C6，避免 basic-pitch 的八度/谐波把轮廓带出可感知的音区 */
function foldMidi(m: number): number {
  while (m > 84) m -= 12;
  while (m < 60) m += 12;
  return m;
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
    maxAmp: number;
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
      cur.maxAmp = Math.max(cur.maxAmp, n.amplitude);
      continue;
    }
    cur = {
      t: n.t,
      minMidi: n.midi,
      maxMidi: n.midi,
      count: 1,
      isMelody: n.amplitude >= 0.8,
      dur: n.end - n.start,
      maxAmp: n.amplitude,
    };
    chords.push(cur);
  }

  // 3) 和弦 → 板（power 由力度、和声规模与时值共同决定）
  const out: Beat[] = [];
  const strengths: number[] = [];
  const strengthOf = (c: Chord): number =>
    c.maxAmp + 0.05 * Math.min(3, c.count) + 0.03 * Math.min(1, c.dur);

  // 力度按全曲分位数归一化，避免整首曲子都贴在最低或最高档
  const amps = chords.map((c) => c.maxAmp).sort((a, b) => a - b);
  const ampLo = amps[Math.min(amps.length - 1, Math.floor(amps.length * 0.1))] ?? 0;
  const ampHi = amps[Math.min(amps.length - 1, Math.floor(amps.length * 0.9))] ?? ampLo;
  const normAmp = (a: number): number =>
    ampHi > ampLo ? clamp((a - ampLo) / (ampHi - ampLo), 0, 1) : 0.5;

  for (const c of chords) {
    const t = c.t;
    const band = bandByPitch(c.minMidi, c.maxMidi);
    const spanNorm = (c.count >= 3 ? 1 : c.count === 2 ? 0.65 : 0.42) / 0.85;
    const longNorm = clamp(c.dur / 1.2, 0, 1);
    const power = clamp(0.55 * normAmp(c.maxAmp) + 0.3 * spanNorm + 0.15 * longNorm, 0.12, 1);
    const dyn = clamp(c.maxAmp, 0, 1);
    const strength = strengthOf(c);

    const last = out[out.length - 1];
    if (last && t - last.t < cfg.minGap) {
      const before = out[out.length - 2];
      const lastStrength = strengths[strengths.length - 1];
      // 强起音优先：能挪到当前起音就挪过去，否则至少把它的力度并进前一块
      if (strength > lastStrength && (!before || t - before.t >= cfg.minGap)) {
        last.t = t;
        last.power = clamp(Math.max(last.power, power) + 0.08, 0, 1);
        last.band = band;
        last.midi = foldMidi(c.maxMidi);
        last.dyn = Math.max(last.dyn ?? 0, dyn);
        strengths[strengths.length - 1] = strength;
      } else {
        last.power = clamp(last.power + 0.12, 0, 1);
      }
      continue;
    }

    out.push({
      t,
      power,
      band,
      synthetic: false,
      midi: foldMidi(c.maxMidi),
      dyn,
    });
    strengths.push(strength);
  }
  return out;
}
