/**
 * basic-pitch 后处理（outputToNotesPoly）的本地快速版本。
 *
 * Adapted from @spotify/basic-pitch 1.0.1, Copyright Spotify AB, Apache-2.0.
 * See node_modules/@spotify/basic-pitch/LICENSE for the full license text.
 *
 * 算法与原库保持一致；唯一区别是
 * Melodia 补充搜索不再每轮扫描整个 frames×bins 矩阵，而是维护「每行最大值 +
 * 行版本」的堆。真实钢琴 168.5s：原版补充搜索 5.4s，本实现目标 <0.5s。
 *
 * 输入/输出和原版相同；调用方仍需传 frames/onsets 的副本（原版会原地修改）。
 */

const MIDI_OFFSET = 21;
const MAX_FREQ_IDX = 87;

export interface NoteEvent {
  startFrame: number;
  durationFrames: number;
  pitchMidi: number;
  amplitude: number;
}

type Matrix = number[][];

function whereGreaterThanAxis1(arr2d: Matrix, threshold: number): [number[], number[]] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < arr2d.length; i++) {
    for (let j = 0; j < arr2d[i].length; j++) {
      if (arr2d[i][j] > threshold) {
        xs.push(i);
        ys.push(j);
      }
    }
  }
  return [xs, ys];
}

function meanStdDev(array: Matrix): [number, number] {
  let sum = 0;
  let sumSquared = 0;
  let count = 0;
  for (const row of array) {
    for (const value of row) {
      sum += value;
      sumSquared += value * value;
      count++;
    }
  }
  const mean = sum / count;
  const std = Math.sqrt((1 / (count - 1)) * (sumSquared - (sum * sum) / count));
  return [mean, std];
}

function globalMax(array: Matrix): number {
  let max = 0;
  for (const row of array) for (const value of row) if (value > max) max = value;
  return max;
}

function min3dForAxis0(array: Matrix[]): Matrix {
  const minArray = array[0].map((v) => v.slice());
  for (let x = 1; x < array.length; ++x) {
    for (let y = 0; y < array[0].length; ++y) {
      for (let z = 0; z < array[0][0].length; ++z) {
        minArray[y][z] = Math.min(minArray[y][z], array[x][y][z]);
      }
    }
  }
  return minArray;
}

function max3dForAxis0(array: Matrix[]): Matrix {
  const maxArray = array[0].map((v) => v.slice());
  for (let x = 1; x < array.length; ++x) {
    for (let y = 0; y < array[0].length; ++y) {
      for (let z = 0; z < array[0][0].length; ++z) {
        maxArray[y][z] = Math.max(maxArray[y][z], array[x][y][z]);
      }
    }
  }
  return maxArray;
}

function argRelMax(array: Matrix, order = 1): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (let col = 0; col < array[0].length; ++col) {
    for (let row = 0; row < array.length; ++row) {
      let isRelMax = true;
      for (
        let comparisonRow = Math.max(0, row - order);
        isRelMax && comparisonRow <= Math.min(array.length - 1, row + order);
        ++comparisonRow
      ) {
        if (comparisonRow !== row) {
          isRelMax = isRelMax && array[row][col] > array[comparisonRow][col];
        }
      }
      if (isRelMax) result.push([row, col]);
    }
  }
  return result;
}

function constrainFrequency(
  onsets: Matrix,
  frames: Matrix,
  maxFreq: number | null,
  minFreq: number | null,
): void {
  if (maxFreq) {
    const maxFreqIdx = 12 * (Math.log2(maxFreq) - Math.log2(440)) + 69 - MIDI_OFFSET;
    for (const row of onsets) row.fill(0, maxFreqIdx);
    for (const row of frames) row.fill(0, maxFreqIdx);
  }
  if (minFreq) {
    const minFreqIdx = 12 * (Math.log2(minFreq) - Math.log2(440)) + 69 - MIDI_OFFSET;
    for (const row of onsets) row.fill(0, 0, minFreqIdx);
    for (const row of frames) row.fill(0, 0, minFreqIdx);
  }
}

