import { boardsFromNotes } from './notes.ts';
import { BALL_R } from './styles.ts';
import type { MelodyNote } from '../analysis/melody.ts';
import type { Band } from '../types.ts';
import { clamp } from '../util/math.ts';

/**
 * 玻璃珠表演轨迹。
 *
 * 节拍优先：每个 impact.t 严格来自音符/板时间；两次撞击之间烘焙「滚动段 + 掉落段」。
 * 物理只负责看起来真，不产生自由模拟的时间漂移。
 *
 * 几何（世界坐标 y 向下）：
 *   撞击点 = 板外侧高点 (side·outerX, impactY)
 *   滚动终点 = 板内侧低点 (side·innerX, impactY + slideDrop)
 *   掉落终点 = 下一块板外侧高点（对侧）
 */

export type Side = -1 | 1;

export interface BeadImpact {
  t: number;
  power: number;
  /** C4–C6 折叠后的主导音高 */
  midi: number;
  /** 音符时值（秒），用于滚动时长 */
  dur: number;
  side: Side;
  band: Band;
}

export interface ImpactOptions {
  minGap?: number;
  chordWindow?: number;
  firstSide?: Side;
}

export interface BeadOptions {
  trackW?: number;
  viewH?: number;
  firstSide?: Side;
  duration?: number;
  /** 板外侧撞击点 |x| */
  outerX?: number;
  /** 板内侧滚动终点 |x| */
  innerX?: number;
  /** 板从外侧高点滑到内侧低点的垂直落差 */
  slideDrop?: number;
  /** 掉落段基准重力/初速 */
  gravity?: number;
  fallV0?: number;
  entryLead?: number;
  /** 接触/滚动段时长（秒），由力度/时值在 [slideMinSec, slideMaxSec] 内插值 */
  slideMinSec?: number;
  slideMaxSec?: number;
  /** 掉落段最短时长；滚动段会被夹到 dt−minFallSec 以内 */
  minFallSec?: number;
  introDrop?: number;
  /** 最后一个 impact 之后没有下一段时，按这个 Δt 估算滚动 */
  tailDt?: number;
}

const DEF = {
  trackW: 900,
  viewH: 1600,
  firstSide: -1 as Side,
  outerFrac: 0.34,
  innerFrac: 0.06,
  slideDrop: 56,
  gravity: 2200,
  fallV0: 300,
  entryLead: 0.08,
  slideMinSec: 0.45,
  slideMaxSec: 0.75,
  minFallSec: 0.45,
  introDrop: 240,
  tailDt: 0.5,
};

export interface BeadBoard {
  index: number;
  /** 撞击时刻 = 音符/板时间 */
  t: number;
  side: Side;
  outerX: number;
  innerX: number;
  impactY: number;
  innerY: number;
  centerX: number;
  centerY: number;
  angle: number;
  halfW: number;
  thick: number;
  band: Band;
  midi: number;
  power: number;
  dur: number;
  slideT: number;
  entryStart: number;
  entryEnd: number;
  /** 入场开始时板的 x 偏移（完全在对应侧屏幕外） */
  entryOffsetStart: number;
}

export interface BeadSlide {
  t0: number;
  t1: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** 滚动角（弧度）：起点角度与角速度 */
  roll0: number;
  rollOmega: number;
}

export interface BeadFall {
  t0: number;
  t1: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  vx: number;
  vy0: number;
  g: number;
  /** 空中保持离开板时的角速度（惯性） */
  roll0: number;
  rollOmega: number;
}

export interface CameraKey {
  t: number;
  y: number;
}

export interface BeadPath {
  impacts: BeadImpact[];
  boards: BeadBoard[];
  slides: BeadSlide[];
  falls: BeadFall[];
  camera: CameraKey[];
  intro: BeadFall | null;
  duration: number;
  trackW: number;
  viewH: number;
  firstSide: Side;
}

export type BeadPhase = 'empty' | 'intro' | 'slide' | 'fall' | 'hold';

export interface BeadState {
  x: number;
  y: number;
  phase: BeadPhase;
  /** 当前滚动/掉落所属的 impact 索引 */
  index: number;
}

const smoothstep = (u: number): number => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

