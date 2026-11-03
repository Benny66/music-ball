/**
 * 场景选择回归：音符驱动 → 玻璃珠，网格/鼓组 → 经典，显式经典可回退。
 *
 *   npm run verify:scene
 */
import assert from 'node:assert/strict';

import { buildScene } from '../src/chart/scene.ts';
import type { NaturalBoard } from '../src/chart/natural.ts';
import { boardsFromNotes } from '../src/chart/notes.ts';
import { notesFromBead, notesFromNatural } from '../src/audio/glass.ts';
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

test('音符驱动 + auto → 表面节奏自然滚动', () => {
  const scene = buildScene(analysis, { noteSource: notes, motion: 'auto' });
  assert.equal(scene.motion, 'natural');
  assert.ok(scene.natural);
  assert.equal(scene.bead, null);
  assert.equal(scene.chart.noteDriven, true);
  assert.equal(scene.natural.impacts.length, 24);
  assert.ok(scene.reason.includes('玻璃珠'));
  assert.ok(scene.reason.includes('表面节奏'));
});

test('自然滚动的撞击时刻全部来自音符板起音', () => {
  const scene = buildScene(analysis, { noteSource: notes, motion: 'bead' });
  const boardTimes = boardsFromNotes(notes, { minGap: 0.125 }).map((b) => b.t);
  assert.ok(scene.natural);
  for (const impact of scene.natural.impacts) {
    assert.ok(
      boardTimes.some((t) => Math.abs(t - impact.t) < 1e-9),
      `${impact.t} 不在音符板上`,
    );
  }
});

test('网格 + auto / bead → 拍点玻璃珠', () => {
  for (const motion of ['auto', 'bead'] as const) {
    const scene = buildScene(analysis, { noteSource: null, motion });
    assert.equal(scene.motion, 'bead', motion);
    assert.ok(scene.bead, motion);
    assert.equal(scene.chart.noteDriven, false);
    assert.equal(scene.bead.impacts.length, 30, motion);
    assert.equal(scene.bead.duration, 30);
    assert.ok(scene.reason.includes('拍点'), scene.reason);
    for (let i = 0; i < scene.bead.impacts.length; i++) {
      assert.equal(scene.bead.impacts[i].side, i % 2 === 0 ? -1 : 1);
    }
  }
});

test('网格 + classic → 经典回退', () => {
  const scene = buildScene(analysis, { noteSource: null, motion: 'classic' });
  assert.equal(scene.motion, 'classic');
  assert.equal(scene.bead, null);
  assert.equal(scene.natural, null);
});

test('拍点不足时回退经典并给原因', () => {
  const empty = { ...analysis, beats: [] };
  const scene = buildScene(empty, { noteSource: null, motion: 'auto' });
  assert.equal(scene.motion, 'classic');
  assert.equal(scene.bead, null);
  assert.match(scene.reason, /拍点|不足|经典/);

  const one = {
    ...analysis,
    beats: [{ t: 1, power: 0.8, band: 'kick' as Band, synthetic: false }],
  };
  const single = buildScene(one, { noteSource: null, motion: 'bead' });
  assert.equal(single.motion, 'classic');
  assert.equal(single.bead, null);
  assert.equal(single.natural, null);
});

test('音符不足时仍用拍点玻璃珠，不直接回退经典', () => {
  const scene = buildScene(analysis, { noteSource: notes.slice(0, 2), motion: 'auto' });
  assert.equal(scene.chart.noteDriven, false);
  assert.equal(scene.motion, 'bead');
  assert.ok(scene.bead);
  assert.ok(scene.reason.includes('拍点'), scene.reason);
});

test('音符驱动 + classic → 经典回退', () => {
  const scene = buildScene(analysis, { noteSource: notes, motion: 'classic' });
  assert.equal(scene.motion, 'classic');
  assert.equal(scene.bead, null);
  assert.equal(scene.natural, null);
  assert.equal(scene.chart.noteDriven, true);
});

test('玻璃珠路径覆盖整曲时长，同输入确定', () => {
  const a = buildScene(analysis, { noteSource: notes, motion: 'bead' });
  const b = buildScene(analysis, { noteSource: notes, motion: 'bead' });
  assert.equal(a.natural?.duration, 30);
  assert.deepEqual(a.natural?.boards, b.natural?.boards);
  assert.deepEqual(a.natural?.impacts, b.natural?.impacts);
});


test('自然滚动的玻璃音高/力度/声像来自撞击板', () => {
  const scene = buildScene(analysis, { noteSource: notes, motion: 'bead' });
  const natural = scene.natural;
  assert.ok(natural);
  const glass = notesFromNatural(natural);
  assert.equal(glass.length, natural.boards.length);
  for (let i = 0; i < glass.length; i++) {
    const b: NaturalBoard = natural.boards[i];
    assert.ok(Math.abs(glass[i].t - b.t) < 1e-9);
    assert.equal(glass[i].midi, b.midi);
    assert.ok(Math.abs(glass[i].accent - b.power) < 1e-9);
    assert.ok(glass[i].panX >= -1 && glass[i].panX <= 1);
    assert.ok(glass[i].dt >= 0.1 && glass[i].dt <= 1.5);
  }
});

test('拍点玻璃珠的玻璃音轨来自拍点撞击板', () => {
  const scene = buildScene(analysis, { noteSource: null, motion: 'auto' });
  assert.ok(scene.bead);
  const glass = notesFromBead(scene.bead);
  assert.equal(glass.length, scene.bead.boards.length);
  assert.ok(glass.length >= 20);
  for (let i = 0; i < glass.length; i++) {
    assert.ok(Math.abs(glass[i].t - scene.bead.boards[i].t) < 1e-9);
    assert.equal(glass[i].midi, scene.bead.boards[i].midi);
  }
  const bands = new Set(scene.bead.boards.map((b) => b.band));
  assert.ok(bands.has('kick'));
  assert.ok(bands.has('snare'));
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