function getInferredOnsets(onsets: Matrix, frames: Matrix, nDiff = 2): Matrix {
  const diffs = Array.from(Array(nDiff).keys())
    .map((n) => n + 1)
    .map((n) => {
      const framesAppended: Matrix = Array(n)
        .fill(Array(frames[0].length).fill(0))
        .concat(frames);
      const nPlus = framesAppended.slice(n);
      const minusN = framesAppended.slice(0, -n);
      if (nPlus.length !== minusN.length) {
        throw new Error(`nPlus length !== minusN length: ${nPlus.length} !== ${minusN.length}`);
      }
      return nPlus.map((row, r) => row.map((v, c) => v - minusN[r][c]));
    });
  let frameDiff = min3dForAxis0(diffs);
  frameDiff = frameDiff.map((row) => row.map((v) => Math.max(v, 0)));
  frameDiff = frameDiff.map((row, r) => (r < nDiff ? row.fill(0) : row));
  const onsetMax = globalMax(onsets);
  const frameDiffMax = globalMax(frameDiff);
  frameDiff = frameDiff.map((row) => row.map((v) => (onsetMax * v) / frameDiffMax));
  return max3dForAxis0([onsets, frameDiff]);
}

/** 行最大值堆：按值降序，同值按行号升序，和原版全局扫描的取点顺序一致。 */
class RowMaxHeap {
  private rows: number[] = [];
  private values: number[] = [];
  private versions: number[] = [];

  get size(): number {
    return this.rows.length;
  }

  push(row: number, value: number, version: number): void {
    this.rows.push(row);
    this.values.push(value);
    this.versions.push(version);
    this.up(this.rows.length - 1);
  }

  pop(): { row: number; value: number; version: number } | null {
    if (this.rows.length === 0) return null;
    const top = { row: this.rows[0], value: this.values[0], version: this.versions[0] };
    const last = this.rows.length - 1;
    if (last > 0) {
      this.rows[0] = this.rows[last];
      this.values[0] = this.values[last];
      this.versions[0] = this.versions[last];
    }
    this.rows.pop();
    this.values.pop();
    this.versions.pop();
    if (this.rows.length > 0) this.down(0);
    return top;
  }

