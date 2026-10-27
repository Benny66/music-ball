/// <reference lib="webworker" />
import { analyze } from './pipeline.ts';
import type { AnalysisResult } from '../types.ts';

interface Request {
  pcm: Float32Array;
  sr: number;
  duration: number;
}

type Response =
  | { type: 'progress'; phase: string; ratio: number }
  | { type: 'done'; result: AnalysisResult }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
};

scope.onmessage = (ev) => {
  try {
    const { pcm, sr, duration } = ev.data;
    const result = analyze(pcm, sr, duration, {
      onProgress: (phase, ratio) => {
        scope.postMessage({ type: 'progress', phase, ratio } satisfies Response);
      },
    });
    // 包络是最大的数组，转移所有权避免复制
    scope.postMessage({ type: 'done', result } satisfies Response, [result.envelope.buffer]);
  } catch (err) {
    scope.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies Response);
  }
};
