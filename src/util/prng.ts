/** 确定性伪随机：同 seed 永远同序列。渲染层严禁使用 Math.random。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 二维确定性哈希。用于「第 i 拍的第三个粒子」这种寻址，
 * 这样 seek 到任意 t 都能只重算需要的粒子，不依赖遍历历史。
 */
export function hash32(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** 把 hash32 的结果转成 0..1 */
export const hashFloat = (a: number, b: number): number => hash32(a, b) / 4294967296;
