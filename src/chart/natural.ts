import { BALL_R } from './styles.ts';
import type { Band, Beat } from '../types.ts';
import { clamp } from '../util/math.ts';

/**
 * 自然滚动玻璃珠（默认音符驱动运动）。
 *
 * 状态机只有三件事：落板高边 → 沿板滚到低边 → 掉边自由落体到下一块板。
 * 撞击时刻严格等于选中的音符起音；板 x 来自音高轮廓，左右/中心自由；
 * 板距由撞击间隔和滚动/下落时长决定。预先烘焙，seek/导出可复现，
 * 不是实时刚体模拟。
 */

export interface NaturalBoard {
  index: number;
  t: number;
  /** 撞击点 = 板的高边 */
  x: number;
  y: number;
  /** 板中心（绘制用） */
  centerX: number;
  centerY: number;
  lowX: number;
  lowY: number;
  angle: number;
  halfW: number;
  thick: number;
  band: Band;
  midi: number;
  power: number;
  rollLen: number;
  slideDrop: number;
  dir: 1 | -1;
  rollT: number;
}

export interface NaturalBallState {
  x: number;
  y: number;
  roll: number;
  index: number;
}

export interface NaturalPath {
  impacts: Beat[];
  boards: NaturalBoard[];
  duration: number;
  trackW: number;
  viewH: number;
  ballAt(t: number): NaturalBallState;
  camAt(t: number): number;
}

interface Segment {
  t0: number;
  t1: number;
  rollT: number;
  fallT: number;
  xHigh: number;
  yHigh: number;
  xLow: number;
  yLow: number;
  xNext: number;
  yNext: number;
  vx: number;
  vy: number;
  g: number;
  roll0: number;
  rollEnd: number;
  index: number;
}

export interface NaturalOptions {
  duration: number;
  trackW?: number;
  viewH?: number;
  gravity?: number;
}

const DEFAULT_GRAVITY = 2000;
/** 镜头低通时间常数（秒）；越大越稳，越小越跟手 */
const CAMERA_TAU = 0.28;

/** 音高轮廓 → 横向落点。单次大跳（八度/谐波误判）直接忽略，其余用 tanh 压缩。 */
function pitchXs(midis: number[], limit: number): number[] {
  const step = limit * 0.085;
  const bound = limit * 0.92;
  let x = 0;
  let prev: number | null = null;
  const out: number[] = [];
  for (const midi of midis) {
    if (prev !== null) {
      let delta = midi - prev;
      if (Math.abs(delta) > 24) delta = 0;
      else delta = 12 * Math.tanh(delta / 12);
      x += delta * step;
    }
    const edge = Math.abs(x) / bound;
    if (edge > 0.65) x -= Math.sign(x) * (edge - 0.65) * 0.6 * bound;
    x = clamp(x, -bound, bound);
    out.push(x);
    prev = midi;
  }
  return out;
}

function validate(impacts: Beat[]): void {
  if (impacts.length < 2) throw new Error('撞击不足，无法构建自然轨迹');
  for (let i = 1; i < impacts.length; i++) {
    if (!(impacts[i].t - impacts[i - 1].t > 0.1)) {
      throw new Error(`撞击间隔过短或重复：${impacts[i - 1].t} → ${impacts[i].t}`);
    }
  }
}

