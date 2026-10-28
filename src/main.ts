import { Transport } from './audio/clock.ts';
import { decodeFile, type DecodedAudio } from './audio/decode.ts';
import { analyzeInWorker } from './analysis/client.ts';
import { buildChart, DEFAULT_TRACK_W } from './chart/build.ts';
import { createAssets, type Assets } from './render/assets.ts';
import { createScratch, draw, type Scratch } from './render/draw.ts';
import { exportMp4, ExportCancelled, webCodecsAvailable } from './export/mp4.ts';
import { drawWaveform } from './ui/waveform.ts';
import { extractMelody, snapNotesToOnsets, type MelodyResult } from './analysis/melody.ts';
import { selectRhythmMode, type RhythmSource } from './analysis/rhythm-mode.ts';
import {
  mixBuffers,
  notesFromChart,
  renderGlassTrack,
  resampleTo48k,
  rmsOf,
  type GlassNote,
} from './audio/glass.ts';
import type { Ctx2D, MakeCanvas, View } from './render/theme.ts';
import type { AnalysisResult, Chart } from './types.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const PREVIEW_W = 720;
const VIEW_H = 1600;
const EXPORT_W = 1080;
const EXPORT_H = 1920;
const FPS = 60;
const VIDEO_BITRATE = 10_000_000;

// ---------- 状态 ----------

const audioCtx = new AudioContext();
const transport = new Transport(audioCtx);

/**
 * 解码专用上下文，固定 44.1kHz。
 *
 * 不能直接拿 audioCtx 解码：它的采样率跟着系统输出设备走（蓝牙耳机切成 HFP 通话模式时
 * 会掉到 16kHz），decodeAudioData 会把整首歌重采样成 16kHz —— 音质崩了、AAC 配置变了、
 * 连拍点分析结果都会随设备漂移。用固定采样率的离线上下文，三者都稳定。
 */
const DECODE_SR = 44100;
const decodeCtx = new OfflineAudioContext(1, 1, DECODE_SR);

let decoded: DecodedAudio | null = null;
let analysis: AnalysisResult | null = null;
let chart: Chart | null = null;

let seed = 0x5eed;
let speedV = 520;
let stride = 1;
let drama = 0.7;
let offsetSec = 0;
/** 只影响导出。预览侧的耳机延迟由 previewOffsetSec 承担，两者绝不能共用 ——
 *  否则用户为耳机把预览调准了，导出的 mp4 就跟着歪了。 */
let exportOffsetSec = 0;
let dof = 1;
let rhythmSource: RhythmSource = 'auto';
/** 自动判断的结果：有旋律音符且鼓组占比低（钢琴/器乐）→ 音符驱动 */
let rhythmEffective: 'notes' | 'grid' = 'grid';
let rhythmReason = '';

type AudioMode = 'glass' | 'original' | 'mix';
let audioMode: AudioMode = 'glass';
let glassBuffer: AudioBuffer | null = null;
let melodyResult: MelodyResult | null = null;
const finalCache = new Map<AudioMode, AudioBuffer>();
/** chart 参数变了（seed/drama/dof）玻璃轨就要重渲；滑杆拖动时用防抖，避免每帧都离线渲染 */
let glassStale = false;
let audioRefreshTimer = 0;

let dirty = true;
let scrubbing = false;
let busy = false;
let exporting = false;
let cancelRequested = false;

// ---------- 画布 ----------

const viewCanvas = $<HTMLCanvasElement>('view');
const previewCtx = viewCanvas.getContext('2d') as unknown as Ctx2D;
const makeCanvas: MakeCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

const previewView: View = { w: PREVIEW_W, h: Math.round((PREVIEW_W * VIEW_H) / DEFAULT_TRACK_W), scale: PREVIEW_W / DEFAULT_TRACK_W };
viewCanvas.width = previewView.w;
viewCanvas.height = previewView.h;

const previewAssets: Assets = createAssets(makeCanvas, previewView);
const previewScratch: Scratch = createScratch();

// ---------- 工具 ----------

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function showLog(msg: string): void {
  const el = $('log');
  el.hidden = false;
  el.textContent = msg;
}

function clearLog(): void {
  const el = $('log');
  el.hidden = true;
  el.textContent = '';
}

