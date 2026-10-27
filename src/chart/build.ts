import { bakeReflectionXs } from './physics.ts';
import { clamp } from '../util/math.ts';
import { mulberry32 } from '../util/prng.ts';
import {
  BALL_R,
  BOARD_H,
  BOARD_TILT_MAX,
  DOWNBEAT_BOOST,
  assignKinds,
  boardHalfH,
  boardHalfW,
  boardThick,
  bounceRatio,
  buildWeights,
  estimateBar,
  trackLimit,
} from './styles.ts';
import type { AnalysisResult, Band, Board, BoardKind, Chart, Segment } from '../types.ts';

export interface BuildOptions {
  /** 基准下落速度（世界单位/秒）。这是观众感知到的「节奏快慢」的锚点。 */
  V?: number;
  /** 赛道宽（世界单位），等于可见视口宽 */
  trackW?: number;
  viewH?: number;
  seed?: number;
  /** 最小拍间隔，小于它两块板肉眼无法分辨，直接合并 */
  dtMin?: number;
  /** 最大拍间隔，大于它会把长间奏细分出 ghost 结点 */
  dtMax?: number;
  /** 每 N 拍放一块板。2 = 只取隔拍，适合很快的歌。 */
  stride?: number;
  /** 在 t=0 之前补几块「已经路过」的板，让开头构图不空 */
  preRoll?: number;
  /**
   * 变化幅度 0..1。0 = 弧线恒定 1/3、板子水平、无特殊板（完全退回旧观感）。
   * 一个旋钮控住全部变化，也是出问题时的逃生舱。
   */
  drama?: number;
  /** 物理自由度 0..1。1 = 倾角由「本拍想横移多少」反解（默认）；0 = 完全按反射定律 */
  dof?: number;
}

export const DEFAULT_V = 520;
export const DEFAULT_TRACK_W = 900;
export const DEFAULT_VIEW_H = 1600;
const DEFAULTS = {
  V: DEFAULT_V,
  trackW: DEFAULT_TRACK_W,
  viewH: DEFAULT_VIEW_H,
  seed: 0x5eed,
  dtMin: 0.125,
  dtMax: 1.0,
};

interface Node {
  t: number;
  power: number;
  band: Band;
  synthetic: boolean;
  ghost: boolean;
  /** 真实拍序号。外推/预卷/ghost 为 -1，不参与小节相位与特殊板分配。 */
  ordinal: number;
}

/**
 * 把拍点表变成可直接求值的运动学图表。
 *
 * 全程是纯函数：同一份 AnalysisResult + 同一组参数 → 逐字节相同的 Chart。
 * 没有物理模拟，没有随机漂移，所以 seek 到任意时刻都能算出与顺序播放完全一致的画面。
 */
