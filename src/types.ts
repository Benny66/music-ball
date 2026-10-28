/**
 * 全局共享类型。这个文件不允许 import 任何 DOM 类型 —— 分析层与图表层要能在 Node 里直接跑。
 */

/** 打击乐频段分类 */
export type Band = 'kick' | 'snare' | 'hat';

/** 板子的特殊行为类型 */
export type BoardKind = 'normal' | 'spring' | 'break';

/** 一个拍点 */
export interface Beat {
  /** 绝对时间（秒，从音频 0 时刻起算） */
  t: number;
  /** 强度 0..1 */
  power: number;
  band: Band;
  /** 是否为外推补出来的（前奏/尾声没有检测到拍） */
  synthetic: boolean;
  /** 音符驱动：和弦板的主导音高（最高音折回 C4–C6）。网格驱动为 undefined */
  midi?: number;
  /** 音符驱动：原始力度（basic-pitch amplitude 0..1）。网格驱动为 undefined */
  dyn?: number;
}

/** 分析阶段产物 */
export interface AnalysisResult {
  sr: number;
  duration: number;
  bpm: number;
  /** 0..1，低置信度时 UI 应提示用户手动微调 */
  bpmConfidence: number;
  beats: Beat[];
  /** 归一化后的节拍强度包络，画波形条用 */
  envelope: Float32Array;
  hopSec: number;
  /** 网格正则后的质量指标，UI 用它提示「要不要换拍层」 */
  quality?: {
    /** 拍间隔落在中位 ±15% 内的比例 */
    regularity: number;
    /** 原始拍点相对网格的最大残差（单位：拍） */
    drift: number;
    /** 被吸附到 onset 的拍比例 */
    snapped: number;
    /** 拟合出的拍长（秒） */
    period: number;
  };
  /**
   * 高频通量占三频段总通量的比例（0..1）。
   * 鼓组/打击乐的高频瞬态明显更多；钢琴独奏通常很低。
   */
  highRatio?: number;
  /**
   * 宽频 onset 峰值（谱通量抛物线细化后的时刻）。
   * 音符驱动的模型起点用它做精修：模型负责音高/和弦，音频负责精确时刻。
   */
  onsets?: Array<{ t: number; strength: number }>;
}

/**
 * 一段「从上一块板落到下一块板」的运动。
 * 世界坐标 y 向下为正，x 以赛道中心为 0。
 */
export interface Segment {
  index: number;
  /** 起跳时刻（= 上一拍的落地时刻） */
  t0: number;
  /** 落地时刻 */
  t1: number;
  /** 起跳时球心的世界 y */
  y0: number;
  /** 本段垂直位移 = V * dt */
  dy: number;
  /** 本段重力加速度（只影响弧线形状与弹跳高度，不影响落点） */
  g: number;
  /** 本段弹跳高度：球从起跳板向上弹起多少（世界单位） */
  h: number;
  x0: number;
  x1: number;
  /** 横向 Hermite 切线（世界单位/秒） */
  m0: number;
  m1: number;
  /** 横向结点表（相对 t0 的秒）。存在时 evalBall 用它替代 Hermite —— 物理烘焙的产物 */
  xt?: Float64Array;
  /** 横向结点表（对应的 x），xv[0] = x0、xv[last] = x1 */
  xv?: Float64Array;
  band: Band;
  power: number;
  /** 无板：只维持球连续运动（长间奏被细分出来的中间结点） */
  ghost: boolean;
  /** 外推出来的拍（板子画成半透明） */
  synthetic: boolean;
}

/** 一块板：球在 t 时刻精确落在 (x, y) 上 */
export interface Board {
  index: number;
  t: number;
  x: number;
  y: number;
  band: Band;
  power: number;
  ghost: boolean;
  synthetic: boolean;
  /** 倾角（弧度）。板块绕 (x,y) 旋转，所以落点不受影响。 */
  angle: number;
  /** 半宽（世界单位） */
  halfW: number;
  /** 视觉厚度（世界单位） */
  thick: number;
  kind: BoardKind;
  /** 真实拍序号（-1 = 外推/预卷/ghost，不参与小节相位与特殊板分配） */
  ordinal: number;
  /** 在本小节里的位置，0 = 小节第一拍；-1 表示未知 */
  barPos: number;
  /** 重音程度 0..1，驱动撞击特效强度 */
  accent: number;
  /** 音符驱动：主导音高（最高音折回 C4–C6）。网格驱动为 undefined */
  midi?: number;
  /** 音符驱动：原始力度（basic-pitch amplitude 0..1）。网格驱动为 undefined */
  dyn?: number;
}

export interface Chart {
  segs: Segment[];
  boards: Board[];
  duration: number;
  /** 世界单位下的赛道宽（= 可见视口宽） */
  trackW: number;
  /** 世界单位下的可见视口高 */
  viewH: number;
  seed: number;
  /** 是否由音符起音驱动。渲染层据此决定 ghost 板是否要画。 */
  noteDriven: boolean;
  /** 统计信息，UI 展示用 */
  stats: {
    detected: number;
    synthetic: number;
    ghost: number;
    bpm: number;
    /** 估计出的每小节拍数（4 或 3） */
    barLen: number;
    /** 小节相位 */
    barPhase: number;
  };
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface BallState {
  x: number;
  y: number;
  /** 当前所在段索引 */
  seg: number;
}