  private better(a: number, b: number): boolean {
    const va = this.values[a];
    const vb = this.values[b];
    return va > vb || (va === vb && this.rows[a] < this.rows[b]);
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.better(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private down(i: number): void {
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < this.rows.length && this.better(left, best)) best = left;
      if (right < this.rows.length && this.better(right, best)) best = right;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
  }

  private swap(a: number, b: number): void {
    [this.rows[a], this.rows[b]] = [this.rows[b], this.rows[a]];
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
    [this.versions[a], this.versions[b]] = [this.versions[b], this.versions[a]];
  }
}

export function outputToNotesPolyFast(
  frames: Matrix,
  onsets: Matrix,
  onsetThresh = 0.5,
  frameThresh = 0.3,
  minNoteLen = 5,
  inferOnsets = true,
  maxFreq: number | null = null,
  minFreq: number | null = null,
  melodiaTrick = true,
  energyTolerance = 11,
): NoteEvent[] {
  let inferredFrameThresh = frameThresh;
  if (inferredFrameThresh === null) {
    const [mean, std] = meanStdDev(frames);
    inferredFrameThresh = mean + std;
  }
  const nFrames = frames.length;
  constrainFrequency(onsets, frames, maxFreq, minFreq);
  let inferredOnsets = onsets;
  if (inferOnsets) inferredOnsets = getInferredOnsets(onsets, frames);

  const peakThresholdMatrix = inferredOnsets.map((o) => o.map(() => 0));
  for (const [row, col] of argRelMax(inferredOnsets)) {
    peakThresholdMatrix[row][col] = inferredOnsets[row][col];
  }
  const [noteStarts, freqIdxs] = whereGreaterThanAxis1(peakThresholdMatrix, onsetThresh);
  noteStarts.reverse();
  freqIdxs.reverse();

  const remainingEnergy = frames.map((frame) => frame.slice());
  const noteEvents: NoteEvent[] = [];

  for (let idx = 0; idx < noteStarts.length; idx++) {
    const noteStartIdx = noteStarts[idx];
    const freqIdx = freqIdxs[idx];
    if (noteStartIdx >= nFrames - 1) continue;
    let i = noteStartIdx + 1;
    let k = 0;
    while (i < nFrames - 1 && k < energyTolerance) {
      if (remainingEnergy[i][freqIdx] < inferredFrameThresh) k += 1;
      else k = 0;
      i += 1;
    }
    i -= k;
    if (i - noteStartIdx <= minNoteLen) continue;
    for (let j = noteStartIdx; j < i; ++j) {
      remainingEnergy[j][freqIdx] = 0;
      if (freqIdx < MAX_FREQ_IDX) remainingEnergy[j][freqIdx + 1] = 0;
      if (freqIdx > 0) remainingEnergy[j][freqIdx - 1] = 0;
    }
    let amplitude = 0;
    for (let j = noteStartIdx; j < i; j++) amplitude += frames[j][freqIdx];
    noteEvents.push({
      startFrame: noteStartIdx,
      durationFrames: i - noteStartIdx,
      pitchMidi: freqIdx + MIDI_OFFSET,
      amplitude: amplitude / (i - noteStartIdx),
    });
  }

  if (melodiaTrick) {
    // 每行的当前最大值 + 版本；堆里只放 > 阈值的行，失效条目靠版本丢弃。
    const rowMax = new Float64Array(nFrames);
    const rowCol = new Int32Array(nFrames);
    const version = new Int32Array(nFrames);
    const heap = new RowMaxHeap();
    const refresh = (row: number): void => {
      let max = -Infinity;
      let col = -1;
      const values = remainingEnergy[row];
      for (let c = 0; c < values.length; c++) {
        if (values[c] >= max) {
          max = values[c];
          col = c;
        }
      }
      rowMax[row] = max;
      rowCol[row] = col;
      version[row]++;
      if (max > inferredFrameThresh) heap.push(row, max, version[row]);
    };

    for (let r = 0; r < nFrames; r++) {
      let max = -Infinity;
      let col = -1;
      const values = remainingEnergy[r];
      for (let c = 0; c < values.length; c++) {
        if (values[c] >= max) {
          max = values[c];
          col = c;
        }
      }
      rowMax[r] = max;
      rowCol[r] = col;
      if (max > inferredFrameThresh) heap.push(r, max, 0);
    }

    const affected = new Set<number>();
    while (heap.size > 0) {
      const top = heap.pop();
      if (!top) break;
      if (top.version !== version[top.row] || top.value !== rowMax[top.row]) continue;
      if (top.value <= inferredFrameThresh) break;

      const iMid = top.row;
      const freqIdx = rowCol[iMid];
      remainingEnergy[iMid][freqIdx] = 0;
      affected.clear();
      affected.add(iMid);
      const touch = (row: number): void => {
        const col = rowCol[row];
        if (col === freqIdx || col === freqIdx - 1 || col === freqIdx + 1) affected.add(row);
      };

      let i = iMid + 1;
      let k = 0;
      while (i < nFrames - 1 && k < energyTolerance) {
        if (remainingEnergy[i][freqIdx] < inferredFrameThresh) k += 1;
        else k = 0;
        remainingEnergy[i][freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remainingEnergy[i][freqIdx + 1] = 0;
        if (freqIdx > 0) remainingEnergy[i][freqIdx - 1] = 0;
        touch(i);
        i += 1;
      }
      const iEnd = i - 1 - k;
      i = iMid - 1;
      k = 0;
      while (i > 0 && k < energyTolerance) {
        if (remainingEnergy[i][freqIdx] < inferredFrameThresh) k += 1;
        else k = 0;
        remainingEnergy[i][freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remainingEnergy[i][freqIdx + 1] = 0;
        if (freqIdx > 0) remainingEnergy[i][freqIdx - 1] = 0;
        touch(i);
        i -= 1;
      }
      const iStart = i + 1 + k;
      if (iStart < 0) throw new Error(`iStart is not positive! value: ${iStart}`);
      if (iEnd >= nFrames) {
        throw new Error(`iEnd is past end of times. (iEnd, times.length): (${iEnd}, ${nFrames})`);
      }
      for (const row of affected) refresh(row);

      if (iEnd - iStart <= minNoteLen) continue;
      let amplitude = 0;
      for (let j = iStart; j < iEnd; j++) amplitude += frames[j][freqIdx];
      noteEvents.push({
        startFrame: iStart,
        durationFrames: iEnd - iStart,
        pitchMidi: freqIdx + MIDI_OFFSET,
        amplitude: amplitude / (iEnd - iStart),
      });
    }
  }

  return noteEvents;
}