export function buildChart(a: AnalysisResult, opt: BuildOptions = {}): Chart {
  const V = opt.V ?? DEFAULTS.V;
  const trackW = opt.trackW ?? DEFAULTS.trackW;
  const viewH = opt.viewH ?? DEFAULTS.viewH;
  const seed = opt.seed ?? DEFAULTS.seed;
  const dtMin = opt.dtMin ?? DEFAULTS.dtMin;
  const dtMax = opt.dtMax ?? DEFAULTS.dtMax;
  const drama = clamp(opt.drama ?? 0.7, 0, 1);
  const duration = Math.max(0.5, a.duration);

  // 真实拍按顺序编号；外推/预卷/ghost 一律 -1。
  // 这个序号要一路活到 Board 上，且跨越 merge/stride/split 绝不重新编号。
  let ord = -1;
  let nodes: Node[] = a.beats
    .filter((b) => Number.isFinite(b.t))
    .map((b) => ({
      t: b.t,
      power: b.power,
      band: b.band,
      synthetic: b.synthetic,
      ghost: false,
      ordinal: b.synthetic ? -1 : ++ord,
    }));

  if (nodes.length < 2) {
    // 兜底：分析彻底失败也要有画面
    nodes = [
      { t: 0, power: 0.5, band: 'kick' as Band, synthetic: true, ghost: false, ordinal: -1 },
      { t: duration, power: 0.5, band: 'kick' as Band, synthetic: true, ghost: false, ordinal: -1 },
    ];
  }

  nodes = mergeTooClose(nodes, dtMin);

  const stride = Math.max(1, Math.round(opt.stride ?? 1));
  if (stride > 1 && nodes.length > 2) {
    const last = nodes[nodes.length - 1];
    const thinned = nodes.filter((_, i) => i % stride === 0);
    if (thinned[thinned.length - 1] !== last) thinned.push(last);
    nodes = thinned;
  }

  // 抽稀之后再细分，否则 stride 会让间隔翻倍却没人补 ghost 结点
  nodes = splitTooFar(nodes, dtMax);

  // 预卷：在 t=0 之前补若干块「已经路过」的板。
  // 否则视频第一秒的上半屏完全是空的 —— 相机会把球放在 58% 高度，
  // 而它上方本该有历史板滚动出去。补上之后从第 0 帧起构图就是满的。
  nodes = prependPreRoll(nodes, Math.max(0, Math.round(opt.preRoll ?? 9)));

  const segCount = nodes.length - 1;
  const dts = new Float64Array(segCount);
  for (let i = 0; i < segCount; i++) dts[i] = nodes[i + 1].t - nodes[i].t;

  // 横向可用范围 = 半个赛道宽 − 板在「撞击膨胀 + 最大倾角」下的最大水平投影
  const xs = buildTrackXs(nodes, trackLimit(trackW), seed);
  const ms = buildTangents(nodes, xs, trackLimit(trackW));

  const weights = buildWeights(nodes);
  const bar = estimateBar(nodes);
  const kinds = assignKinds(nodes, seed, drama);
  // 出画判断在 world 单位做：preview(1280/0.8) 与 export(1920/1.2) 的
  // 0.58*viewH 都是 928，结论必然一致。用 view.h 或 scale 算会分叉。
  const screenD = Math.max(40, 0.58 * viewH - 220);

  const segs: Segment[] = [];
  const boards: Board[] = [];
  let y = 0;

  for (let i = 0; i < segCount; i++) {
    const dt = dts[i];
    if (!(dt > 0) || !Number.isFinite(dt)) continue;
    const dy = V * dt;

    // ---- 板 i 的样式（全部由音乐强弱 w 驱动）----
    const ordinal = nodes[i].ordinal;
    const barPos = ordinal >= 0 ? (((ordinal - bar.phase) % bar.L) + bar.L) % bar.L : -1;
    // 小节第一拍额外加成 → 更大更厚、弹得更高、特效更炸
    const w = clamp(weights[i] + (barPos === 0 ? DOWNBEAT_BOOST : 0), 0, 1);
    const accent = w;
    const halfW = boardHalfW(w);
    const thick = boardThick(accent);

    // 倾角顺着球的入射方向。vx = 结点 i 处的横向切线（= 上一段的 m1），
    // 用 V 而不是 vy 做分母 —— vy 里 g·Δt/2 被伪重力撑到 2V~4V，
    // 用它会算出 1~3° 的倾角，肉眼为零。
    // clamp 必须在乘 drama 之后 —— 之前写成 clamp(...) * drama，实际增益只有
    // 0.7×0.7 = 0.49，p90 顶死在 10.5°，等于白白浪费了三分之一的可用倾角。
    const angle =
      i === 0
        ? 0
        : clamp(0.75 * drama * Math.atan2(ms[i], V), -BOARD_TILT_MAX, BOARD_TILT_MAX);

    // ---- 本段弹跳高度 → 反解重力 ----
    let kind: BoardKind = kinds[i];
    const baseH = bounceHeight(dy, w, 'normal', drama);
    let h = clampBounce(bounceHeight(dy, w, kind, drama), dy, boards, segs, screenD);

    // 弹簧被上界夹到几乎没有增幅就降级，否则"弹簧"名不副实
    if (kind === 'spring' && h < 1.15 * baseH) {
      kind = 'normal';
      h = clampBounce(baseH, dy, boards, segs, screenD);
    }

    // g 必须由本段的 dt 反解（不能用平滑后的 dt），否则"顶点高度 = h"
    // 和 vy(0) = −√(2gh) 这两条性质都不成立。
    const a = Math.sqrt(h);
    const b = Math.sqrt(h + dy);
    const g = (2 * (a + b) * (a + b)) / (dt * dt);

    boards.push({
      index: boards.length,
      t: nodes[i].t,
      x: xs[i],
      y,
      band: nodes[i].band,
      power: nodes[i].power,
      ghost: nodes[i].ghost,
      synthetic: nodes[i].synthetic,
      angle,
      halfW,
      thick,
      kind,
      ordinal,
      barPos,
      accent,
    });

    segs.push({
      index: segs.length,
      t0: nodes[i].t,
      t1: nodes[i + 1].t,
      y0: y,
      dy,
      g,
      h,
      x0: xs[i],
      x1: xs[i + 1],
      m0: ms[i],
      m1: ms[i + 1],
      band: nodes[i + 1].band,
      power: nodes[i + 1].power,
      ghost: nodes[i + 1].ghost,
      synthetic: nodes[i + 1].synthetic,
    });
    y += dy;
  }

  // ---- 横向物理烘焙：反射定律 + steering ----
  // 纵向本来就是严格抛物线（匀加速），横向补上反射定律后球的运动就是物理轨迹。
  // 倾角必须由「本拍想横移多少」反解 —— 纯物理的反射会把球甩出赛道：
  // 撞击速度 4.45V、θ=16° 时半个拍间隔就横移 613 世界单位，而赛道半宽只有 307。
  if (drama > 0 && segs.length > 0) {
    const bake = bakeReflectionXs(segs, xs, {
      dof: clamp(opt.dof ?? 1, 0, 1),
      limit: trackLimit(trackW),
      maxTilt: BOARD_TILT_MAX,
    });
    // 板的 x 与倾角用烘焙结果 —— 「板 x = 球 x」的唯一真相
    boards[0].x = segs[0].x0;
    boards[0].angle = bake.angles[0] ?? 0;
    for (let i = 0; i < segs.length; i++) {
      const b = boards[i + 1];
      if (b) {
        b.x = segs[i].x1;
        b.angle = bake.angles[i] ?? 0;
      }
    }
  }

  // 收尾板：最后一个拍点所在的板
  const lastNode = nodes[nodes.length - 1];
  {
    const ordinal = lastNode.ordinal;
    const barPos = ordinal >= 0 ? (((ordinal - bar.phase) % bar.L) + bar.L) % bar.L : -1;
    const lastW = clamp(
      (weights[weights.length - 1] ?? 0.5) + (barPos === 0 ? DOWNBEAT_BOOST : 0),
      0,
      1,
    );
    const accent = lastW;
    const prevMs = ms.length > 0 ? ms[ms.length - 1] : 0;
    boards.push({
      index: boards.length,
      t: lastNode.t,
      x: xs[xs.length - 1],
      y,
      band: lastNode.band,
      power: lastNode.power,
      ghost: lastNode.ghost,
      synthetic: lastNode.synthetic,
      angle: clamp(0.7 * Math.atan2(prevMs, V), -BOARD_TILT_MAX, BOARD_TILT_MAX) * drama,
      halfW: boardHalfW(lastW),
      thick: boardThick(accent),
      kind: kinds[kinds.length - 1] ?? 'normal',
      ordinal,
      barPos,
      accent,
    });
  }

  if (segs.length === 0) {
    const dy = V * duration;
    const h = dy / 3;
    const a = Math.sqrt(h);
    const b = Math.sqrt(h + dy);
    segs.push({
      index: 0,
      t0: 0,
      t1: duration,
      y0: 0,
      dy,
      g: (2 * (a + b) * (a + b)) / (duration * duration),
      h,
      x0: 0,
      x1: 0,
      m0: 0,
      m1: 0,
      band: 'kick',
      power: 0.5,
      ghost: false,
      synthetic: true,
    });
  }

  let synthetic = 0;
  let ghost = 0;
  for (const s of segs) {
    if (s.synthetic) synthetic++;
    if (s.ghost) ghost++;
  }

  return {
    segs,
    boards,
    duration,
    trackW,
    viewH,
    seed,
    stats: {
      detected: a.beats.reduce((k, b) => (b.synthetic ? k : k + 1), 0),
      synthetic,
      ghost,
      bpm: a.bpm,
      barLen: bar.L,
      barPhase: bar.phase,
    },
  };
}

