import {
  BasicPitch,
  outputToNotesPoly,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
} from '@spotify/basic-pitch';
import type { MelodyNote, MelodyResult } from './melody.ts';

/**
 * basic-pitch 模型路径（主线程或 Worker 都可导入）。
 *
 * 输入必须是 22050Hz 单声道 Float32Array；重采样在调用方（主线程）完成。
 * 这里不碰 DOM/OfflineAudioContext，方便跑在 Web Worker 里。
 */

let modelPromise: Promise<BasicPitch> | null = null;

function getModel(): Promise<BasicPitch> {
  if (!modelPromise) {
    modelPromise = Promise.resolve(new BasicPitch('/models/basic-pitch/model.json'));
  }
  return modelPromise;
}

export async function runBasicPitch(
  pcm22050: Float32Array,
  onProgress?: (p: number) => void,
): Promise<MelodyResult> {
  const model = await getModel();
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  await model.evaluateModel(
    pcm22050,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (p) => onProgress?.(p),
  );

  // ⚠️ outputToNotesPoly 会原地 mutate 入参 —— 必须传副本，否则重跑拿到空结果
  const poly = outputToNotesPoly(frames.slice(), onsets.slice(), 0.25, 0.25, 5);
  const bent = addPitchBendsToNoteEvents(contours.slice(), poly);
  const timed = noteFramesToTime(bent);

  const notes: MelodyNote[] = timed
    .filter((n) => Number.isFinite(n.startTimeSeconds) && Number.isFinite(n.pitchMidi))
    .map((n) => ({
      start: n.startTimeSeconds,
      end: n.startTimeSeconds + n.durationSeconds,
      midi: n.pitchMidi,
      amplitude: n.amplitude,
    }));

  if (notes.length === 0) throw new Error('basic-pitch 没有输出音符');
  return { notes, source: 'basic-pitch' };
}
