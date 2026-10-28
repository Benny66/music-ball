import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
} from 'mediabunny';
import { drawScene, type SceneScratch } from '../render/scene.ts';
import type { Scene } from '../chart/scene.ts';
import type { Assets } from '../render/assets.ts';
import type { Ctx2D, View } from '../render/theme.ts';

const AAC_CODEC = 'mp4a.40.2';

interface Level {
  idc: string;
  maxFS: number;
  maxMBPS: number;
}

/**
 * H.264 High profile 的级别上限（Annex A 表 A-1）。
 *
 * 这一步很容易踩坑：1080×1920 的宏块数是 120×68 = 8160，@60fps 需要 489600 宏块/秒，
 * 而 Level 4.0（avc1.640028）的 MaxMBPS 只有 245760 —— 恰好只够 1080p30。
 * 用 4.0 编码 60fps 会被 Chrome 直接拒绝，或者写出超规格码流导致部分播放器拒收。
 */
const LEVELS: Level[] = [
  { idc: '1f', maxFS: 1620, maxMBPS: 40500 },
  { idc: '20', maxFS: 1620, maxMBPS: 216000 },
  { idc: '28', maxFS: 8192, maxMBPS: 245760 },
  { idc: '29', maxFS: 8192, maxMBPS: 245760 },
  { idc: '2a', maxFS: 8192, maxMBPS: 522240 },
  { idc: '32', maxFS: 22080, maxMBPS: 589824 },
  { idc: '33', maxFS: 36864, maxMBPS: 983040 },
  { idc: '34', maxFS: 36864, maxMBPS: 2073600 },
];

export function pickAvcCodec(width: number, height: number, fps: number): string {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = fs * fps;
  for (const l of LEVELS) {
    if (fs <= l.maxFS && mbps <= l.maxMBPS) return `avc1.6400${l.idc}`;
  }
  return 'avc1.640034';
}

/** 浏览器能否原生编 AAC；不能就装上 WASM 版 FFmpeg AAC（API 完全一致，调用方无感） */
async function ensureAacEncoder(audioBuffer: AudioBuffer): Promise<'native' | 'wasm'> {
  const AE = (globalThis as { AudioEncoder?: any }).AudioEncoder;
  if (AE?.isConfigSupported) {
    try {
      const res = await AE.isConfigSupported({
        codec: AAC_CODEC,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: Math.min(2, audioBuffer.numberOfChannels),
        bitrate: 192_000,
      });
      if (res?.supported) return 'native';
    } catch {
      /* fall through */
    }
  }
  const mod = await import('@mediabunny/aac-encoder');
  mod.registerAacEncoder();
  return 'wasm';
}

export function webCodecsAvailable(): boolean {
  return typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined';
}

/**
 * 测量「音频编码延迟」。
 *
 * 为什么必须做：AAC 编码器会在码流前面塞 1024–2112 个采样的 priming，
 * 而 mediabunny 不写 MP4 的 edit list，于是播放器会把这些 priming 当成声音放出来，
 * 导致整条音轨延后 40–50ms（60fps 下就是 2–3 帧）。对「球必须踩在鼓点上」这个应用来说，
 * 这是肉眼可见的错位，必须补掉。
 *
 * 做法：构造一个「第 0 个采样就是脉冲」的探针，用与正片完全相同的路径编码 → 封装 → 解码，
 * 再找脉冲落在第几个采样点。这样得到的延迟对原生 AAC 和 WASM 兜底、对任何平台都成立，
 * 不需要硬编码任何「某平台大约是 2112 采样」的魔法数字。
 */
export async function measureAudioDelay(
  audioBuffer: AudioBuffer,
  ctx: BaseAudioContext,
): Promise<number> {
  const sr = audioBuffer.sampleRate;
  const channels = Math.min(2, Math.max(1, audioBuffer.numberOfChannels));
  const length = Math.round(sr * 0.25);

  const probe = ctx.createBuffer(channels, length, sr);
  for (let c = 0; c < channels; c++) {
    const data = probe.getChannelData(c);
    // 64 个采样的方波脉冲：单个采样点会被 AAC 的滤波器抹得太弱
    for (let i = 0; i < 64; i++) data[i] = i % 2 === 0 ? 0.95 : -0.95;
  }

  try {
    const target = new BufferTarget();
    const out = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target,
    });
    const src = new AudioBufferSource({
      codec: 'aac',
      quality: new Quality({ bitrate: 192_000 }),
    });
    out.addAudioTrack(src);
    await out.start();
    await src.add(probe);
    await out.finalize();

    const buffer = target.buffer;
    if (!buffer) {
      console.debug('[audio-delay] 探针没有拿到封装结果');
      return 0;
    }

    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    const data = decoded.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > 0.1) {
        console.debug(
          `[audio-delay] 命中 index=${i} → ${((i / sr) * 1000).toFixed(1)}ms`,
        );
        return i / sr;
      }
    }
    console.debug(`[audio-delay] 找不到脉冲，长度=${data.length}`);
  } catch (err) {
    console.debug('[audio-delay] 探针失败', err);
  }
  return 0;
}

