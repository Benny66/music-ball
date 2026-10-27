/**
 * 独立的低频 onset 链。
 *
 * 为什么不用 STFT 的低频 flux：N=1024 @44.1k → 每 bin 43Hz，20–200Hz 只覆盖 4 个 bin；
 * 而 23ms 的窗内连一个 50Hz 的周期（20ms）都装不满。实测这条链在真实流行歌上的
 * 归一化自相关峰值只有 0.04–0.15（合成鼓机约 0.6），等于 DP 根本没有可靠的 kick 参考。
 *
 * 这里改用「低通 + 包络差分」：群延迟只有 1/(2π·120) ≈ 1.3ms，
 * 比 FFT 低频链准一个量级，而且与 STFT 完全解耦。
 */

export interface LowBandOnsets {
  /** onset 时刻（秒） */
  times: number[];
  /** 0..1 的相对强度 */
  strength: number[];
  /** 降采样后的包络，供自相关/可视化用 */
  envelope: Float32Array;
  /** 包络每个样本代表多少秒 */
  envStep: number;
}

export interface LowBandOptions {
  /** 低通截止频率（Hz） */
  cutoff?: number;
  /** 包络攻击时间（秒） */
  attack?: number;
  /** 包络释放时间（秒） */
  release?: number;
  /** 峰检阈值倍数（相对局部均值 + k·标准差） */
  k?: number;
  /** 峰检滑窗（秒） */
  winSec?: number;
  /** 最小间隔（秒） */
  minGapSec?: number;
}

const DEF = {
  cutoff: 120,
  attack: 0.003,
  release: 0.04,
  k: 1.8,
  winSec: 0.30,
  minGapSec: 0.1,
};

/** RBJ cookbook 二阶低通 */
function biquadLowpass(sr: number, fc: number, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * 从 PCM 里提取低频起音点。
 * 内存占用与时长无关：滤波和包络都是流式的，只有降采样后的包络会留下来。
 */
export function lowBandOnsets(
  pcm: Float32Array,
  sr: number,
  opts: LowBandOptions = {},
): LowBandOnsets {
  const cfg = { ...DEF, ...opts };
  const n = pcm.length;
  if (n === 0 || sr < 800) return { times: [], strength: [], envelope: new Float32Array(0), envStep: 1 };

  // 包络降到 ~3kHz 就够了（120Hz 的包络不含高频信息），省两个数量级的内存
  const decim = Math.max(1, Math.round(sr / 3000));
  const envStep = decim / sr;
  const envLen = Math.floor(n / decim);

  const c = biquadLowpass(sr, Math.min(cfg.cutoff, sr * 0.45));
  const attackCoef = Math.exp(-1 / (cfg.attack * sr));
  const releaseCoef = Math.exp(-1 / (cfg.release * sr));

  const env = new Float32Array(envLen);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let e = 0;

  for (let i = 0, k = 0; i < n; i++) {
    const x = pcm[i];
    const y =
      c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;

    // 非对称包络：攻击 3ms 直接跟随，释放 40ms 指数衰减
    const rect = y < 0 ? -y : y;
    const decayed = e * (rect > e ? attackCoef : releaseCoef);
    e = rect > decayed ? rect : decayed;

    if (i % decim === 0 && k < envLen) env[k++] = e;
  }

  // 一阶差分 + 半波整流
  const flux = new Float32Array(envLen);
  for (let i = 1; i < envLen; i++) {
    const d = env[i] - env[i - 1];
    flux[i] = d > 0 ? d : 0;
  }

  const peaks = pickLocal(flux, env, envStep, cfg);

  let maxStrength = 0;
  for (const p of peaks) if (p.strength > maxStrength) maxStrength = p.strength;
  const inv = maxStrength > 0 ? 1 / maxStrength : 0;

  return {
    times: peaks.map((p) => p.t),
    strength: peaks.map((p) => p.strength * inv),
    envelope: env,
    envStep,
  };
}

interface Peak {
  t: number;
  strength: number;
}

/**
 * 自适应阈值峰检 + 回扫到包络的 25% 上升沿。
 * 用「包络越过 25% 峰值」而不是差分的峰，是因为差分峰受噪声影响、且系统地偏晚 1–3ms。
 */
function pickLocal(
  flux: Float32Array,
  env: Float32Array,
  envStep: number,
  cfg: typeof DEF,
): Peak[] {
  const n = flux.length;
  if (n < 5) return [];

  const radius = Math.max(1, Math.round(cfg.winSec / envStep));
  const minGap = Math.max(1, Math.round(cfg.minGapSec / envStep));
  const lookBack = Math.max(1, Math.round(0.04 / envStep));

  // 前缀和求局部均值/方差
  const pre = new Float64Array(n + 1);
  const preSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    pre[i + 1] = pre[i] + flux[i];
    preSq[i + 1] = preSq[i] + flux[i] * flux[i];
  }
  const winMean = (i: number): { mean: number; std: number } => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    const cnt = hi - lo;
    if (cnt <= 0) return { mean: 0, std: 0 };
    const mean = (pre[hi] - pre[lo]) / cnt;
    const msq = (preSq[hi] - preSq[lo]) / cnt;
    return { mean, std: Math.sqrt(Math.max(0, msq - mean * mean)) };
  };

  const out: Peak[] = [];
  let lastIdx = -1e9;

  for (let i = 2; i < n - 2; i++) {
    const v = flux[i];
    if (v <= 0) continue;
    if (v < flux[i - 1] || v < flux[i - 2] || v < flux[i + 1] || v < flux[i + 2]) continue;

    const { mean, std } = winMean(i);
    if (v < mean + cfg.k * std) continue;
    if (i - lastIdx < minGap) continue;

    // 回扫找攻击起点：包络首次低于峰值的 25%
    let peakIdx = i;
    for (let j = i; j > Math.max(0, i - lookBack); j--) {
      if (env[j] > env[peakIdx]) peakIdx = j;
      if (env[j] < env[peakIdx] * 0.25) {
        peakIdx = j + 1;
        break;
      }
    }

    out.push({ t: peakIdx * envStep, strength: v });
    lastIdx = i;
  }

  return out;
}

/**
 * 低频包络的归一化自相关峰值（0..1）。
 * 用来判断「这条低频链到底有没有可用周期性」——
 * 合成鼓机约 0.6，真实流行歌用旧的 STFT 低频链只有 0.04–0.15。
 */
export function lowBandPeriodicity(
  onsets: LowBandOnsets,
  minBpm = 50,
  maxBpm = 200,
): number {
  const x = onsets.envelope;
  const n = x.length;
  if (n < 64) return 0;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;

  const lagMin = Math.max(2, Math.round(60 / maxBpm / onsets.envStep));
  const lagMax = Math.min(n - 2, Math.round(60 / minBpm / onsets.envStep));
  if (lagMax <= lagMin) return 0;

  let best = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i + lag < n; i++) {
      const a = x[i] - mean;
      const b = x[i + lag] - mean;
      num += a * b;
      da += a * a;
      db += b * b;
    }
    const r = num / Math.sqrt(da * db + 1e-12);
    if (r > best) best = r;
  }
  return best;
}
