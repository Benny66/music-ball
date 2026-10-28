import { clamp, lerp } from '../util/math.ts';
import { hashFloat } from '../util/prng.ts';
import type { Band, BoardKind } from '../types.ts';

/**
 * 板子几何与风格派生的唯一真相。
 *
 * 放在 chart 层（而不是 render 层）是因为「弹跳高度 h 的上界」要依赖板的垂直半高，
 * 而 h 又决定 g —— 也就是渲染参数反过来约束了运动学。两边共用同一份常量与
 * boardHalfH()，就不会出现「预览夹得住、导出夹不住」这类分叉。
 */

export const DEG = Math.PI / 180;

/** 世界单位常量 */
export const BALL_R = 26;
export const BOARD_H = 18;
export const BOARD_HALF_MIN = 52;
export const BOARD_HALF_MAX = 132;
/** 倾角上限。再大就会让人看出「板子在横向拖了球一把」这种不存在的力 */
export const BOARD_TILT_MAX = 16 * DEG;
/** 撞击瞬间板子横向膨胀的比例（draw 用它，build 用它算边界） */
export const BOARD_HIT_BULGE = 1.06;

/**
 * 板子旋转后的垂直半高（世界单位）。
 * h 上界、渲染裁剪、辉光 bbox 三处必须共用这一个函数 —— 倾斜后它会从 9 涨到 50，
 * 各写一份必然对不上。
 */
export const boardHalfH = (halfW: number, angle: number, thick: number): number =>
  halfW * Math.abs(Math.sin(angle)) + (thick / 2) * Math.abs(Math.cos(angle));

/** 横向轨迹允许的半宽：板子在撞击膨胀 + 最大倾角下都不许捅出赛道 */
export const trackLimit = (trackW: number): number => {
  const wMax = BOARD_HALF_MAX * BOARD_HIT_BULGE;
  const tHalf = BOARD_H / 2;
  const xMax = Math.max(
    wMax * Math.cos(BOARD_TILT_MAX) + tHalf * Math.sin(BOARD_TILT_MAX),
    wMax,
  );
  return trackW / 2 - Math.ceil(xMax);
};

/** 各鼓组在「分量感」上的权重。底鼓最有分量，踩镲最轻。 */
export const BAND_WEIGHT: Record<Band, number> = { kick: 1.0, snare: 0.72, hat: 0.35 };

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0.5;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 把原始 power 归一化后再混鼓组权重。
 *
 * power 的定义是 env/全曲峰值，实测同一首歌里 98% 的拍都 > 0.6（p50 = 0.8），
 * 直接拿来驱动弧线高度会让所有弧线挤在同一个值上，动态范围完全消失。
 * 所以先按 p20/p90 拉开到 [0,1]，再和 band 权重混合。
 */
export function buildWeights(
  nodes: { power: number; band: Band; ordinal: number }[],
): Float64Array {
  const realPowers = nodes.filter((n) => n.ordinal >= 0).map((n) => n.power);
  const p20 = percentile(realPowers, 0.2);
  const p90 = percentile(realPowers, 0.9);
  const span = Math.max(0.05, p90 - p20);

  const out = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const pNorm = clamp((n.power - p20) / span, 0, 1);
    // 响度占七成、鼓组占三成：踩镲天生轻，底鼓天生重，但响度才是主要的强弱信号
    out[i] = clamp(0.7 * pNorm + 0.3 * BAND_WEIGHT[n.band], 0, 1);
  }
  return out;
}

/** 小节第一拍额外加成：让"每小节第一下"明显更高、更宽、更炸 */
export const DOWNBEAT_BOOST = 0.3;

export interface BarInfo {
  /** 每小节几拍 */
  L: number;
  /** 相位：ordinal % L === phase 的那一拍是小节第一拍 */
  phase: number;
  score: number;
}