export function impactsFromNotes(notes: MelodyNote[], opts: ImpactOptions = {}): BeadImpact[] {
  const minGap = opts.minGap ?? 0.7;
  const chordWindow = opts.chordWindow ?? 0.06;
  const firstSide = opts.firstSide ?? DEF.firstSide;

  const usable = notes.filter(
    (n) => Number.isFinite(n.start) && n.end > n.start && n.end - n.start >= 0.08,
  );
  const beats = boardsFromNotes(usable, { minGap, chordWindow });
  if (beats.length === 0) return [];

  return beats.map((b, i) => {
    let dur = 0;
    for (const n of usable) {
      if (Math.abs(n.start - b.t) <= chordWindow + 1e-9) {
        dur = Math.max(dur, n.end - n.start);
      }
    }
    return {
      t: b.t,
      power: b.power,
      midi: b.midi ?? 64,
      dur: clamp(dur || 0.1, 0.08, 2),
      side: (i % 2 === 0 ? firstSide : -firstSide) as Side,
      band: b.band,
    };
  });
}

export function buildBeadChoreography(
  input: BeadImpact[],
  opts: BeadOptions = {},
): BeadPath {
  const trackW = opts.trackW ?? DEF.trackW;
  const viewH = opts.viewH ?? DEF.viewH;
  const firstSide = opts.firstSide ?? input[0]?.side ?? DEF.firstSide;
  const outerX = opts.outerX ?? trackW * DEF.outerFrac;
  const innerX = opts.innerX ?? trackW * DEF.innerFrac;
  const slideDrop = opts.slideDrop ?? DEF.slideDrop;
  const gravity = opts.gravity ?? DEF.gravity;
  const fallV0 = opts.fallV0 ?? DEF.fallV0;
  const entryLead = opts.entryLead ?? DEF.entryLead;
  const slideMinSec = opts.slideMinSec ?? DEF.slideMinSec;
  const slideMaxSec = opts.slideMaxSec ?? DEF.slideMaxSec;
  const minFallSec = opts.minFallSec ?? DEF.minFallSec;
  const tailDt = opts.tailDt ?? DEF.tailDt;

  const sorted = input
    .filter((x) => Number.isFinite(x.t))
    .slice()
    .sort((a, b) => a.t - b.t);

  const impacts: BeadImpact[] = sorted.map((x, i) => ({
    ...x,
    side: (i % 2 === 0 ? firstSide : -firstSide) as Side,
  }));
  for (let i = 1; i < impacts.length; i++) {
    if (!(impacts[i].t > impacts[i - 1].t)) {
      throw new Error(`撞击时间必须严格递增: ${impacts[i - 1].t} → ${impacts[i].t}`);
    }
  }

  const boards: BeadBoard[] = [];
  const slides: BeadSlide[] = [];
  const falls: BeadFall[] = [];
  const camera: CameraKey[] = [];

  let y = 0;
  let roll = 0;
  for (let i = 0; i < impacts.length; i++) {
    const imp = impacts[i];
    const next = impacts[i + 1];
    const dt = next ? next.t - imp.t : tailDt;
    if (!(dt > minFallSec)) {
      throw new Error(`撞击间隔 ${dt.toFixed(3)}s 小于最短掉落 ${minFallSec}s`);
    }

    const slideT = slideDuration(imp, dt, slideMinSec, slideMaxSec, minFallSec);
    const pitchNorm = clamp((imp.midi - 60) / 24, 0, 1);
    const span = Math.abs(innerX - outerX);
    const spanLen = Math.hypot(span, slideDrop);
    const halfW = span / 2 + 6 + 20 * pitchNorm;
    const thick = 14 + 10 * pitchNorm;
    const band = bandForMidi(imp.midi);

    const sideOuterX = imp.side * outerX;
    const sideInnerX = imp.side * innerX;
    const impactY = y;
    const innerY = impactY + slideDrop;
    const centerX = (sideOuterX + sideInnerX) / 2;
    const centerY = (impactY + innerY) / 2;
    const angle =
      -imp.side * Math.atan2(slideDrop, Math.abs(sideInnerX - sideOuterX));

    const prevImpactT = i > 0 ? impacts[i - 1].t : 0;
    const prevSlideEnd = i > 0 ? slides[i - 1].t1 : 0;
    const prevDt = i > 0 ? imp.t - prevImpactT : imp.t;
    const entryEnd = Math.max(0, imp.t - entryLead);
    // 目标板在上一段滚动结束后就开始滑入，让整个掉落段都看得见它
    const entryDur = clamp(0.55 * prevDt, 0.2, 0.85);
    const entryStart = Math.max(i === 0 ? 0 : prevSlideEnd + 0.02, entryEnd - entryDur);
    const entryOffsetStart = imp.side * (trackW / 2 + halfW) - centerX;

    boards.push({
      index: i,
      t: imp.t,
      side: imp.side,
      outerX: sideOuterX,
      innerX: sideInnerX,
      impactY,
      innerY,
      centerX,
      centerY,
      angle,
      halfW,
      thick,
      band,
      midi: imp.midi,
      power: imp.power,
      dur: imp.dur,
      slideT,
      entryStart,
      entryEnd,
      entryOffsetStart,
    });

    // 接触阶段是滚动：左板向右滚（正角速度），右板向左滚（负角速度）
    const rollOmega = ((-imp.side * spanLen) / slideT) / BALL_R;
    const roll1 = roll + rollOmega * slideT;

    slides.push({
      t0: imp.t,
      t1: imp.t + slideT,
      x0: sideOuterX,
      x1: sideInnerX,
      y0: impactY,
      y1: innerY,
      roll0: roll,
      rollOmega,
    });

    const holdUntil = imp.t + slideT;
    if (!next) {
      camera.push({ t: imp.t, y: impactY });
      y = innerY;
      roll = roll1;
      continue;
    }

    const fallT = next.t - holdUntil;
    const nextPitch = clamp((next.midi - 60) / 24, 0, 1);
    const dropY = fallDrop(fallT, imp.power, nextPitch, gravity, fallV0);
    const nextImpactY = innerY + dropY;
    const nextOuterX = next.side * outerX;

    const fall = makeFall(
      holdUntil,
      next.t,
      sideInnerX,
      nextOuterX,
      innerY,
      nextImpactY,
      gravity,
      roll1,
      rollOmega,
    );
    falls.push(fall);
    camera.push({
      t: imp.t,
      y: impactY,
    });
    y = nextImpactY;
    roll = roll1 + rollOmega * fallT;
  }

  const last = boards[boards.length - 1];
  const duration = Math.max(opts.duration ?? 0, last ? last.t + last.slideT + 0.05 : 0);

  let intro: BeadFall | null = null;
  if (boards.length > 0 && boards[0].t > 0) {
    const firstBoard = boards[0];
    const introDrop = opts.introDrop ?? Math.max(120, DEF.introDrop);
    intro = makeFall(
      0,
      firstBoard.t,
      firstBoard.outerX,
      firstBoard.outerX,
      firstBoard.impactY - introDrop,
      firstBoard.impactY,
      gravity,
      0,
      0,
    );
  }

  return {
    impacts,
    boards,
    slides,
    falls,
    camera,
    intro,
    duration,
    trackW,
    viewH,
    firstSide,
  };
}