/** 音乐强弱 → 本段弹跳高度（弹簧板再放大 1.8 倍） */
function bounceHeight(dy: number, w: number, kind: BoardKind, drama: number): number {
  const base = dy * bounceRatio(w, drama);
  return kind === 'spring' ? base * 1.8 : base;
}

/**
 * h 的四道上界，缺一个就穿帮：
 *  ① 不许越过上一块板（倾斜后板的垂直半高从 9 涨到 50，这一项很吃紧）
 *  ② 不许顶出画面（world 单位，preview 与 export 共用同一个结论）
 *  ③ 相对上界 0.9·Δy
 *  ④ 下限保底可见，但绝不突破 cap —— h<0 会让 sqrt 产生 NaN，球会直接消失
 */
function clampBounce(
  h: number,
  dy: number,
  boards: Board[],
  segs: Segment[],
  screenD: number,
): number {
  const prev = boards[boards.length - 1];
  const prevDy = segs.length > 0 ? segs[segs.length - 1].dy : dy;
  const prevHalfH = prev ? boardHalfH(prev.halfW, prev.angle, prev.thick) : BOARD_H / 2;
  const capGeom = prevDy - BALL_R - prevHalfH - 10;

  const capScreen =
    dy <= 4 * screenD
      ? Math.pow(Math.sqrt(screenD) - dy / (4 * Math.sqrt(screenD)), 2)
      : 0;

  const cap = Math.max(0, Math.min(capGeom, capScreen, 0.9 * dy));
  const lo = Math.min(0.06 * dy, 8, cap);
  return clamp(h, lo, cap);
}