export function buildNaturalPath(impacts: Beat[], opts: NaturalOptions): NaturalPath {
  const duration = opts.duration;
  const trackW = opts.trackW ?? 900;
  const viewH = opts.viewH ?? 1600;
  const g = opts.gravity ?? DEFAULT_GRAVITY;
  const limit = trackW / 2 - 90;
  validate(impacts);

  const targets = impacts.slice().sort((a, b) => a.t - b.t);
  const xs = pitchXs(
    targets.map((b) => b.midi ?? 64),
    limit,
  );

  const boards: NaturalBoard[] = targets.map((b, i) => {
    const midi = b.midi ?? 64;
    const pitchNorm = clamp((midi - 60) / 24, 0, 1);
    return {
      index: i,
      t: b.t,
      x: xs[i],
      y: 0,
      centerX: xs[i],
      centerY: 0,
      lowX: xs[i],
      lowY: 0,
      angle: 0,
      halfW: 120 + 50 * pitchNorm,
      thick: 14 + 10 * pitchNorm,
      band: b.band,
      midi,
      power: b.power,
      rollLen: 80,
      slideDrop: 50,
      dir: (i % 2 === 0 ? 1 : -1) as 1 | -1,
      rollT: 0.4,
    };
  });

  const segments: Segment[] = [];
  let prevDir: 1 | -1 = 1;
  for (let i = 0; i < boards.length - 1; i++) {
    const b = boards[i];
    const next = boards[i + 1];
    const T = next.t - b.t;
    if (!(T > 0.1)) continue;
    const rollT = clamp(T - 0.34, 0.26, 0.75);
    const fallT = T - rollT;
    const dir = (Math.sign(next.x - b.x) || prevDir) as 1 | -1;
    const absDx = Math.abs(next.x - b.x);
    // 线性滚动 + 线性 x 的落体：两端水平速度一致，L = dx * rollT/(fallT+rollT)
    let L = absDx > 0.5 ? (absDx * rollT) / (fallT + rollT) : 60;
    L = clamp(L, 45, Math.max(45, absDx * 0.9));
    // 板太长会插到相邻轨迹，太陡又像斜坡；统一压到约 16° 以内
    const slide = Math.min(26 + 10 * b.power, L * 0.3);
    const highX = b.x;
    const highY = b.y;
    const lowX = highX + dir * L;
    const lowY = highY + slide;
    const vx = (next.x - lowX) / fallT;
    const vy = slide / rollT;
    const nextY = lowY + vy * fallT + 0.5 * g * fallT * fallT;
    next.y = nextY;

    // 滚动段不占满整块板：板向撞击点后方多延伸 60，视觉上更像长玻璃板
    const extra = 60;
    b.lowX = lowX;
    b.lowY = lowY;
    b.centerX = highX + (dir * (L - extra)) / 2;
    b.centerY = (highY + lowY) / 2;
    b.angle = dir * Math.atan2(slide, L);
    b.halfW = (L + extra) / 2;
    b.rollLen = L;
    b.slideDrop = slide;
    b.dir = dir;
    b.rollT = rollT;

    segments.push({
      t0: b.t,
      t1: next.t,
      rollT,
      fallT,
      xHigh: highX,
      yHigh: highY,
      xLow: lowX,
      yLow: lowY,
      xNext: next.x,
      yNext: nextY,
      vx,
      vy,
      g,
      roll0: 0,
      rollEnd: 0,
      index: i,
    });
    prevDir = dir;
  }

  // 最后一块板没有下一段：给一个短滚动 + 尾落，供视频尾部使用
  const last = boards[boards.length - 1];
  const lastSlide = Math.min(26 + 10 * last.power, 80 * 0.3);
  const lastExtra = 60;
  last.lowX = last.x + prevDir * 80;
  last.lowY = last.y + lastSlide;
  last.centerX = last.x + (prevDir * (80 - lastExtra)) / 2;
  last.centerY = (last.y + last.lowY) / 2;
  last.angle = prevDir * Math.atan2(lastSlide, 80);
  last.halfW = (80 + lastExtra) / 2;
  last.rollLen = 80;
  last.slideDrop = lastSlide;
  last.dir = prevDir;
  last.rollT = 0.4;

  // 开场：从首板上方自由落体到首板；镜头从首板起，球从画面上方入场。
  // 下落段的起点存在 yLow（ballAt 对 fallT 段以 yLow 起算），终点 yNext = 首板。
  const first = boards[0];
  const introT = first.t;
  const intro: Segment | null =
    introT > 0.05
      ? {
          t0: 0,
          t1: introT,
          rollT: 0,
          fallT: introT,
          xHigh: first.x,
          yHigh: first.y,
          xLow: first.x,
          yLow: first.y - 0.5 * g * introT * introT,
          xNext: first.x,
          yNext: first.y,
          vx: 0,
          vy: 0,
          g,
          roll0: 0,
          rollEnd: 0,
          index: 0,
        }
      : null;

  // 尾段：最后一块板滚一下再掉；视频结束时通常只剩半段
  const tailStart = last.t;
  const tailT = duration - tailStart;
  const tail: Segment | null =
    tailT > 0.05
      ? {
          t0: tailStart,
          t1: duration,
          rollT: Math.min(0.4, tailT * 0.55),
          fallT: 0,
          xHigh: last.x,
          yHigh: last.y,
          xLow: last.lowX,
          yLow: last.lowY,
          xNext: last.lowX,
          yNext: last.lowY + 0.5 * g * tailT * tailT,
          vx: 0,
          vy: 0,
          g,
          roll0: 0,
          rollEnd: 0,
          index: boards.length - 1,
        }
      : null;
  if (tail) {
    const rt = tail.rollT;
    tail.fallT = tailT - rt;
    tail.vy = last.slideDrop / Math.max(0.01, rt);
    tail.xNext = last.lowX + last.dir * 40;
    tail.yNext = last.lowY + tail.vy * tail.fallT + 0.5 * g * tail.fallT * tail.fallT;
  }

  // 滚动角：滚动段按弧长/R，空中的旋转按水平速度继续；撞击处角度连续
  let roll = 0;
  for (const s of segments) {
    s.roll0 = roll;
    s.rollEnd = roll + (s.xLow - s.xHigh) / BALL_R;
    roll = s.rollEnd + (s.vx / BALL_R) * s.fallT;
  }
  if (tail) {
    tail.roll0 = roll;
    tail.rollEnd = roll + (tail.xLow - tail.xHigh) / BALL_R;
  }
  const allSegments = [...(intro ? [intro] : []), ...segments, ...(tail ? [tail] : [])];

  function segmentAt(t: number): Segment {
    const tc = clamp(t, 0, duration);
    for (const s of allSegments) {
      if (tc >= s.t0 - 1e-9 && tc <= s.t1 + 1e-9) return s;
    }
    return tc <= (allSegments[0]?.t0 ?? 0) ? allSegments[0] : allSegments[allSegments.length - 1];
  }

  function lastBoardIndex(t: number): number {
    let lo = 0;
    let hi = boards.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boards[mid].t <= t + 1e-9) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function ballAt(t: number): NaturalBallState {
    const tc = clamp(t, 0, duration);
    const s = segmentAt(tc);
    const idx = lastBoardIndex(tc);
    const rt = s.t0 + s.rollT;
    if (s.rollT > 0 && tc <= rt + 1e-9) {
      const u = clamp((tc - s.t0) / s.rollT, 0, 1);
      return {
        x: s.xHigh + (s.xLow - s.xHigh) * u,
        y: s.yHigh + (s.yLow - s.yHigh) * u,
        roll: s.roll0 + ((s.xLow - s.xHigh) / BALL_R) * u,
        index: s.index,
      };
    }
    const dt = tc - rt;
    return {
      x: s.xLow + s.vx * dt,
      y: s.yLow + s.vy * dt + 0.5 * s.g * dt * dt,
      roll: s.rollEnd + (s.vx / BALL_R) * dt,
      index: idx,
    };
  }

  const camStep = 1 / 120;
  const camN = Math.ceil(duration / camStep);
  const cams = new Float64Array(camN + 1);
  let cam = boards[0].y;
  cams[0] = cam;
  for (let i = 1; i <= camN; i++) {
    const t = Math.min(duration, i * camStep);
    // 首板撞击前镜头钉在首板：球从画面上方落入，板子保持可见。
    // 若这里跟随球，长前奏会把镜头一路带高、板子全部推出画面。
    if (t >= first.t) {
      const b = ballAt(t);
      cam += (b.y - cam) * (1 - Math.exp(-camStep / CAMERA_TAU));
    }
    cams[i] = cam;
  }

  function camAt(t: number): number {
    const tc = clamp(t, 0, duration);
    const p = tc / camStep;
    const i = Math.min(camN - 1, Math.floor(p));
    const u = p - i;
    return cams[i] + (cams[i + 1] - cams[i]) * u;
  }

  return {
    impacts: targets,
    boards,
    duration,
    trackW,
    viewH,
    ballAt,
    camAt,
  };
}
