/**
 * 迭代式 radix-2 FFT，原地计算。
 * 预计算位反转表与旋转因子，按长度缓存 —— 全曲只跑一种长度，缓存命中后零开销。
 */

interface FftTable {
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}

const tableCache = new Map<number, FftTable>();

function getTable(n: number): FftTable {
  const cached = tableCache.get(n);
  if (cached) return cached;

  const bits = Math.round(Math.log2(n));
  if (1 << bits !== n) throw new Error(`fft: length ${n} is not a power of two`);

  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }

  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (-2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }

  const table = { rev, cos, sin };
  tableCache.set(n, table);
  return table;
}

/** 原地复数 FFT。re/im 长度必须是 2 的幂。 */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2) return;
  const { rev, cos, sin } = getTable(n);

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let base = 0; base < n; base += len) {
      for (let k = 0; k < half; k++) {
        const idx = k * step;
        const wr = cos[idx];
        const wi = sin[idx];
        const a = base + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        const ar = re[a];
        const ai = im[a];
        re[b] = ar - xr;
        im[b] = ai - xi;
        re[a] = ar + xr;
        im[a] = ai + xi;
      }
    }
  }
}

/** 周期 Hann 窗，长度 n（用作 STFT 分析窗，非完美重建用） */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