/** 合并过密的拍：板率上限 8 块/秒 */
function mergeTooClose(nodes: Node[], dtMin: number): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (last && n.t - last.t < dtMin) {
      // 保留更强的那一拍，但要确认替换后不会和前一个又贴太近
      const before = out[out.length - 2];
      if (n.power > last.power && (!before || n.t - before.t >= dtMin)) {
        out[out.length - 1] = n;
      }
      continue;
    }
    out.push(n);
  }
  return out;
}

/** 在开头补若干块已路过的板，让第 0 帧的上半屏不空 */
function prependPreRoll(nodes: Node[], count: number): Node[] {
  if (count <= 0 || nodes.length < 2) return nodes;
  const T = nodes[1].t - nodes[0].t;
  if (!(T > 0)) return nodes;
  const head = nodes[0];
  const out: Node[] = [];
  for (let k = count; k >= 1; k--) {
    out.push({
      t: head.t - k * T,
      power: 0.4,
      band: head.band,
      synthetic: true,
      ghost: false,
      ordinal: -1,
    });
  }
  return out.concat(nodes);
}

/** 长间奏细分：超过 dtMax 的间隔插入 ghost 结点，保持下落速度恒定 */function splitTooFar(nodes: Node[], dtMax: number): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < nodes.length; i++) {
    out.push(nodes[i]);
    const next = nodes[i + 1];
    if (!next) break;
    const dt = next.t - nodes[i].t;
    if (dt > dtMax) {
      const k = Math.ceil(dt / dtMax);
      for (let j = 1; j < k; j++) {
        const t = nodes[i].t + (dt * j) / k;
        out.push({
          t,
          power: nodes[i].power * 0.5,
          band: nodes[i].band,
          synthetic: nodes[i].synthetic && next.synthetic,
          ghost: true,
          ordinal: -1,
        });
      }
    }
  }
  return out;
}

/**
 * 横向轨迹：带方向惯性的随机游走 + 撞墙反射。
 * 用 Mulberry32 保证同 seed 完全可复现。
 */
function buildTrackXs(nodes: Node[], limit: number, seed: number): Float64Array {
  const n = nodes.length;
  const xs = new Float64Array(n);
  const rng = mulberry32(seed);
  if (n === 0) return xs;

  // 分段方向性扫掠：连续 3–5 拍朝同一方向斜着下，而不是每拍左右乱跳。
  // 旧的 AR(1) 随机游走方向自相关只有 0.86，符号翻得太快，观感是一根直柱；
  // 而且 maxStep 恰好等于一个板宽，球横向永远跨不出自己的光晕。
  let x = (rng() * 2 - 1) * limit * 0.3;
  let dir = rng() < 0.5 ? -1 : 1;

  let i = 0;
  let guard = 0;
  while (i < n && guard++ < n * 4) {
    const run = rng() < 0.6 ? 3 : 4;

    // 靠近墙时强制朝内
    if (x > limit * 0.55) dir = -1;
    else if (x < -limit * 0.55) dir = 1;
    else if (rng() > 0.6) dir = -dir;

    const sweep = limit * 0.62 * (0.9 + 0.2 * rng());
    // 终点先夹到界内，再按 sin 钟形分布摊到每拍 —— 这样一段扫掠不会中途撞墙折返
    let end = x + dir * sweep;
    const bound = limit * 0.88;
    if (end > bound) end = bound;
    if (end < -bound) end = -bound;
    const travel = Math.abs(end - x);
    const sdir = Math.sign(end - x) || dir;
    const scale = sweep > 0 ? travel / sweep : 0;

    for (let s = 0; s < run && i < n; s++, i++) {
      // 两端小、中间大：方向切换发生在横向速度最低点，观感是缓缓拐弯
      const shape = Math.sin((Math.PI * (s + 0.5)) / run);
      x += sdir * sweep * shape * scale * (0.94 + 0.12 * rng());
      xs[i] = clamp(x, -limit, limit);
    }
  }
  return xs;
}

/**
 * 结点切线的 Catmull-Rom 近似。用它做横向三次 Hermite，
 * u=0/1 仍严格给出 x0/x1（落点精确），但段边界处横向速度连续，
 * 不会出现「球在板上瞬间横向折返」的闪断感。
 *
 * 切线必须限幅：吸附之后 Δt 的非均匀性会到 ±15%，不加限幅的三次 Hermite
 * 会在段内过冲，球被甩出赛道。
 */
function buildTangents(nodes: Node[], xs: Float64Array, limit: number): Float64Array {
  const n = nodes.length;
  const m = new Float64Array(n);
  const cap = limit * 1.6;
  for (let i = 0; i < n; i++) {
    const j0 = Math.max(0, i - 1);
    const j1 = Math.min(n - 1, i + 1);
    const dt = nodes[j1].t - nodes[j0].t;
    const v = dt > 1e-6 ? (xs[j1] - xs[j0]) / dt : 0;
    m[i] = clamp(v, -cap, cap);
  }
  return m;
}
