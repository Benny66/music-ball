/**
 * 玻璃珠原型出片。
 *
 *   node --experimental-strip-types scripts/render-bead.mts --variant=new --seconds=5
 *   node --experimental-strip-types scripts/render-bead.mts --variant=new --full
 *   node --experimental-strip-types scripts/render-bead.mts --variant=old --full
 *
 * 输入只读 out/bead/notes.json + out/bead/clip.wav；两版共用同一音频、分辨率、帧率。
 * 输出在 out/bead/（不入库）。
 */
import { createCanvas } from '@napi-rs/canvas';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { analyze } from '../src/analysis/pipeline.ts';
import type { MelodyNote, MelodyResult } from '../src/analysis/melody.ts';
import { buildChart, DEFAULT_TRACK_W } from '../src/chart/build.ts';
import { evalBall, evalCamera } from '../src/chart/ball.ts';
import { createAssets } from '../src/render/assets.ts';
import { createScratch, draw } from '../src/render/draw.ts';
import type { BallState, Chart } from '../src/types.ts';
import type { Ctx2D, MakeCanvas, View } from '../src/render/theme.ts';
import { BALL_SCREEN_RATIO } from '../src/render/theme.ts';
import { decodeAudioFile, encodeFramesToMp4 } from './lib/media.mts';
import {
  buildBeadChoreography,
  evalBeadCamera,
  evalBoardEntry,
  impactsFromNotes,
  type BeadImpact,
  type BeadPath,
  type BeadState,
} from '../src/chart/bead.ts';
import { beadScreen, createBeadScratch, drawBead } from '../src/render/bead.ts';

interface FullCtx extends Ctx2D {
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? '1';
  }
  return out;
}

const opt = parseArgs(process.argv.slice(2));
const variant = opt.variant === 'old' ? 'old' : 'new';
const notesPath = resolve(opt.notes ?? 'out/bead/notes.json');
const clipPath = resolve(opt.clip ?? 'out/bead/clip.wav');
const fps = Number(opt.fps ?? 60);
const outW = Math.round(1080 * Number(opt.scale ?? 1));
const outH = Math.round(outW * (16 / 9));
const minGap = Number(opt['min-gap'] ?? 0.7);
const full = opt.full === '1';
const stills = opt.stills ? opt.stills.split(',').map(Number) : null;

if (!existsSync(notesPath)) {
  console.error(`找不到 ${notesPath}；先运行 npm run bead:fixture`);
  process.exit(1);
}
if (!existsSync(clipPath)) {
  console.error(`找不到 ${clipPath}；先运行 npm run bead:fixture`);
  process.exit(1);
}

const saved = JSON.parse(readFileSync(notesPath, 'utf8')) as MelodyResult;
const notes = saved.notes;
const impacts = impactsFromNotes(notes, { minGap });
if (impacts.length < 2) throw new Error(`撞击点不足: ${impacts.length}`);

const { pcm, sr } = decodeAudioFile(clipPath);
const clipDuration = pcm.length / sr;
const path = buildBeadChoreography(impacts, { duration: clipDuration });

const totalSec = full ? clipDuration : Math.min(clipDuration, Number(opt.seconds ?? 8));
const totalFrames = Math.ceil(totalSec * fps);
const suffix = full ? '' : '-preview';
const defaultOut =
  variant === 'new' ? `out/bead/bead-new${suffix}.mp4` : `out/bead/bead-old${suffix}.mp4`;
const output = resolve(opt.out ?? defaultOut);

const view: View = { w: outW, h: outH, scale: outW / DEFAULT_TRACK_W };
const make: MakeCanvas = (w, h) => createCanvas(w, h) as unknown as ReturnType<MakeCanvas>;
const assets = createAssets(make, view);

console.log(`variant=${variant}  ${totalSec.toFixed(2)}s @ ${outW}x${outH} ${fps}fps`);
console.log(`notes=${notes.length} impacts=${impacts.length} minGap=${minGap}s`);

if (variant === 'new') {
  preflightNew(path, view, totalSec, fps);
  await renderNew(path, output, totalSec, totalFrames);
} else {
  const analysis = analyze(pcm, sr, clipDuration);
  const oldNotes = toOldNotes(impacts);
  const chart = buildChart(analysis, { noteSource: oldNotes, dtMin: minGap, drama: 0.7 });
  preflightOld(chart, view, totalSec, fps);
  await renderOld(chart, output, totalSec, totalFrames);
}

function toOldNotes(list: BeadImpact[]): MelodyNote[] {
  return list.map((x) => ({
    start: x.t,
    end: x.t + Math.max(0.08, x.dur),
    midi: x.midi,
    amplitude: x.power,
  }));
}

