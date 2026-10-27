import { clamp } from '../util/math.ts';
import type { Segment } from '../types.ts';

/**
 * 横向物理烘焙。
 *
 * 纵向已经是严格的抛物线（匀加速，球从 vy0 起跳、在重力 g 下落回下一块板），
 * 所以「物理轨迹」缺的只是横向：现在横向是三次 Hermite 插值，速度段内会加减速，
 * 而且**与板子的倾角完全无关** —— 板子斜着摆只是个姿势，球不会真的被它弹开。
 *
 * 这里补上反射定律：球撞到倾角 θ 的板上，入射速度 v 反射为 v − 2(v·n)n。
 * 由于横向没有力，段内横向速度恒定，x(s) 就是精确的线性函数 ——
 * 用「结点表（knot）」存段内的折点，比均匀采样更省、且端点误差严格为 0。
 *
 * 为什么必须加 steering（转向）：纯物理下撞击速度 vy_imp ≈ 4.45V，
 * θ=16° 时反射出的 vx ≈ 1226 世界/秒，半个拍间隔就横移 613 世界单位，
 * 而赛道半宽只有 307 —— 纯物理必然飞出赛道。
 * 所以倾角由「本拍想横移多少」反解（solveTilt），物理负责把这一下做得像真的。
 */

/**
 * 球撞到倾角 θ 的板后，横向速度变成多少。
 *
 * 物理模型：把入射速度分解到板的法向/切向，法向乘恢复系数 e 反弹、切向保持（无摩擦），
 * 再合成回 x 分量。e 不是拍的 —— 它就是纵向运动学的恢复系数 √(h/(h+Δy))，
 * 两者天然一致（法向速度减半 ⇔ 纵向起跳速度减半）。
 *
 * 之前用「弹性镜面反射」是错的：它假设法向速度不损失，而我们的纵向明明每拍损失一半。
 */
export function bounceVx(
  vxIn: number,
  vyImp: number,
  theta: number,
  restitution: number,
): number {
  const sn = Math.sin(theta);
  const cs = Math.cos(theta);
  const vn = vxIn * sn - vyImp * cs; // 法向分量（负 = 朝板里压）
  const vt = vxIn * cs + vyImp * sn; // 切向分量
  const vnOut = -restitution * vn;
  return vnOut * sn + vt * cs;
}

/** 撞到倾角 θ 的板后，横向速度变成多少（旧版弹性反射，仅留作对照） */
export function reflectX(vx: number, vyImp: number, theta: number): number {
  return bounceVx(vx, vyImp, theta, 1);
}

/**
 * 由「本拍想达到的横向速度」反解板倾角。
 * reflectX 对 θ 在 |θ| ≤ 16° 内严格单调（vy_imp >> vx），二分固定 40 次 → 完全确定。
 * 目标不可达时夹在端点，残差由赛道两端的墙吸收。
 */
