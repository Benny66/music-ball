/**
 * 场景选择回归：音符驱动 → 玻璃珠，网格/鼓组 → 经典，显式经典可回退。
 *
 *   npm run verify:scene
 */
import assert from 'node:assert/strict';

import { buildScene } from '../src/chart/scene.ts';
import type { BeadBoard } from '../src/chart/bead.ts';
import { notesFromBead } from '../src/audio/glass.ts';
import type { AnalysisResult, Band, Beat } from '../src/types.ts';
import type { MelodyNote } from '../src/analysis/melody.ts';

const grid: Beat[] = Array.from({ length: 60 }, (_, i) => ({
  t: i * 0.5,
  power: i % 4 === 0 ? 0.9 : 0.6,
  band: (i % 4 === 0 ? 'kick' : 'snare') as Band,
  synthetic: false,
}));

const analysis: AnalysisResult = {
  sr: 44100,
  duration: 30,
  bpm: 120,
  bpmConfidence: 1,
  beats: grid,
  envelope: Float32Array.from(Array.from({ length: 600 }, (_, i) => (i % 20 < 10 ? 0.8 : 0.2))),
  hopSec: 0.05,
};

const notes: MelodyNote[] = Array.from({ length: 24 }, (_, i) => ({
  start: 0.4 + i * 1.0,
  end: 0.4 + i * 1.0 + 0.6,
  midi: 60 + (i % 12),
  amplitude: 0.5 + (i % 5) * 0.1,
}));

const tests: Array<[string, () => void]> = [];
function test(name: string, fn: () => void): void {
  tests.push([name, fn]);
}

test('音符驱动 + auto → 玻璃珠', () => {
  const scene = buildScene(analysis, { noteSource: notes, motion: 'auto' });
  assert.equal(scene.motion, 'bead');
  assert.ok(scene.bead);
  assert.equal(scene.chart.noteDriven, true);
  assert.equal(scene.bead.impacts.length, 24);
  assert.ok(scene.reason.includes('玻璃珠'));
});

test('网格 + auto → 经典；网格 + bead 请求也回退经典', () => {
  const auto = buildScene(analysis, { noteSource: null, motion: 'auto' });
  assert.equal(auto.motion, 'classic');
  assert.equal(auto.bead, null);
  assert.ok(auto.reason.includes('经典'));

  const forced = buildScene(analysis, { noteSource: null, motion: 'bead' });
  assert.equal(forced.motion, 'classic');
  assert.equal(forced.bead, null);
  assert.ok(forced.reason.includes('经典'));
});

test('音符驱动 + classic → 经典回退', () => {
  const scene = buildScene(analysis, { noteSource: notes, motion: 'classic' });
  assert.equal(scene.motion, 'classic');
  assert.equal(scene.bead, null);
  assert.equal(scene.chart.noteDriven, true);
});

test('玻璃珠路径覆盖整曲时长，同输入确定', () => {
  const a = buildScene(analysis, { noteSource: notes, motion: 'bead' });
  const b = buildScene(analysis, { noteSource: notes, motion: 'bead' });
  assert.equal(a.bead?.duration, 30);
  assert.deepEqual(a, b);
});


test('玻璃珠场景的玻璃音高/力度/声像来自撞击板', () => {
  const scene = buildScene(analysis, { noteSource: notes, motion: 'bead' });
  const bead = scene.bead;
  assert.ok(bead);
  const glass = notesFromBead(bead);
  assert.equal(glass.length, bead.boards.length);
  for (let i = 0; i < glass.length; i++) {
    const b: BeadBoard = bead.boards[i];
    assert.ok(Math.abs(glass[i].t - b.t) < 1e-9);
    assert.equal(glass[i].midi, b.midi);
    assert.ok(Math.abs(glass[i].accent - b.power) < 1e-9);
    assert.ok(glass[i].panX >= -1 && glass[i].panX <= 1);
    assert.ok(glass[i].dt >= 0.1 && glass[i].dt <= 1.5);
  }
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