// ---------- 渲染循环 ----------

function renderNow(): void {
  if (!chart) return;
  draw(
    previewCtx,
    chart,
    transport.time + offsetSec - transport.outputCompensation,
    previewView,
    previewAssets,
    previewScratch,
  );
}

let lastSeekSync = 0;

function loop(): void {
  if (chart && (transport.playing || dirty)) {
    renderNow();
    dirty = false;
  }
  if (chart) {
    const now = performance.now();
    if (now - lastSeekSync > 60) {
      lastSeekSync = now;
      syncTransportUi();
    }
  }
requestAnimationFrame(loop);
}

function syncTransportUi(): void {
  const dur = transport.duration || 0;
  const t = transport.time;
  if (!scrubbing) {
    const seek = $<HTMLInputElement>('seek');
    seek.value = String(dur > 0 ? Math.round((t / dur) * 1000) : 0);
  }
  $('time').textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  $('play').textContent = transport.playing ? '❚❚' : '▶';
}

// ---------- 建图 ----------

function buildGlassNotes(): GlassNote[] {
  if (!chart) return [];
  return notesFromChart(chart, melodyResult?.notes ?? null);
}

async function ensureGlass(): Promise<AudioBuffer> {
  if (glassBuffer && !glassStale) return glassBuffer;
  if (!chart) throw new Error('还没有分析结果');
  glassBuffer = await renderGlassTrack(chart, buildGlassNotes(), { seed: 0x91a55 });
  glassStale = false;
  return glassBuffer;
}

/** 三种音频模式共用这一层：懒生成 + 缓存，导出与预览播同一份（所听即所得） */
async function getFinalBuffer(mode: AudioMode): Promise<AudioBuffer> {
  const cached = finalCache.get(mode);
  if (cached) return cached;
  if (!decoded || !chart) throw new Error('还没有音频');

  let out: AudioBuffer;
  if (mode === 'glass') {
    out = await ensureGlass();
  } else if (mode === 'original') {
    out = await resampleTo48k(decoded.buffer);
  } else {
    const g = await ensureGlass();
    const o = await resampleTo48k(decoded.buffer);
    // RMS 归一：玻璃轨整体比原曲低 6dB，避免盖过旋律
    const gain = Math.min(2, ((rmsOf(o) || 0.01) / (rmsOf(g) || 0.01)) * 0.5);
    out = await mixBuffers(g, o, gain);
  }
  finalCache.set(mode, out);
  return out;
}

