import type { MelodyNote, MelodyResult } from './melody.ts';

export interface MelodyProgress {
  phase: 'model' | 'infer';
  ratio: number;
}

export interface MelodyHandle {
  promise: Promise<MelodyResult>;
  cancel(): void;
}

/**
 * 在 Worker 里跑 basic-pitch 模型推理。
 * 调用方负责先把 PCM 重采样到 22050；pcm 的 buffer 会被 transfer，调用后不可再用。
 */
export function startMelodyInWorker(
  pcm: Float32Array,
  onProgress?: (p: MelodyProgress) => void,
): MelodyHandle {
  const worker = new Worker(new URL('./melody.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectFn: ((err: Error) => void) | null = null;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    worker.terminate();
  };

  const promise = new Promise<MelodyResult>((resolve, reject) => {
    rejectFn = reject;

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as
        | { type: 'progress'; phase: 'model' | 'infer'; ratio: number }
        | { type: 'done'; notes: MelodyNote[]; source: MelodyResult['source']; backend: string }
        | { type: 'error'; message: string };

      if (msg.type === 'progress') {
        onProgress?.({ phase: msg.phase, ratio: msg.ratio });
      } else if (msg.type === 'done') {
        settle();
        console.debug(`[melody] backend=${msg.backend} source=${msg.source} notes=${msg.notes.length}`);
        resolve({ notes: msg.notes, source: msg.source });
      } else {
        settle();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (e) => {
      settle();
      reject(new Error(e.message || 'melody worker 启动失败'));
    };

    worker.postMessage({ pcm, sampleRate: 22050 }, [pcm.buffer]);
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectFn?.(new Error('melody cancelled'));
    },
  };
}
