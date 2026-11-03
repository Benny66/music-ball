/**
 * 快速 Melodia 后处理与原库 outputToNotesPoly 的逐音符对齐回归。
 *
 *   npm run verify:melodia
 */
import assert from 'node:assert/strict';
import { outputToNotesPoly } from '@spotify/basic-pitch';
import { outputToNotesPolyFast } from '../src/analysis/basic-pitch-notes.ts';

const tests: Array<[string, () => void]> = [];
function test(name: string, fn: () => void): void {
  tests.push([name, fn]);
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeMatrix(rows: number, cols: number, seed: number, density: number): number[][] {
  const r = rng(seed);
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (r() < density ? Math.pow(r(), 2) : r() * 0.08)),
  );
}

function runBoth(frames: number[][], onsets: number[][], seed: number) {
  const a = outputToNotesPoly(
    frames.map((r) => r.slice()),
    onsets.map((r) => r.slice()),
    0.25,
    0.25,
    5,
  );
  const b = outputToNotesPolyFast(
    frames.map((r) => r.slice()),
    onsets.map((r) => r.slice()),
    0.25,
    0.25,
    5,
  );
  assert.deepEqual(b, a, `seed ${seed} 输出不一致`);
  return a.length;
}

test('随机矩阵：与原库输出逐条一致（含 Melodia 补充搜索）', () => {
  for (const seed of [1, 2, 3, 7, 42]) {
    for (const [rows, density] of [[80, 0.08], [200, 0.12], [600, 0.2]] as const) {
      const frames = makeMatrix(rows, 88, seed, density);
      const onsets = makeMatrix(rows, 88, seed + 100, density * 0.6);
      runBoth(frames, onsets, seed);
    }
  }
});

test('边界：全零、单行', () => {
  const zeros = Array.from({ length: 40 }, () => new Array(88).fill(0));
  assert.deepEqual(
    outputToNotesPolyFast(zeros, zeros.map((r) => r.slice()), 0.25, 0.25, 5),
    [],
  );
  const one = [Array.from({ length: 88 }, (_, i) => (i % 7 === 0 ? 0.9 : 0.01))];
  assert.deepEqual(
    outputToNotesPolyFast(one, one.map((r) => r.slice()), 0.25, 0.25, 5),
    outputToNotesPoly(one, one.map((r) => r.slice()), 0.25, 0.25, 5),
  );
});

test('关闭 Melodia 时也与原库一致', () => {
  const frames = makeMatrix(300, 88, 99, 0.15);
  const onsets = makeMatrix(300, 88, 199, 0.08);
  const a = outputToNotesPoly(frames, onsets, 0.25, 0.25, 5, true, null, null, false);
  const b = outputToNotesPolyFast(frames, onsets, 0.25, 0.25, 5, true, null, null, false);
  assert.deepEqual(b, a);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(failed === 0 ? `\n✓ 全部通过 (${tests.length}/${tests.length})` : `\n✗ ${failed}/${tests.length} 失败`);
process.exit(failed === 0 ? 0 : 1);