async function applyAudioMode(mode: AudioMode): Promise<void> {
  audioMode = mode;
  const btn = $<HTMLButtonElement>('exportBtn');
  btn.disabled = true;
  try {
    const buf = await getFinalBuffer(mode);
    await transport.swapBuffer(buf);
    dirty = true;
  } catch (err) {
    showLog(`切换音轨失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = exporting;
  }
}

function updateRhythmUi(): void {
  const isNotes = rhythmEffective === 'notes';
  const note = $('rhythmNote');
  note.textContent = `${isNotes ? '音符驱动' : '节拍网格'} · ${rhythmReason}`;
  note.classList.toggle('warn', /回退|不足|还未|失败/.test(rhythmReason));
  const density = $<HTMLSelectElement>('density');
  density.disabled = isNotes;
  density.title = isNotes ? '音符驱动模式下板子由音符起音决定，密度固定' : '';
  $('densityNote').textContent = isNotes ? '音符模式固定' : '';
}

/** 自动判断节奏来源：无鼓组（kick 占比低）且有足够的旋律音符 → 音符驱动 */
function updateRhythm(res: AnalysisResult): void {
  const decision = selectRhythmMode(res, melodyResult, rhythmSource);
  rhythmEffective = decision.mode;
  rhythmReason = decision.reason;
  updateRhythmUi();
}

function rebuild(): void {
  if (!analysis) return;
  const noteSource =
    rhythmEffective === 'notes' && melodyResult?.source === 'basic-pitch' ? melodyResult.notes : null;
  chart = buildChart(analysis, {
    V: speedV,
    stride,
    seed,
    drama,
    dof,
    noteSource,
  });
  $('seedVal').textContent = `#${seed}`;
  // 玻璃轨依赖 chart（声像/衰减/音高），作废并防抖刷新
  glassStale = true;
  finalCache.delete('glass');
  finalCache.delete('mix');
  if (audioRefreshTimer) clearTimeout(audioRefreshTimer);
  audioRefreshTimer = window.setTimeout(() => {
    audioRefreshTimer = 0;
    if (decoded) void applyAudioMode(audioMode);
  }, 450);
  dirty = true;
}

function applyAnalysis(res: AnalysisResult): void {
  analysis = res;
  // 新歌先清掉上一首的旋律，否则第一张图会用旧歌的判定
  melodyResult = null;
  glassBuffer = null;
  finalCache.clear();
  updateRhythm(res);
  rebuild();

  const chip = $('chipBpm');
  const bpm = res.bpm;
  const reg = res.quality?.regularity ?? 1;
  chip.textContent = `${bpm.toFixed(1)} BPM`;
  const lowConf = res.bpmConfidence < 0.35 || reg < 0.85;
  chip.classList.toggle('warn', lowConf);
  chip.title =
    reg < 0.85
      ? `拍点规律度只有 ${(reg * 100).toFixed(0)}%，这首的节奏可能没对准（切分/变速/半速）`
      : `节拍识别置信度良好（规律度 ${(reg * 100).toFixed(0)}%）`;

  const detected = res.beats.filter((b) => !b.synthetic).length;
  const lat = $('latencyNote');
  if (lat) {
    const auto = Math.round(transport.outputCompensation * 1000);
    lat.textContent =
      `已自动补偿输出设备延迟 ${auto} ms（仅预览；导出不受影响）` +
      (transport.outputSuspicious ? ' · 检测到异常采样率，建议换有线/内置扬声器核对' : '');
  }
  $('fileMeta').textContent =
    `${fmtTime(res.duration)} · ${detected} 个拍点 · ${res.sr} Hz · 拍点规律度 ${(reg * 100).toFixed(0)}%` +
    (lowConf ? ' · 这首节奏不规整，可以试试「时间微调」' : '');

  drawWaveform($<HTMLCanvasElement>('wave'), res);
  void applyAudioMode(audioMode);
  $('info').hidden = false;
  $('transport').hidden = false;
  $('params').hidden = false;
  $('exportBox').hidden = false;
  $('empty').hidden = true;
  const badge = $('badge');
  badge.hidden = false;
  badge.textContent = `${bpm.toFixed(0)} BPM · ${detected} beats`;
}

// ---------- 加载 ----------

async function loadFile(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  clearLog();
  $('fileName').textContent = file.name;

  try {
    if (!/^audio\//.test(file.type) && !/\.(mp3|wav|m4a|flac|ogg|aac|opus)$/i.test(file.name)) {
      throw new Error('这看起来不是音频文件。请选择 mp3 / wav / m4a。');
    }

    const t0 = performance.now();
    const dec = await decodeFile(file, decodeCtx);
    if (dec.duration < 1) throw new Error('音频太短了（不足 1 秒）');

    decoded = dec;
    transport.setBuffer(dec.buffer);

    const pcmCopy = dec.pcm.slice();
    const res = await analyzeInWorker(pcmCopy, dec.sr, dec.duration, (p) => {
      const map: Record<string, string> = {
        flux: '计算节拍强度…',
        tempo: '估计速度…',
        beats: '跟踪拍点…',
        classify: '分类鼓组…',
      };
      const lat = $('latencyNote');
  if (lat) {
    const auto = Math.round(transport.outputCompensation * 1000);
    lat.textContent =
      `已自动补偿输出设备延迟 ${auto} ms（仅预览；导出不受影响）` +
      (transport.outputSuspicious ? ' · 检测到异常采样率，建议换有线/内置扬声器核对' : '');
  }
  $('fileMeta').textContent = map[p.phase] ?? '分析中…';
    });

    const ms = Math.round(performance.now() - t0);
    applyAnalysis(res);
    $('fileMeta').textContent += ` · 分析耗时 ${ms}ms`;
    dirty = true;

    // 旋律提取（玻璃声的音高来源）。失败时内部自动降级成 FFT 主峰。
    try {
      const mel = await extractMelody(dec.pcm, dec.sr, (p) => {
        $('fileMeta').textContent = `提取旋律 ${(p * 100).toFixed(0)}% …`;
      });
      const refined =
        mel.source === 'basic-pitch' ? snapNotesToOnsets(mel.notes, res.onsets ?? []) : mel.notes;
      melodyResult = { notes: refined, source: mel.source };
      glassStale = true;
      finalCache.delete('glass');
      finalCache.delete('mix');
      $('fileMeta').textContent +=
        ` · 旋律 ${refined.length} 个音（${mel.source === 'basic-pitch' ? '模型' : 'FFT 降级'}）`;
      updateRhythm(res);
      rebuild();
      await applyAudioMode(audioMode);
    } catch {
      $('fileMeta').textContent += ' · 旋律提取失败，玻璃声改用鼓组音高';
      if (analysis && rhythmSource !== 'grid' && rhythmEffective !== 'notes') {
        rhythmReason = '旋律提取失败，已回退节拍驱动';
        updateRhythmUi();
        rebuild();
      }
      await applyAudioMode(audioMode);
    }
  } catch (err) {
    showLog(err instanceof Error ? err.message : String(err));
  } finally {
    busy = false;
  }
}

// ---------- 导出 ----------

async function runExport(): Promise<void> {
  if (!chart || !decoded || exporting) return;

  if (!webCodecsAvailable()) {
    showLog('这个浏览器不支持 WebCodecs，无法在本地导出 MP4。\n请使用 Chrome / Edge，或 Safari 26+。');
    return;
  }

  exporting = true;
  cancelRequested = false;
  clearLog();

  const exportBtn = $<HTMLButtonElement>('exportBtn');
  exportBtn.disabled = true;
  $('progressWrap').hidden = false;

  const setProgress = (ratio: number, label: string): void => {
    $<HTMLElement>('progressBar').style.width = `${Math.round(Math.min(1, ratio) * 100)}%`;
    $('progressText').textContent = label;
  };
  setProgress(0, '准备中…');

  let writable: WritableStream<unknown> | null = null;
  const picker = (window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<WritableStream<unknown>> }>;
  }).showSaveFilePicker;

  try {
    if (picker) {
      try {
        const base = (decoded ? 'music-ball' : 'out').replace(/\s+/g, '-');
        const handle = await picker({
          suggestedName: `${base}.mp4`,
          types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
        });
        writable = await handle.createWritable();
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        writable = null; // 其他错误就退回内存导出
      }
    }

    // 导出画布用 1080×1920 单独渲染，与预览共用同一个 draw()
    const canvas = document.createElement('canvas');
    canvas.width = EXPORT_W;
    canvas.height = EXPORT_H;
    const exportView: View = { w: EXPORT_W, h: EXPORT_H, scale: EXPORT_W / DEFAULT_TRACK_W };
    const exportAssets = createAssets(makeCanvas, exportView);

    const t0 = performance.now();
    const result = await exportMp4({
      chart,
      audioBuffer: await getFinalBuffer(audioMode),
      canvas,
      view: exportView,
      assets: exportAssets,
      scratch: createScratch(),
      fps: FPS,
      videoBitrate: VIDEO_BITRATE,
      probeCtx: decodeCtx,
      timeOffset: exportOffsetSec,
      writable,
      isCancelled: () => cancelRequested,
      onProgress: setProgress,
    });

    const secs = (performance.now() - t0) / 1000;

    if (result.blob) {
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'music-ball.mp4';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    setProgress(
      1,
      `完成 · ${(result.frames / FPS).toFixed(1)}s / ${result.frames} 帧 · 耗时 ${secs.toFixed(1)}s · ` +
        `已补偿音频延迟 ${Math.round(result.audioDelay * 1000)}ms`,
    );
  } catch (err) {
    if (err instanceof ExportCancelled) {
      setProgress(0, '已取消');
    } else {
      setProgress(0, '导出失败');
      showLog(`导出出错：${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    exporting = false;
    exportBtn.disabled = false;
    setTimeout(() => {
      if (!exporting) $('progressWrap').hidden = true;
    }, 4000);
  }
}

// ---------- 事件绑定 ----------

$('pick').addEventListener('click', () => $<HTMLInputElement>('file').click());
$('pickEmpty').addEventListener('click', () => $<HTMLInputElement>('file').click());

$('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadFile(f);
});

const stage = $('stage');
stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('dragover');
});
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});

$('play').addEventListener('click', () => {
  if (!decoded) return;
  if (transport.playing) transport.pause();
  else void transport.play();
});

transport.onEnded = () => {
  dirty = true;
  syncTransportUi();
};

const seekEl = $<HTMLInputElement>('seek');
seekEl.addEventListener('pointerdown', () => {
  scrubbing = true;
});
seekEl.addEventListener('input', () => {
  if (!decoded) return;
  transport.seek((Number(seekEl.value) / 1000) * transport.duration);
  dirty = true;
});
seekEl.addEventListener('pointerup', () => {
  scrubbing = false;
});

$<HTMLInputElement>('speed').addEventListener('input', (e) => {
  speedV = Number((e.target as HTMLInputElement).value);
  $('speedVal').textContent = String(speedV);
  rebuild();
});

$<HTMLSelectElement>('density').addEventListener('change', (e) => {
  stride = Number((e.target as HTMLSelectElement).value);
  rebuild();
});

$<HTMLInputElement>('dof').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  dof = v / 100;
  $('dofVal').textContent = `${v}%`;
  rebuild();
});

$<HTMLSelectElement>('rhythm').addEventListener('change', (e) => {
  rhythmSource = (e.target as HTMLSelectElement).value as RhythmSource;
  if (!analysis) return;
  updateRhythm(analysis);
  rebuild();
});

$<HTMLSelectElement>('audioMode').addEventListener('change', (e) => {
  void applyAudioMode((e.target as HTMLSelectElement).value as AudioMode);
});

$<HTMLInputElement>('drama').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  drama = v / 100;
  $('dramaVal').textContent = `${v}%`;
  rebuild();
});

$<HTMLInputElement>('offset').addEventListener('input', (e) => {
  offsetSec = Number((e.target as HTMLInputElement).value) / 1000;
  const v = Number((e.target as HTMLInputElement).value);
  $('offsetVal').textContent = `${v > 0 ? '+' : ''}${v} ms`;
  dirty = true;
});

$('reseed').addEventListener('click', () => {
  seed = Math.floor(Math.random() * 1e6) + 1;
  rebuild();
});

$('exportBtn').addEventListener('click', () => void runExport());
$('cancelBtn').addEventListener('click', () => {
  cancelRequested = true;
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && decoded && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    if (transport.playing) transport.pause();
    else void transport.play();
  }
});

// 首帧先画一次空场景，避免白屏
previewCtx.fillStyle = '#04050a';
previewCtx.fillRect(0, 0, previewView.w, previewView.h);
// 支持/调试用：暴露当前播放音轨的信息（48k = 玻璃轨，44.1k = 原曲）
const debugApi = {
  get mode() { return audioMode; },
  get playingSr() { return transport.bufferInfo?.sampleRate ?? 0; },
  get playingDur() { return +(transport.bufferInfo?.duration ?? 0).toFixed(2); },
  get glassSr() { return glassBuffer?.sampleRate ?? 0; },
  get glassStale() { return glassStale; },
  get decodedSr() { return decoded?.buffer.sampleRate ?? 0; },
  get melodyNotes() { return melodyResult?.notes ?? []; },
  get melodySource() { return melodyResult?.source ?? null; },
  get rhythm() { return rhythmEffective; },
  get rhythmReason() { return rhythmReason; },
  get chart() { return chart; },
  get analysis() { return analysis; },
  get melody() { return melodyResult; },
  async loadFromUrl(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    const blob = await res.blob();
    const name = decodeURIComponent(url.split('/').pop() || 'audio');
    await loadFile(new File([blob], name, { type: blob.type || 'audio/wav' }));
  },
  seek(t: number) {
    if (!decoded) return;
    transport.seek(Math.max(0, Math.min(transport.duration, t)));
    dirty = true;
  },
};
Object.assign(window as unknown as Record<string, unknown>, {
  __mb: debugApi,
  __musicball: debugApi,
});

requestAnimationFrame(loop);
