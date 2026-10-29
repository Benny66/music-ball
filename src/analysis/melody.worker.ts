/// <reference lib="webworker" />
import * as tf from '@tensorflow/tfjs';
import { runBasicPitch } from './melody-model.ts';
import { fftMelody } from './melody.ts';
import type { MelodyBackend, MelodyNote, MelodyResult } from './melody.ts';

interface Request {
  pcm: Float32Array;
  sampleRate: number;
  backend?: 'auto' | 'webgl' | 'cpu';
}

type Response =
  | { type: 'progress'; phase: 'model' | 'infer'; ratio: number; backend?: MelodyBackend }
  | {
      type: 'done';
      notes: MelodyNote[];
      source: MelodyResult['source'];
      backend: MelodyBackend;
      fallbackReason?: string;
      message?: string;
    }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
};

// tfjs 3.21 的 PlatformBrowser.setTimeoutCustom 直接引用 window；
// Worker 里补一个别名，再关掉 postMessage 栅栏优化，走普通 setTimeout。
// 这是 3.x 的已知问题；升级 tfjs 前保留补丁与注释。
const g = globalThis as unknown as Record<string, unknown>;
g.window = g;
tf.env().set('USE_SETTIMEOUTCUSTOM', false);

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface BackendChoice {
  backend: 'webgl' | 'cpu';
  fallbackReason?: string;
}

async function chooseBackend(pref: 'auto' | 'webgl' | 'cpu'): Promise<BackendChoice> {
  if (pref === 'cpu') {
    await tf.setBackend('cpu');
    await tf.ready();
    return { backend: 'cpu' };
  }

  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas 不可用');
    if (!new OffscreenCanvas(1, 1).getContext('webgl2')) throw new Error('WebGL2 不可用');
    await withTimeout(
      (async () => {
        await tf.setBackend('webgl');
        await tf.ready();
      })(),
      8000,
      'WebGL 后端初始化超时',
    );
    if (tf.getBackend() !== 'webgl') {
      throw new Error(`WebGL 后端未生效（${tf.getBackend()}）`);
    }
    return { backend: 'webgl' };
  } catch (err) {
    const fallbackReason = errorText(err);
    await tf.setBackend('cpu');
    await tf.ready();
    return { backend: 'cpu', fallbackReason };
  }
}

scope.onmessage = async (ev) => {
  const { pcm, sampleRate, backend: pref = 'auto' } = ev.data;
  try {
    let choice = await chooseBackend(pref);
    scope.postMessage({
      type: 'progress',
      phase: 'model',
      ratio: 0,
      backend: choice.backend,
    } satisfies Response);

    let result: MelodyResult;
    const infer = (): Promise<MelodyResult> =>
      runBasicPitch(pcm, (ratio) => {
        scope.postMessage({
          type: 'progress',
          phase: 'infer',
          ratio,
          backend: choice.backend,
        } satisfies Response);
      });

    try {
      result = await infer();
    } catch (err) {
      if (choice.backend !== 'webgl') throw err;
      // WebGL 推理中途失败：切回 CPU 重跑，保证仍然拿到音符
      const reason = `WebGL 推理失败：${errorText(err)}`;
      await tf.setBackend('cpu');
      await tf.ready();
      choice = {
        backend: 'cpu',
        fallbackReason: choice.fallbackReason ? `${choice.fallbackReason}；${reason}` : reason,
      };
      scope.postMessage({
        type: 'progress',
        phase: 'infer',
        ratio: 0,
        backend: 'cpu',
      } satisfies Response);
      result = await infer();
    }

    scope.postMessage({
      type: 'done',
      notes: result.notes,
      source: result.source,
      backend: choice.backend,
      fallbackReason: choice.fallbackReason,
    } satisfies Response);
  } catch (err) {
    try {
      scope.postMessage({ type: 'progress', phase: 'infer', ratio: 1, backend: 'fallback' } satisfies Response);
      const notes = fftMelody(pcm, sampleRate);
      scope.postMessage({
        type: 'done',
        notes,
        source: 'fft-fallback',
        backend: 'fallback',
        fallbackReason: errorText(err),
        message: errorText(err),
      } satisfies Response);
    } catch (fallbackErr) {
      scope.postMessage({
        type: 'error',
        message: errorText(fallbackErr),
      } satisfies Response);
    }
  }
};