/** 某个小节位置上「应该」是什么鼓组；null 表示「不该是底鼓」 */
function expectedBand(L: number, pos: number): Band | null {
  if (L === 4) return pos === 0 || pos === 2 ? 'kick' : 'snare';
  return pos === 0 ? 'kick' : null;
}

/**
 * 估计小节相位。
 *
 * 两个关键决定：
 * 1. 用**真实拍序号**而不是时间算相位。变速曲里中位 Δt 和真实拍长差 30%+，
 *    按时间算 24 秒后就能漂 13 拍。
 * 2. 用 **band 模式**而不是 power 打分。实测 power 在各拍之间几乎是平的
 *    （p10 0.68 → p90 0.91），argmax 会选错；而 band 模式在 4/4 里是
 *    「0/2 纯 kick、1/3 snare+hat」，干净得多。
 */
export function estimateBar(
  nodes: { ordinal: number; band: Band; power: number }[],
): BarInfo {
  const real = nodes.filter((n) => n.ordinal >= 0);
  if (real.length < 8) return { L: 4, phase: 0, score: 0 };

  let best: BarInfo = { L: 4, phase: 0, score: -Infinity };

  for (const L of [4, 3]) {
    for (let p = 0; p < L; p++) {
      let sum = 0;
      for (const n of real) {
        const pos = (((n.ordinal - p) % L) + L) % L;
        const want = expectedBand(L, pos);
        const ok = want === null ? n.band !== 'kick' : n.band === want;
        sum += (ok ? 1 : -0.35) * n.power;
      }
      const score = sum / real.length;
      // 严格大于 → 平局时保留先出现者（L=4 优先、相位小的优先），保证可复现
      if (score > best.score + 1e-9) best = { L, phase: p, score };
    }
  }
  return best;
}

/**
 * 特殊板型分配。用真实拍序号 + hash 决定，纯确定性。
 *
 * 每种特殊板每 8 个真实拍最多一个；序号连续的两块板绝不都是特殊的。
 * ordinal 必须跨越 merge/stride/split 原样保留 —— 重新编号会让 stride=2 时
 * 重拍周期错 4 倍。
 */
export function assignKinds(
  nodes: { ordinal: number }[],
  seed: number,
  drama: number,
  count = 8,
): BoardKind[] {
  const kinds: BoardKind[] = new Array(nodes.length).fill('normal');
  if (drama < 0.25) return kinds;

  const threshold = 0.25 + 0.35 * drama;
  let last = -1e9;

  for (let i = 0; i < nodes.length; i++) {
    const ord = nodes[i].ordinal;
    if (ord < 0) continue;
    if (ord - last < count) continue;
    if (hashFloat(ord, seed ^ 0x5f3a) > threshold) continue;

    let kind: BoardKind = hashFloat(ord, seed ^ 0x9a1) < 0.5 ? 'spring' : 'break';
    // 最后一块板没有「离开它的那一段」，弹簧无意义
    if (kind === 'spring' && i === nodes.length - 1) kind = 'break';

    kinds[i] = kind;
    last = ord;
  }
  return kinds;
}

/**
 * 音乐强弱 → 本段弹跳高度。
 * drama=0 时恒为 Δy/3，精确复刻旧实现（等价于 g = 6V/Δt、恢复系数 0.5）。
 *
 * 区间 0.12..0.68：弱拍几乎贴着板掠过，重拍高高弹起 —— 屏幕上的顶点高度能差 5 倍。
 */
export function bounceRatio(w: number, drama: number): number {
  return lerp(1 / 3, 0.12 + 0.56 * clamp(w, 0, 1), drama);
}

/** 音乐强弱 → 板宽 / 板厚 */
export const boardHalfW = (w: number): number =>
  lerp(BOARD_HALF_MIN, BOARD_HALF_MAX, clamp(w, 0, 1));
export const boardThick = (accent: number): number =>
  BOARD_H * lerp(0.6, 1.8, clamp(accent, 0, 1));
