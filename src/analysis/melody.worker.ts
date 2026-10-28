/// <reference lib="webworker" />
import * as tf from '@tensorflow/tfjs';
import { runBasicPitch } from './melody-model.ts';
import { fftMelody } from './melody.ts';
import type { MelodyNote, MelodyResult } from './melody.ts';

interface Request {
  pcm: Float32Array;
  sampleRate: number;
}

type Response =
  | { type: 'progress'; phase: 'model' | 'infer'; ratio: number }
  | {
      type: 'done';
      notes: MelodyNote[];
      source: MelodyResult['source'];
      backend: string;
      message?: string;
    }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
};

async function chooseBackend(): Promise<string> {
  // TFJS 3.21 的 WebGL 后端会引用 window（Worker 里没有），直接卡住；
  // Worker 固定用 CPU，主线程不再被模型阻塞。
  await tf.setBackend('cpu');
  await tf.ready();
  return tf.getBackend();
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

scope.onmessage = async (ev) => {
  const { pcm, sampleRate } = ev.data;
  try {
    const backend = await chooseBackend();
    scope.postMessage({ type: 'progress', phase: 'model', ratio: 0 } satisfies Response);
    const result = await runBasicPitch(pcm, (ratio) => {
      scope.postMessage({ type: 'progress', phase: 'infer', ratio } satisfies Response);
    });
    scope.postMessage({
      type: 'done',
      notes: result.notes,
      source: result.source,
      backend,
    } satisfies Response);
  } catch (err) {
    try {
      scope.postMessage({ type: 'progress', phase: 'infer', ratio: 1 } satisfies Response);
      const notes = fftMelody(pcm, sampleRate);
      scope.postMessage({
        type: 'done',
        notes,
        source: 'fft-fallback',
        backend: 'fallback',
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
