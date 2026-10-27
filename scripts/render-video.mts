/**
 * Node 端出片：用 @napi-rs/canvas 复用浏览器里同一份 draw()，逐帧渲染后交给 ffmpeg 合成。
 *
 *   node --experimental-strip-types scripts/render-video.mts <输入.wav|mp3> <输出.mp4> [选项]
 *
 * 选项：
 *   --stills=1.2,3.4,5.6   只出这几秒的 PNG，用于调视觉（不合成视频）
 *   --seconds=12           只渲染前 N 秒
 *   --scale=0.5            渲染分辨率缩放（调试用，快 4 倍）
 *   --audio=glass|mix|original  音轨（默认 glass，与浏览器默认一致）
 *   --fps=60
 *
 * 这条路不依赖浏览器，帧精确 100%：第 N 帧画的就是音频第 N/fps 秒。
 * 浏览器端的 WebCodecs 导出走的是同一个 draw()，所以两边画面一致。
 */
import { createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../src/analysis/pipeline.ts';
import { fftMelody } from '../src/analysis/melody.ts';
import { notesFromChart } from '../src/audio/glass.ts';
import { mixInto, renderGlassTrackNode, resampleLinear, writeWavF32le } from '../src/audio/glass-node.ts';
import { buildChart } from '../src/chart/build.ts';
import { createAssets } from '../src/render/assets.ts';
import { createScratch, draw } from '../src/render/draw.ts';
import { DEFAULT_TRACK_W } from '../src/chart/build.ts';
import type { Ctx2D, MakeCanvas, View } from '../src/render/theme.ts';

interface FullCtx extends Ctx2D {
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? '1';
  }
  return out;
}

/** 读 wav（16-bit PCM 单声道/立体声均可） */
function readWav(path: string): { pcm: Float32Array; sr: number } {
  const buf = readFileSync(path);
  const sr = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const frames = Math.floor(size / 2 / channels);
      const pcm = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) {
          s += buf.readInt16LE(off + 8 + (i * channels + c) * 2) / 32768;
        }
        pcm[i] = s / channels;
      }
      return { pcm, sr };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

