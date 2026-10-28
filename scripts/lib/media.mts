import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface DecodedAudio {
  pcm: Float32Array;
  sr: number;
}

/** 读 wav（16-bit PCM 单声道/立体声均可） */
export function readWav(path: string): DecodedAudio {
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
export function decodeWithFfmpeg(path: string): DecodedAudio {
  const sr = 44100;
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'],
    { maxBuffer: 1024 * 1024 * 512 },
  );
  if (r.status !== 0) throw new Error('ffmpeg decode failed: ' + r.stderr.toString());
  const b = r.stdout;
  const pcm = new Float32Array(b.length / 4);
  for (let i = 0; i < pcm.length; i++) pcm[i] = b.readFloatLE(i * 4);
  return { pcm, sr };
}

export function decodeAudioFile(path: string): DecodedAudio {
  return path.endsWith('.wav') ? readWav(path) : decodeWithFfmpeg(path);
}

export interface EncodeFramesOptions {
  output: string;
  fps: number;
  width: number;
  height: number;
  audioFile: string;
  totalFrames: number;
  /**
   * 返回一整帧 RGBA 像素（width*height*4）。
   * 调用方负责画帧；模块只负责 ffmpeg 背压、错误与退出码。
   */
  frame: (index: number) => Buffer | Uint8Array | Promise<Buffer | Uint8Array>;
  onProgress?: (index: number, total: number) => void;
}

/** 逐帧喂给 ffmpeg，封装成 H.264 + AAC 的 mp4。 */
export async function encodeFramesToMp4(opts: EncodeFramesOptions): Promise<void> {
  const { output, fps, width, height, audioFile, totalFrames, frame, onProgress } = opts;
  const expected = width * height * 4;

  const ff = spawn('ffmpeg', [
    '-y',
    '-v', 'error',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
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

  let stderr = '';
  ff.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  let streamError: Error | null = null;
  ff.stdin.on('error', (e) => {
    streamError = e;
  });

  const writeFrame = (buf: Buffer | Uint8Array): Promise<void> =>
    new Promise((res, rej) => {
      if (streamError) return rej(streamError);
      if (buf.byteLength !== expected) {
        return rej(new Error(`frame size ${buf.byteLength} != ${expected}`));
      }
      if (ff.stdin.write(buf)) return res();
      const onDrain = (): void => {
        cleanup();
        res();
      };
      const onError = (e: Error): void => {
        cleanup();
        rej(e);
      };
      const cleanup = (): void => {
        ff.stdin.off('drain', onDrain);
        ff.stdin.off('error', onError);
      };
      ff.stdin.once('drain', onDrain);
      ff.stdin.once('error', onError);
    });

  for (let i = 0; i < totalFrames; i++) {
    await writeFrame(await frame(i));
    onProgress?.(i, totalFrames);
  }

  ff.stdin.end();
  await new Promise<void>((res, rej) => {
    ff.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`ffmpeg exit ${code}${stderr ? `\n${stderr}` : ''}`));
    });
    ff.on('error', (e) => rej(e));
  });
}