async function renderNew(
  pathIn: BeadPath,
  out: string,
  seconds: number,
  frames: number,
): Promise<void> {
  const scratch = createBeadScratch();
  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d') as unknown as FullCtx;

  if (stills) {
    const dir = resolve('out/bead/stills');
    mkdirSync(dir, { recursive: true });
    for (const s of stills) {
      drawBead(ctx, pathIn, s, view, assets, scratch);
      const p = resolve(dir, `new-t${s.toFixed(3)}.png`);
      writeFileSync(p, canvas.toBuffer('image/png'));
      console.log('still →', p);
    }
    return;
  }

  await encodeFramesToMp4({
    output: out,
    fps,
    width: outW,
    height: outH,
    audioFile: clipPath,
    totalFrames: frames,
    frame: (i) => {
      drawBead(ctx, pathIn, i / fps, view, assets, scratch);
      const data = ctx.getImageData(0, 0, outW, outH).data;
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    },
    onProgress: (i, total) => {
      if (i % 120 === 0) process.stdout.write(`  ${i}/${total}\r`);
    },
  });
  report(out, seconds);
}

async function renderOld(
  chart: Chart,
  out: string,
  seconds: number,
  frames: number,
): Promise<void> {
  const scratch = createScratch();
  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d') as unknown as FullCtx;

  if (stills) {
    const dir = resolve('out/bead/stills');
    mkdirSync(dir, { recursive: true });
    for (const s of stills) {
      draw(ctx, chart, s, view, assets, scratch);
      const p = resolve(dir, `old-t${s.toFixed(3)}.png`);
      writeFileSync(p, canvas.toBuffer('image/png'));
      console.log('still →', p);
    }
    return;
  }

  await encodeFramesToMp4({
    output: out,
    fps,
    width: outW,
    height: outH,
    audioFile: clipPath,
    totalFrames: frames,
    frame: (i) => {
      draw(ctx, chart, i / fps, view, assets, scratch);
      const data = ctx.getImageData(0, 0, outW, outH).data;
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    },
    onProgress: (i, total) => {
      if (i % 120 === 0) process.stdout.write(`  ${i}/${total}\r`);
    },
  });
  report(out, seconds);
}

function preflightNew(pathIn: BeadPath, v: View, seconds: number, rate: number): void {
  const state: BeadState = { x: 0, y: 0, phase: 'empty', index: -1 };
  for (let t = 0; t <= seconds; t += 1 / rate) {
    const p = beadScreen(pathIn, v, t, state);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`NaN at t=${t}`);
    if (!Number.isFinite(evalBeadCamera(pathIn, t))) throw new Error(`camera NaN at t=${t}`);
  }

  const cy = v.h * BALL_SCREEN_RATIO;
  let inRange = 0;
  for (const b of pathIn.boards) {
    if (b.t > seconds) continue;
    inRange++;
    const y = beadScreen(pathIn, v, b.t).y;
    if (Math.abs(y - cy) > 0.5) {
      throw new Error(`impact t=${b.t.toFixed(3)} 屏幕 y=${y.toFixed(2)}，应=${cy.toFixed(2)}`);
    }
    if (evalBoardEntry(b, b.t) !== 0) throw new Error(`board ${b.index} 撞击时仍在入场`);
  }
  for (let i = 0; i < pathIn.slides.length; i++) {
    const s = pathIn.slides[i];
    if (s.t1 > seconds) continue;
    const mid = beadScreen(pathIn, v, (s.t0 + s.t1) / 2).y;
    if (mid <= cy + 3) throw new Error(`slide ${i} 段内未低于 58%: ${mid.toFixed(2)}`);
  }
  if (seconds >= 8 && inRange < 5) throw new Error(`预览只有 ${inRange} 次撞击`);
  console.log(`preflight: ${inRange} 次撞击 · 撞击帧 58% ✓  滚动段低于 58% ✓  坐标有限 ✓`);
}

function preflightOld(chart: Chart, v: View, seconds: number, rate: number): void {
  const cy = v.h * BALL_SCREEN_RATIO;
  const ball: BallState = { x: 0, y: 0, seg: 0 };
  for (let t = 0; t <= seconds; t += 1 / rate) {
    evalBall(chart, t, ball);
    if (!Number.isFinite(ball.x) || !Number.isFinite(ball.y)) throw new Error(`NaN at t=${t}`);
    if (!Number.isFinite(evalCamera(chart, t))) throw new Error(`camera NaN at t=${t}`);
  }
  let checked = 0;
  const oldTimes = chart.boards.filter((b) => !b.ghost && b.t >= 0 && b.t <= seconds).map((b) => b.t);
  for (const b of chart.boards) {
    if (b.ghost || b.t < 0 || b.t > seconds) continue;
    evalBall(chart, b.t, ball);
    const y = cy + (ball.y - evalCamera(chart, b.t)) * v.scale;
    if (Math.abs(y - cy) > 0.5) throw new Error(`old impact t=${b.t.toFixed(3)} y=${y.toFixed(2)}`);
    checked++;
  }
  for (const imp of impacts) {
    if (imp.t > seconds) continue;
    if (!oldTimes.some((t) => Math.abs(t - imp.t) < 1e-6)) {
      throw new Error(`旧版缺少撞击点 t=${imp.t.toFixed(3)}`);
    }
  }
  console.log(`preflight(old): ${checked} 个撞击帧 58% ✓  与新版撞击点一致 ✓  坐标有限 ✓`);
}

function report(out: string, seconds: number): void {
  console.log(`\n完成: ${out}  (${seconds.toFixed(2)}s)`);
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1',
    out,
  ]);
  process.stdout.write(probe.stdout);
}