/** 用 ffmpeg 把任意音频解成 f32le 单声道 PCM，走的是和浏览器 decodeAudioData 等价的路径 */
function decodeWithFfmpeg(path: string): { pcm: Float32Array; sr: number } {
  const sr = 44100;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'], {
    maxBuffer: 1024 * 1024 * 512,
  });
  if (r.status !== 0) throw new Error('ffmpeg decode failed: ' + r.stderr.toString());
  const b = r.stdout;
  const pcm = new Float32Array(b.length / 4);
  for (let i = 0; i < pcm.length; i++) pcm[i] = b.readFloatLE(i * 4);
  return { pcm, sr };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const opt = parseArgs(process.argv.slice(2));
  const input = resolve(args[0] ?? join(ROOT, 'fixtures', 'steady-120.wav'));
  const output = resolve(args[1] ?? join(ROOT, 'out', 'sample.mp4'));
  const fps = Number(opt.fps ?? 60);
  const outW = Math.round(1080 * Number(opt.scale ?? 1));
  const outH = Math.round(outW * (16 / 9));
  const stills = opt.stills ? opt.stills.split(',').map(Number) : null;
  const audioMode = opt.audio ?? 'glass';

  console.log('输入:', input);
  const t0 = performance.now();
  const { pcm, sr } = input.endsWith('.wav') ? readWav(input) : decodeWithFfmpeg(input);
  const duration = pcm.length / sr;
  console.log(`解码: ${(performance.now() - t0).toFixed(0)}ms  ${duration.toFixed(2)}s  ${sr}Hz`);

  const t1 = performance.now();
  const analysis = analyze(pcm, sr, duration);
  console.log(
    `分析: ${(performance.now() - t1).toFixed(0)}ms  bpm=${analysis.bpm.toFixed(1)} ` +
      `拍=${analysis.beats.filter((b) => !b.synthetic).length} conf=${analysis.bpmConfidence.toFixed(2)}`,
  );

  const chart = buildChart(analysis);
  console.log(`chart: ${chart.boards.length} 板 / ${chart.segs.length} 段`);

  const make: MakeCanvas = (w, h) => createCanvas(w, h) as unknown as ReturnType<MakeCanvas>;
  const view: View = { w: outW, h: outH, scale: outW / DEFAULT_TRACK_W };
  const assets = createAssets(make, view);
  const scratch = createScratch();
  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d') as unknown as FullCtx;

  if (stills) {
    const dir = join(ROOT, 'out', 'stills');
    mkdirSync(dir, { recursive: true });
    for (const s of stills) {
      draw(ctx, chart, s, view, assets, scratch);
      const p = join(dir, `t${s.toFixed(2)}.png`);
      writeFileSync(p, canvas.toBuffer('image/png'));
      console.log('still →', p);
    }
    return;
  }

  const totalSec = Math.min(duration, Number(opt.seconds ?? duration));
  const totalFrames = Math.ceil(totalSec * fps);
  const frameDir = join(ROOT, 'out', 'frames');
  if (existsSync(frameDir)) rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });

  console.log(`渲染 ${totalFrames} 帧 @ ${outW}x${outH} ${fps}fps …`);
  const t2 = performance.now();
  // ---- 音轨：与浏览器导出同一套模态合成配方 ----
  let audioFile = input;
  if (audioMode !== 'original') {
    const melody = fftMelody(pcm, sr);
    const notes = notesFromChart(chart, melody);
    const glass = renderGlassTrackNode(notes, duration, 0x91a55);
    let track = glass;
    if (audioMode === 'mix') {
      const orig48 = resampleLinear(pcm, sr, 48000);
      const rms = (a: Float32Array): number => { let sum=0,cnt=0; for (let i=0;i<a.length;i+=7){sum+=a[i]*a[i];cnt++;} return cnt? Math.sqrt(sum/cnt):0.01; };
      mixInto(orig48, glass, Math.min(2, (rms(orig48)/(rms(glass)||0.01)) * 0.5));
      track = orig48;
    }
    const wavPath = join(dirname(output), 'audio-temp.wav');
    writeFileSync(wavPath, writeWavF32le(track, 48000, 1));
    audioFile = wavPath;
    console.log(`音轨: ${audioMode}（48kHz 单声道，${Math.round(track.length/48000)}s）`);
  }

  const ff = spawn('ffmpeg', [
    '-y',
    '-v', 'error',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${outW}x${outH}`,
    '-r', String(fps),
    '-i', '-',
    '-i', audioFile,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '17',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    output,
  ]);

  const writeFrame = (buf: Buffer): Promise<void> =>
    new Promise((res, rej) => {
      if (ff.stdin.write(buf)) res();
      else ff.stdin.once('drain', res);
      ff.stdin.once('error', rej);
    });

  for (let i = 0; i < totalFrames; i++) {
    draw(ctx, chart, i / fps, view, assets, scratch);
    const data = ctx.getImageData(0, 0, outW, outH).data;
    await writeFrame(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    if (i % 120 === 0) process.stdout.write(`  ${i}/${totalFrames}\r`);
  }

  ff.stdin.end();
  await new Promise<void>((res, rej) => {
    ff.on('close', (code) => (code === 0 ? res() : rej(new Error('ffmpeg exit ' + code))));
    ff.on('error', rej);
  });

  const secs = (performance.now() - t2) / 1000;
  console.log(`\n完成: ${output}`);
  console.log(`耗时 ${secs.toFixed(1)}s (${(totalSec / secs).toFixed(2)}× 实时)`);

  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name,profile',
    '-of', 'default=nw=1', output,
  ]);
  process.stdout.write(probe.stdout);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
