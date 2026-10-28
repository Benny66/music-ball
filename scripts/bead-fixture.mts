/**
 * 玻璃珠原型素材缓存。
 *
 * 输入是一次性从浏览器 Worker 导出的 basic-pitch 音符（可绝对时间，也可片段相对时间），
 * 输出：
 *   out/bead/clip.wav   固定窗口的真实钢琴片段
 *   out/bead/notes.json 片段相对时间的音符（{ source, notes }）
 *   out/bead/meta.json  窗口、音符/撞击密度、ffmpeg 参数
 *
 * 之后渲染只读这两份 JSON，不再跑模型。
 *
 *   node --experimental-strip-types scripts/bead-fixture.mts \
 *     --source="fixtures/real/006.夜的钢琴曲5 - 文武贝.mp3" \
 *     --notes=out/bead/notes-raw.json --start=60 --duration=18 --min-gap=0.7
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

import { boardsFromNotes } from '../src/chart/notes.ts';
import type { MelodyNote, MelodyResult } from '../src/analysis/melody.ts';

interface Args {
  source: string | null;
  notes: string;
  outDir: string;
  start: number;
  duration: number;
  minGap: number;
  shift: number;
}

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    raw[k] = v ?? '1';
  }
  return {
    source: raw.source ?? null,
    notes: resolve(raw.notes ?? 'out/bead/notes-raw.json'),
    outDir: resolve(raw['out-dir'] ?? 'out/bead'),
    start: Number(raw.start ?? 60),
    duration: Number(raw.duration ?? 18),
    minGap: Number(raw['min-gap'] ?? 0.7),
    shift: Number(raw.shift ?? 0),
  };
}

function loadNotes(path: string): { source: string; notes: MelodyNote[] } {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as MelodyResult | MelodyNote[];
  if (Array.isArray(parsed)) return { source: 'basic-pitch', notes: parsed };
  if (!Array.isArray(parsed.notes)) throw new Error('notes.json 缺少 notes 数组');
  return { source: parsed.source, notes: parsed.notes };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function cutAudio(source: string, out: string, start: number, duration: number): string[] {
  const args = [
    '-y', '-v', 'error',
    '-ss', String(start),
    '-t', String(duration),
    '-i', source,
    '-map_metadata', '-1',
    '-fflags', '+bitexact',
    '-ac', '1',
    '-ar', '44100',
    '-c:a', 'pcm_s16le',
    out,
  ];
  const r = spawnSync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) throw new Error('ffmpeg 切片失败:\n' + r.stderr.toString());
  return args;
}

function probeDuration(path: string): number {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
    { maxBuffer: 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error('ffprobe 失败:\n' + r.stderr.toString());
  return Number(r.stdout.toString().trim());
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!(args.duration > 0)) throw new Error('duration 必须 > 0');
  if (!(args.minGap > 0)) throw new Error('min-gap 必须 > 0');
  if (!existsSync(args.notes)) throw new Error(`找不到音符缓存: ${args.notes}`);

  const loaded = loadNotes(args.notes);
  const shifted: MelodyNote[] = loaded.notes
    .map((n) => ({
      start: n.start - args.shift,
      end: n.end - args.shift,
      midi: n.midi,
      amplitude: n.amplitude,
    }))
    .filter((n) => n.start >= 0 && n.start <= args.duration && n.end > n.start)
    .sort((a, b) => a.start - b.start || b.midi - a.midi);

  if (shifted.length < 80) {
    throw new Error(`窗口内只有 ${shifted.length} 个音符（要求 ≥80）`);
  }

  const impacts = boardsFromNotes(shifted, { minGap: args.minGap });
  const times = impacts.map((b) => b.t);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const med = median(gaps);
  const max = gaps.length ? Math.max(...gaps) : 0;
  if (times.length < 14 || times.length > 40) {
    throw new Error(`撞击数 ${times.length} 不在 14–40（检查窗口或 min-gap）`);
  }
  if (med < 0.5 || med > 1.4) throw new Error(`撞击中位间隔 ${med.toFixed(2)}s 不在 0.5–1.4`);
  if (max > 2.0) throw new Error(`撞击最大间隔 ${max.toFixed(2)}s 超过 2.0`);

  mkdirSync(args.outDir, { recursive: true });
  const audioOut = join(args.outDir, 'clip.wav');
  let ffmpegArgs: string[] = [];
  if (args.source) {
    ffmpegArgs = cutAudio(resolve(args.source), audioOut, args.start, args.duration);
    const dur = probeDuration(audioOut);
    if (Math.abs(dur - args.duration) > 0.1) {
      throw new Error(`切片时长 ${dur.toFixed(3)}s 与请求 ${args.duration}s 不符`);
    }
  } else if (!existsSync(audioOut)) {
    throw new Error('没有 --source，且片段音频不存在；至少提供其一');
  }

  const notesOut = join(args.outDir, 'notes.json');
  writeFileSync(notesOut, JSON.stringify({ source: loaded.source, notes: shifted }, null, 2) + '\n');

  const meta = {
    clip: {
      source: args.source ? basename(args.source) : null,
      startSec: args.start,
      durationSec: args.duration,
      audio: basename(audioOut),
      ffmpeg: ffmpegArgs,
    },
    notes: {
      source: loaded.source,
      count: shifted.length,
      firstSec: shifted[0]?.start ?? null,
      lastSec: shifted[shifted.length - 1]?.start ?? null,
      shiftSec: args.shift,
    },
    impacts: {
      minGapSec: args.minGap,
      count: times.length,
      firstSec: times[0] ?? null,
      lastSec: times[times.length - 1] ?? null,
      medianGapSec: Number(med.toFixed(4)),
      maxGapSec: Number(max.toFixed(4)),
    },
    generatedBy: 'scripts/bead-fixture.mts',
  };
  writeFileSync(join(args.outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  console.log(`clip   → ${audioOut} (${args.duration}s)`);
  console.log(`notes  → ${notesOut} (${shifted.length} 音, ${loaded.source})`);
  console.log(
    `impacts→ ${times.length} 个, 中位 ${med.toFixed(2)}s, 最大 ${max.toFixed(2)}s`,
  );
  const metaPath = join(dirname(notesOut), 'meta.json');
  console.log(`meta   → ${metaPath}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