export class ExportCancelled extends Error {
  constructor() {
    super('已取消');
    this.name = 'ExportCancelled';
  }
}

export interface ExportOptions {
  scene: Scene;
  audioBuffer: AudioBuffer;
  canvas: HTMLCanvasElement;
  view: View;
  assets: Assets;
  sceneScratch: SceneScratch;
  fps: number;
  videoBitrate: number;
  /** 用来解码探针音频的上下文（必须是固定采样率的离线上下文） */
  probeCtx: BaseAudioContext;
  /** 用户手动微调的时间偏移（秒），与预览保持一致 */
  timeOffset?: number;
  writable: WritableStream<unknown> | null;
  isCancelled: () => boolean;
  onProgress: (ratio: number, label: string) => void;
}

export interface ExportResult {
  blob: Blob | null;
  codec: string;
  frames: number;
  audio: 'native' | 'wasm';
  audioDelay: number;
}

export async function exportMp4(o: ExportOptions): Promise<ExportResult> {
  const ctx = o.canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 2D 上下文');

  // 先确保 AAC 编码器可用（可能会注册 WASM 兜底），再跑延迟探针 ——
  // 顺序反了的话探针会用到一个还没注册的编码器，直接失败返回 0。
  const audioMode = await ensureAacEncoder(o.audioBuffer);
  o.onProgress(0.01, '测量音频编码延迟…');
  const delay = await measureAudioDelay(o.audioBuffer, o.probeCtx);

  const codec = pickAvcCodec(o.view.w, o.view.h, o.fps);
  const useStream = o.writable !== null;

  const target = useStream
    ? new StreamTarget(o.writable as unknown as WritableStream)
    : new BufferTarget();

  const output = new Output({
    // 写盘时用 fastStart:false，省掉 finalize 时重写整个文件（3 分钟约 200MB，内存会翻倍）
    format: new Mp4OutputFormat(useStream ? { fastStart: false } : { fastStart: 'in-memory' }),
    target,
  });

  const video = new CanvasSource(o.canvas, {
    codec: 'avc',
    fullCodecString: codec,
    quality: new Quality({ bitrate: o.videoBitrate }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(video, { frameRate: o.fps });

  const audio = new AudioBufferSource({
    codec: 'aac',
    quality: new Quality({ bitrate: 192_000 }),
  });
  output.addAudioTrack(audio);

  await output.start();

  o.onProgress(0, '编码音频…');
  await audio.add(o.audioBuffer);

  const userOffset = o.timeOffset ?? 0;
  // 音频整体后移了 delay，视频就要显示 t − delay 的画面，两者才重新对齐。
  // 总帧数补上 delay 的长度，避免最后一段只有声音没有画面。
  const total = Math.max(1, Math.ceil((o.scene.chart.duration + delay) * o.fps));

  for (let i = 0; i < total; i++) {
    if (o.isCancelled()) {
      await output.cancel();
      throw new ExportCancelled();
    }

    // 第 i 帧画的就是音频第 i/fps 秒 —— 导出与实时预览共用同一个 draw()
    const t = Math.max(0, i / o.fps - delay + userOffset);
    drawScene(ctx as unknown as Ctx2D, o.scene, t, o.view, o.assets, o.sceneScratch);
    await video.add(i / o.fps, 1 / o.fps);

    if ((i & 7) === 0) {
      o.onProgress(i / total, `渲染 ${i} / ${total} 帧`);
      // 让出主线程，否则进度条不会动
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  o.onProgress(1, '封装 MP4…');
  await output.finalize();

  const buffer = (output.target as BufferTarget).buffer;
  return {
    blob: buffer ? new Blob([buffer], { type: 'video/mp4' }) : null,
    codec,
    frames: total,
    audio: audioMode,
    audioDelay: delay,
  };
}