function slideDuration(
  imp: BeadImpact,
  dt: number,
  minSec: number,
  maxSec: number,
  minFallSec: number,
): number {
  const durNorm = clamp(imp.dur / 1.2, 0, 1);
  const raw = minSec + (maxSec - minSec) * (0.65 * imp.power + 0.35 * durNorm);
  return Math.min(raw, Math.max(0, dt - minFallSec));
}

function fallDrop(
  fallT: number,
  power: number,
  pitchNorm: number,
  gravity: number,
  fallV0: number,
): number {
  if (!(fallT > 0)) return 0.05;
  const base = 0.5 * gravity * fallT * fallT + fallV0 * fallT;
  const pitch = 1.15 - 0.3 * pitchNorm;
  const powerK = 0.85 + 0.3 * clamp(power, 0, 1);
  return Math.max(0.05, base * pitch * powerK);
}

function makeFall(
  t0: number,
  t1: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  gravity: number,
  roll0: number,
  rollOmega: number,
): BeadFall {
  const T = t1 - t0;
  const dy = y1 - y0;
  const g0 = gravity;
  let vy0 = (dy - 0.5 * g0 * T * T) / T;
  let g = g0;
  if (vy0 < 0) {
    vy0 = 0;
    g = (2 * dy) / (T * T);
  }
  return { t0, t1, x0, x1, y0, y1, vx: (x1 - x0) / T, vy0, g, roll0, rollOmega };
}

