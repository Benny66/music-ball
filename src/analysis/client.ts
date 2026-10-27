import type { AnalysisResult } from '../types.ts';

export interface AnalyzeProgress {
  phase: string;
  ratio: number;
}

/**
 * 在 Worker 里跑分析，主线程只负责画进度。
 * pcm 用 transfer 传过去（不复制），前提是调用方已经 slice 出独立副本。
 */
export function analyzeInWorker(
  pcm: Float32Array,
  sr: number,
  duration: number,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

    const done = (): void => {
      worker.terminate();
    };

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as
        | { type: 'progress'; phase: string; ratio: number }
        | { type: 'done'; result: AnalysisResult }
        | { type: 'error'; message: string };

      if (msg.type === 'progress') {
        onProgress?.({ phase: msg.phase, ratio: msg.ratio });
      } else if (msg.type === 'done') {
        done();
        resolve(msg.result);
      } else {
        done();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || 'worker 启动失败'));
    };

    worker.postMessage({ pcm, sr, duration }, [pcm.buffer]);
  });
}