export function solveTilt(
  vxTarget: number,
  vxIn: number,
  vyImp: number,
  maxTilt: number,
  restitution = 1,
): number {
  let lo = -maxTilt;
  let hi = maxTilt;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (bounceVx(vxIn, vyImp, mid, restitution) < vxTarget) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const solveTiltRest = (
  vxTarget: number,
  vxIn: number,
  vyImp: number,
  rest: number,
  maxTilt: number,
): number => solveTilt(vxTarget, vxIn, vyImp, maxTilt, rest);

/** 结点：段内横向路径的一个折点 */
export interface Knot {
  /** 相对段起点 t0 的秒数，首元素 0、末元素 = dt */
  t: number;
  /** 该时刻球的 x */
  x: number;
}

export interface BakeOptions {
  /** 物理自由度 0..1。0 = 完全按反射定律（弹球机），1 = 完全跟音乐目标 */
  dof: number;
  /** 赛道横向半限（世界单位） */
  limit: number;
  /** 板子最大倾角（弧度） */
  maxTilt: number;
}

export interface BakeResult {
  /** 每段的横向结点表，与传入 segs 一一对应 */
  knots: Knot[][];
  /** 反解出的每块板倾角（弧度），长度 = boards.length */
  angles: number[];
}

/**
 * 对整条链做横向物理烘焙。
 *
 * 输入的 `xTargets` 是「音乐目标」（现有分段方向性扫掠给出的每拍 x），
 * 它决定球每一拍**想**到哪里；这里反解出「需要多大倾角才能物理地到达那里」，
 * 并把横向路径（含撞墙的折点）烘焙成结点表。
 * 运行时 `evalBall` 只查表插值 —— matter.js 级别的物理正确性，零运行时开销。
 */
export function bakeReflectionXs(
  segs: Segment[],
  xTargets: ArrayLike<number>,
  opts: BakeOptions,
): BakeResult {
  const n = segs.length;
  const knots: Knot[][] = [];
  const angles = new Array<number>(segs.length + 1).fill(0);

  if (n === 0) return { knots, angles };

  let vxIn = 0;
  const bound = opts.limit;
  // 横向是链式的：上一段飞到的位置就是这一段的起点。
  // 所以 x0 不能用扫掠表里的值（那只是目标），必须用上一段烘焙出的实测终点。
  let x0 = segs[0].x0;
  segs[0].x0 = x0;

  for (let i = 0; i < n; i++) {
    const seg = segs[i];
    const dt = seg.t1 - seg.t0;
    if (!(dt > 0) || !Number.isFinite(dt)) {
      knots.push([
        { t: 0, x: x0 },
        { t: dt, x: x0 },
      ]);
      continue;
    }
    seg.x0 = x0;

    // 撞击速度：v1 = V + g·dt/2，其中 V = dy/dt
    const vBase = seg.dy / dt;
    const vImp = vBase + (seg.g * dt) / 2;

    // 音乐目标：本拍想到 xTargets[i+1]
    const x1Target = xTargets[i + 1] ?? x0;
    const vxMus = (x1Target - x0) / dt;

    // 恢复系数：与纵向运动学严格一致（e = √(h/(h+Δy)) = v0/v1）
    const rest = clamp(Math.sqrt(Math.max(0, seg.h) / Math.max(1e-6, seg.h + seg.dy)), 0.05, 0.98);

    // 可达性夹取：目标横移必须保证球落在赛道内，否则 steering 会把球钉死在墙上。
    // 这是纯物理 + 窄赛道组合下最容易踩的坑：反射出的 vx 一大，球就贴墙不走了。
    const reach = bound * 0.92;
    const vxMin = (-reach - x0) / dt;
    const vxMax = (reach - x0) / dt;

    // 无转向的物理值。dof=0 时给一个交替的自然倾角（弹球机模式）——
    // 否则初始 vx=0 + 水平板会让球永远直上直下，物理上对但什么也看不到。
    const naturalTilt =
      opts.dof < 0.02 ? (i % 2 === 0 ? 1 : -1) * 0.45 * opts.maxTilt : 0;
    const vxPhy = bounceVx(vxIn, vImp, naturalTilt, rest);
    const vxTarget = clamp(
      vxPhy + (vxMus - vxPhy) * opts.dof,
      Math.max(vxMin, -vImp * 1.2),
      Math.min(vxMax, vImp * 1.2),
    );

    const theta = solveTiltRest(vxTarget, vxIn, vImp, rest, opts.maxTilt);
    angles[i] = theta;

    const vx = bounceVx(vxIn, vImp, theta, rest);

    // 横向匀速直线，撞墙则解 t_wall 并反射
    const kn: Knot[] = [{ t: 0, x: x0 }];
    let x = x0;
    let v = vx;
    let s = 0;
    let guard = 0;
    while (guard++ < 32) {
      const remain = dt - s;
      let tWall = Infinity;
      if (v > 1e-9) tWall = s + (bound - x) / v;
      else if (v < -1e-9) tWall = s + (-bound - x) / v;

      if (tWall < remain - 1e-9) {
        // 撞墙：记录折点，反射
        const xw = v > 0 ? bound : -bound;
        kn.push({ t: tWall, x: xw });
        x = xw;
        s = tWall;
        v = -v;
        continue;
      }
      x = clamp(x + v * remain, -bound, bound);
      s = dt;
      break;
    }
    // 大速度 + 长段可能把反射次数用完，兜底夹回界内
    x = clamp(x, -bound, bound);
    kn.push({ t: dt, x });

    // 把实测终点写回：这是「板 x = 球 x」的唯一真相
    seg.x1 = x;
    seg.xt = new Float64Array(kn.map((p) => p.t));
    seg.xv = new Float64Array(kn.map((p) => p.x));
    knots.push(kn);

    // 段末实测横向速度，作为下一段的入射速度
    const lastKn = kn[kn.length - 1];
    const prevKn = kn[kn.length - 2];
    const span = lastKn.t - prevKn.t;
    vxIn = span > 1e-9 ? (lastKn.x - prevKn.x) / span : 0;
    x0 = x;
  }

  return { knots, angles };
}