function evalFall(f: BeadFall, t: number): { x: number; y: number } {
  const tau = clamp(t - f.t0, 0, f.t1 - f.t0);
  return {
    x: f.x0 + f.vx * tau,
    y: f.y0 + f.vy0 * tau + 0.5 * f.g * tau * tau,
  };
}

function bandForMidi(midi: number): Band {
  if (midi < 67) return 'kick';
  if (midi < 77) return 'snare';
  return 'hat';
}

/** t 时刻所在的 impact 索引（最大的 impacts[i].t <= t） */
function impactIndexAt(path: BeadPath, t: number): number {
  const a = path.impacts;
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function evalBead(
  path: BeadPath,
  t: number,
  out: BeadState = { x: 0, y: 0, phase: 'empty', index: -1 },
): BeadState {
  if (path.impacts.length === 0 || path.boards.length === 0) {
    out.x = 0;
    out.y = 0;
    out.phase = 'empty';
    out.index = -1;
    return out;
  }

  const tc = clamp(t, 0, path.duration);
  const first = path.boards[0];
  if (tc < first.t) {
    if (path.intro) {
      const p = evalFall(path.intro, tc);
      out.x = p.x;
      out.y = p.y;
    } else {
      out.x = first.outerX;
      out.y = first.impactY;
    }
    out.phase = 'intro';
    out.index = 0;
    return out;
  }

  const i = impactIndexAt(path, tc);
  const s = path.slides[i];
  const f = path.falls[i];

  if (tc <= s.t1 + 1e-12) {
    const u = s.t1 > s.t0 ? clamp((tc - s.t0) / (s.t1 - s.t0), 0, 1) : 0;
    out.x = s.x0 + (s.x1 - s.x0) * u;
    out.y = s.y0 + (s.y1 - s.y0) * u;
    out.phase = 'slide';
    out.index = i;
    return out;
  }

  if (f && tc <= f.t1 + 1e-12) {
    const p = evalFall(f, tc);
    out.x = p.x;
    out.y = p.y;
    out.phase = 'fall';
    out.index = i;
    return out;
  }

  out.x = s.x1;
  out.y = s.y1;
  out.phase = 'hold';
  out.index = i;
  return out;
}

export function evalBeadCamera(path: BeadPath, t: number): number {
  if (path.camera.length === 0) return 0;
  const tc = clamp(t, 0, path.duration);
  const first = path.camera[0];
  if (tc <= first.t) return first.y;

  const i = impactIndexAt(path, tc);
  const s = path.slides[i];
  const f = path.falls[i];

  // 滚动段相机不动；掉落段用“滞后”跟随：相机始终在球上方，
  // 球在屏幕上持续下落，到撞击帧滞后量归零、精确回到 58%。
  if (tc <= s.t1 + 1e-12 || !f) return s.y0;
  if (tc > f.t1 + 1e-12) return s.y0;

  const u = clamp((tc - f.t0) / (f.t1 - f.t0), 0, 1);
  // 相机先向下走，球从 58% 上方落进下一块板；撞击帧精确回到 58%。
  return s.y0 + (f.y1 - s.y0) * smoothstep(u);
}

/** 球的滚动角（弧度）。接触段按弧长/球半径转，空中保持离开板时的角速度。 */
export function evalBeadRoll(path: BeadPath, t: number): number {
  if (path.slides.length === 0) return 0;
  const tc = clamp(t, 0, path.duration);
  if (tc < path.boards[0].t) return 0;

  const i = impactIndexAt(path, tc);
  const s = path.slides[i];
  const f = path.falls[i];
  if (tc <= s.t1 + 1e-12) return s.roll0 + (tc - s.t0) * s.rollOmega;
  if (f && tc <= f.t1 + 1e-12) return f.roll0 + (tc - f.t0) * f.rollOmega;
  return s.roll0 + s.rollOmega * (s.t1 - s.t0);
}

/** 板在 t 时刻相对最终位置的 x 偏移；0 = 已到位 */
export function evalBoardEntry(board: BeadBoard, t: number): number {
  if (t >= board.entryEnd) return 0;
  if (board.entryEnd <= board.entryStart) return board.entryOffsetStart;
  if (t <= board.entryStart) return board.entryOffsetStart;
  const u = (t - board.entryStart) / (board.entryEnd - board.entryStart);
  return board.entryOffsetStart * (1 - smoothstep(u));
}
