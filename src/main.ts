import { Transport } from './audio/clock.ts';
import { decodeFile, type DecodedAudio } from './audio/decode.ts';
import { analyzeInWorker } from './analysis/client.ts';
import { DEFAULT_TRACK_W } from './chart/build.ts';
import { buildScene, type MotionChoice, type Scene } from './chart/scene.ts';
import { impactsFromBeats } from './chart/bead.ts';
import { createAssets, type Assets } from './render/assets.ts';
import { createSceneScratch, drawScene, type SceneScratch } from './render/scene.ts';
import { exportMp4, ExportCancelled, webCodecsAvailable } from './export/mp4.ts';
import { shareProfile } from './export/profile.ts';
import { drawWaveform } from './ui/waveform.ts';
import { fftMelody, resampleTo22050, snapNotesToOnsets, type MelodyNote, type MelodyResult } from './analysis/melody.ts';
import { startMelodyInWorker, type MelodyBackendPref, type MelodyHandle } from './analysis/melody-client.ts';
import {
  cacheKey,
  clearMelodyCache,
  deleteCachedNotes,
  getCachedNotes,
  getCacheStats,
  hashFile,
  putCachedNotes,
} from './analysis/melody-cache.ts';
import { selectRhythmMode, type RhythmSource } from './analysis/rhythm-mode.ts';
import {
  mixBuffers,
  notesFromBead,
  notesFromChart,
  notesFromNatural,
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
let scene: Scene | null = null;
let chart: Chart | null = null;
let motionChoice: MotionChoice = 'auto';

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
let audioMode: AudioMode = 'original';
/** 音轨切换的请求序号：旧渲染晚返回时不能覆盖新音轨 */
let audioToken = 0;
let glassBuffer: AudioBuffer | null = null;
let melodyResult: MelodyResult | null = null;
let melodyHandle: MelodyHandle | null = null;
let melodyGen = 0;
let loadGen = 0;
let pendingMelodyApply = false;
/** 当前文件的内容哈希缓存键；缓存不可用/哈希失败时为 null */
let currentCacheKey: string | null = null;

/** 音符就绪但还没切的升级计划；at 是视觉时间轴上的过渡开始时刻 */
let pendingUpgrade: { scene: Scene; at: number } | null = null;
type UpgradeCanvas = ReturnType<MakeCanvas>;
interface UpgradeTransition {
  from: Scene;
  to: Scene;
  start: number;
  end: number;
  fromCanvas: UpgradeCanvas;
  toCanvas: UpgradeCanvas;
  fromCtx: Ctx2D;
  toCtx: Ctx2D;
  fromScratch: SceneScratch;
  toScratch: SceneScratch;
}
let upgradeTransition: UpgradeTransition | null = null;
/** 升级后玻璃音轨已过期，但为了不重启播放先不 swap；暂停/seek 时再应用 */
let pendingGlassRefresh = false;
/** 提取后端偏好：默认 auto（WebGL 优先、CPU 回退）；可用 ?melodyBackend=cpu 强制 CPU 做对照 */
const backendParam = new URLSearchParams(location.search).get('melodyBackend');
let melodyBackendPref: MelodyBackendPref =
  backendParam === 'cpu' || backendParam === 'webgl' ? backendParam : 'auto';
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
const previewScratch: SceneScratch = createSceneScratch();

// 背景/暗角是静态层：只在启动时画一次，动态画布每帧只画球/板/特效。
const stageBackdrop = $<HTMLCanvasElement>('stageBackdrop');
const stageBackdropCtx = stageBackdrop.getContext('2d') as unknown as Ctx2D;
stageBackdropCtx.drawImage(previewAssets.bg, 0, 0, previewView.w, previewView.h);
const stageVignette = $<HTMLCanvasElement>('stageVignette');
const stageVignetteCtx = stageVignette.getContext('2d') as unknown as Ctx2D;
stageVignetteCtx.drawImage(previewAssets.vignette, 0, 0, previewView.w, previewView.h);

/** 提取旋律期间固定降级：0.75× 内部分辨率 + 跳过尾迹/板外辉光，提取结束立即恢复 */
const PREVIEW_LITE_SCALE = 0.75;
const previewLiteView: View = {
  w: Math.round(PREVIEW_W * PREVIEW_LITE_SCALE),
  h: Math.round(previewView.h * PREVIEW_LITE_SCALE),
  scale: (PREVIEW_W * PREVIEW_LITE_SCALE) / DEFAULT_TRACK_W,
};
let previewLite = false;
let previewLiteAssets: Assets | null = null;

function syncPreviewQuality(): void {
  const wantLite = melodyHandle !== null;
  if (wantLite === previewLite) return;
  previewLite = wantLite;
  const v = wantLite ? previewLiteView : previewView;
  viewCanvas.width = v.w;
  viewCanvas.height = v.h;
  if (wantLite && !previewLiteAssets) previewLiteAssets = createAssets(makeCanvas, v);
  dirty = true;
}

// ---------- 工具 ----------

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function backendLabel(b: MelodyResult['backend']): string {
  if (b === 'webgl') return 'WebGL';
  if (b === 'cpu') return 'CPU';
  if (b === 'cache') return '缓存';
  if (b === 'fallback') return 'FFT';
  return '';
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
  if (!scene) return;
  syncPreviewQuality();
  const t = transport.time + offsetSec - transport.outputCompensation;

  if (upgradeTransition) {
    if (t >= upgradeTransition.end) {
      finishUpgrade();
    } else {
      drawUpgradeTransition(t);
      return;
    }
  } else if (pendingUpgrade && t >= pendingUpgrade.at) {
    beginUpgradeTransition(t);
    if (upgradeTransition) {
      drawUpgradeTransition(t);
      return;
    }
  }

  drawScene(
    previewCtx,
    scene,
    t,
    previewLite ? previewLiteView : previewView,
    previewLite ? previewLiteAssets ?? previewAssets : previewAssets,
    previewScratch,
    previewLite ? 'lite' : 'full',
    false,
  );
}

const UPGRADE_FADE_SEC = 0.26;

function clearUpgrade(): void {
  pendingUpgrade = null;
  upgradeTransition = null;
}

/** 用户手动改了节奏/运动：放弃待处理的音符升级，并让状态行说清楚。 */
function cancelUpgrade(reason: string): void {
  if (!pendingUpgrade && !upgradeTransition) return;
  pendingUpgrade = null;
  upgradeTransition = null;
  $('fileMeta').textContent += ` · ${reason}`;
}

/** 音符就绪后不阻塞播放：在最近撞击点做短交叉过渡切到音符玻璃珠。 */
function beginUpgradeTransition(t: number): void {
  const pending = pendingUpgrade;
  if (!pending || !scene) return;
  pendingUpgrade = null;
  if (t >= pending.at + UPGRADE_FADE_SEC) {
    adoptUpgrade(pending.scene);
    return;
  }
  const fromCanvas = makeCanvas(previewView.w, previewView.h);
  const toCanvas = makeCanvas(previewView.w, previewView.h);
  upgradeTransition = {
    from: scene,
    to: pending.scene,
    start: pending.at,
    end: pending.at + UPGRADE_FADE_SEC,
    fromCanvas,
    toCanvas,
    fromCtx: fromCanvas.getContext('2d') as unknown as Ctx2D,
    toCtx: toCanvas.getContext('2d') as unknown as Ctx2D,
    fromScratch: createSceneScratch(),
    toScratch: createSceneScratch(),
  };
}

function drawUpgradeTransition(t: number): void {
  const tr = upgradeTransition;
  if (!tr) return;
  const u = Math.max(0, Math.min(1, (t - tr.start) / (tr.end - tr.start)));
  const a = u * u * (3 - 2 * u);

  tr.fromCtx.clearRect(0, 0, previewView.w, previewView.h);
  tr.toCtx.clearRect(0, 0, previewView.w, previewView.h);
  drawScene(tr.fromCtx, tr.from, t, previewView, previewAssets, tr.fromScratch, 'full', false);
  drawScene(tr.toCtx, tr.to, t, previewView, previewAssets, tr.toScratch, 'full', false);

  previewCtx.clearRect(0, 0, previewView.w, previewView.h);
  previewCtx.globalAlpha = 1;
  previewCtx.drawImage(tr.fromCanvas, 0, 0, previewView.w, previewView.h);
  previewCtx.globalAlpha = a;
  previewCtx.drawImage(tr.toCanvas, 0, 0, previewView.w, previewView.h);
  previewCtx.globalAlpha = 1;
}

function adoptUpgrade(next: Scene): void {
  scene = next;
  chart = next.chart;
  pendingUpgrade = null;
  upgradeTransition = null;
  invalidateGlass();
  if (audioMode !== 'original') pendingGlassRefresh = true;
  if (analysis) updateRhythm(analysis);
  else updateMotionUi();
  $('fileMeta').textContent += ` · 已切到音符玻璃珠（${melodyResult?.notes.length ?? 0} 音）`;
  dirty = true;
}

function finishUpgrade(): void {
  const next = upgradeTransition?.to ?? pendingUpgrade?.scene;
  upgradeTransition = null;
  pendingUpgrade = null;
  if (next) adoptUpgrade(next);
}

/** 暂停/seek/播完：立刻完成待处理的升级，并补上被推迟的玻璃音轨刷新。 */
function settlePlayback(): void {
  if (pendingUpgrade || upgradeTransition) finishUpgrade();
  if (pendingMelodyApply) {
    pendingGlassRefresh = false;
    applyPendingMelody();
    return;
  }
  if (pendingGlassRefresh) {
    pendingGlassRefresh = false;
    if (audioMode !== 'original') void applyAudioMode(audioMode);
  }
}

let lastSeekSync = 0;

function loop(): void {
  if (scene && (transport.playing || dirty)) {
    renderNow();
    dirty = false;
  }
  if (scene) {
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
  if (scene?.motion === 'natural' && scene.natural) return notesFromNatural(scene.natural);
  if (scene?.motion === 'bead' && scene.bead) return notesFromBead(scene.bead);
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

function setAudioStatus(text: string, warn = false): void {
  const el = $('audioNote');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

async function applyAudioMode(mode: AudioMode): Promise<void> {
  audioMode = mode;
  const token = ++audioToken;
  const btn = $<HTMLButtonElement>('exportBtn');
  btn.disabled = true;
  setAudioStatus(mode === 'original' ? '切换到原曲…' : '玻璃音轨生成中…');
  try {
    const buf = await getFinalBuffer(mode);
    if (token !== audioToken) return;
    await transport.swapBuffer(buf);
    if (token !== audioToken) return;
    dirty = true;
    setAudioStatus(
      mode === 'original' ? '当前：原曲' : mode === 'mix' ? '当前：玻璃 + 原曲' : '当前：玻璃声',
    );
  } catch (err) {
    if (token !== audioToken) return;
    setAudioStatus('音轨切换失败，保留当前音轨', true);
    showLog(`切换音轨失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (token === audioToken) btn.disabled = exporting;
  }
}

function updateRhythmUi(): void {
  const isNotes = rhythmEffective === 'notes';
  const note = $('rhythmNote');
  note.textContent = `${isNotes ? '音符驱动' : '节拍网格'} · ${rhythmReason}`;
  note.classList.toggle('warn', /回退|不足|还未|失败/.test(rhythmReason));
  updateMotionUi();
}

/**
 * 运动选择与参数面板。
 *
 * 玻璃珠现在是所有歌的默认运动：网格歌用约 1s 抽稀拍点，音符歌用音符起音。
 * 网格/鼓组不再被强制经典；经典只在手动选择或没有可用撞点时回退。
 */
function updateMotionUi(): void {
  const sel = $<HTMLSelectElement>('motion');
  const beadOpt = sel.querySelector<HTMLOptionElement>('option[value="bead"]');
  const gridReady = !!analysis && impactsFromBeats(analysis.beats).length >= 2;
  const canBead = !!chart?.noteDriven || gridReady;

  if (beadOpt) beadOpt.disabled = !canBead;
  sel.value = canBead ? motionChoice : 'classic';
  sel.title = canBead
    ? '自动/玻璃珠：音符歌用音符起音，网格歌用约 1s 拍点；经典可随时切'
    : '没有可用撞点，暂用经典运动';

  const note = $('motionNote');
  note.textContent = scene?.reason ?? (canBead ? '玻璃珠' : '经典运动');
  note.classList.toggle('warn', /回退|失败|不足|暂用/.test(note.textContent ?? ''));

  const isGlass = scene?.motion === 'natural' || scene?.motion === 'bead';
  $('motionClassicNote').hidden = !isGlass;

  const speed = $<HTMLInputElement>('speed');
  const drama = $<HTMLInputElement>('drama');
  const dofEl = $<HTMLInputElement>('dof');
  const density = $<HTMLSelectElement>('density');
  const reseed = $<HTMLButtonElement>('reseed');
  const beadTitle = '玻璃珠模式固定；切经典可调';
  for (const el of [speed, drama, dofEl]) {
    el.disabled = isGlass;
    el.title = isGlass ? beadTitle : '';
  }
  reseed.disabled = isGlass;
  reseed.title = isGlass ? beadTitle : '';
  const densityFixed = isGlass || !!chart?.noteDriven;
  density.disabled = densityFixed;
  density.title = isGlass
    ? beadTitle
    : chart?.noteDriven
      ? '音符驱动模式下板子由音符起音决定，密度固定'
      : '';
  $('densityNote').textContent = densityFixed ? '固定' : '';
  $('dramaNote').textContent = isGlass
    ? '玻璃珠模式固定；切经典可调'
    : '0% 恒定速度/统一弹跳 · 100% 最大跟随音乐';
}

/** 自动判断节奏来源：无鼓组（kick 占比低）且有足够的旋律音符 → 音符驱动 */
function updateRhythm(res: AnalysisResult): void {
  const decision = selectRhythmMode(res, melodyResult, rhythmSource);
  rhythmEffective = decision.mode;
  rhythmReason = decision.reason;
  updateRhythmUi();
}

function buildSceneFor(noteSource: MelodyNote[] | null): Scene {
  if (!analysis) throw new Error('还没有分析结果');
  return buildScene(analysis, {
    V: speedV,
    stride,
    seed,
    drama,
    dof,
    noteSource,
    motion: motionChoice,
  });
}

function rebuild(): void {
  if (!analysis) return;
  clearUpgrade();
  pendingGlassRefresh = false;
  const noteSource =
    rhythmEffective === 'notes' && melodyResult?.source === 'basic-pitch' ? melodyResult.notes : null;
  scene = buildSceneFor(noteSource);
  chart = scene.chart;
  $('stage').classList.add('has-scene');
  $('seedVal').textContent = `#${seed}`;
  // 玻璃轨依赖 chart（声像/衰减/音高），作废并防抖刷新
  glassStale = true;
  finalCache.delete('glass');
  finalCache.delete('mix');
  if (audioRefreshTimer) clearTimeout(audioRefreshTimer);
  audioRefreshTimer = window.setTimeout(() => {
    audioRefreshTimer = 0;
    if (decoded && audioMode !== 'original') void applyAudioMode(audioMode);
  }, 450);
  updateMotionUi();
  dirty = true;
}

function updateExportProfile(): void {
  if (!scene) return;
  const p = shareProfile(scene.chart.duration);
  $<HTMLButtonElement>('exportBtn').textContent = `导出 MP4 · ${p.width}×${p.height}`;
  const mb = Math.round(((p.videoBitrate + p.audioBitrate) / 8) * scene.chart.duration / 1e6);
  $('exportHint').textContent = `导出在本地完成，不上传任何数据 · 预计 ${mb}MB`;
}

function applyAnalysis(res: AnalysisResult, opts: { keepMelody?: boolean } = {}): void {
  analysis = res;
  // 新歌默认清掉上一首的旋律；缓存命中时调用方已准备好本曲旋律，保留它
  if (!opts.keepMelody) melodyResult = null;
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
  if (audioMode !== 'original') void applyAudioMode(audioMode);
  $('info').hidden = false;
  $('transport').hidden = false;
  $('params').hidden = false;
  $('exportBox').hidden = false;
  updateExportProfile();
  $('empty').hidden = true;
  const badge = $('badge');
  badge.hidden = false;
  badge.textContent = `${bpm.toFixed(0)} BPM · ${detected} beats`;
}

// ---------- 加载 ----------

function clearLiteStatus(): void {
  const el = $('fileMeta');
  el.textContent = (el.textContent ?? '').replace(/ · 预览降级中/g, '');
}

function resetMelodyWorker(): void {
  melodyGen++;
  melodyHandle?.cancel();
  melodyHandle = null;
  clearLiteStatus();
  syncPreviewQuality();
  pendingMelodyApply = false;
  $('melodyCancel').hidden = true;
}

function invalidateGlass(): void {
  glassStale = true;
  finalCache.delete('glass');
  finalCache.delete('mix');
}

function applyMelodyChart(res: AnalysisResult, note = ''): void {
  if (!melodyResult) return;
  pendingMelodyApply = false;
  invalidateGlass();
  const backend = backendLabel(melodyResult.backend);
  const src =
    melodyResult.source === 'basic-pitch'
      ? `模型${backend ? `·${backend}` : ''}`
      : 'FFT 降级';
  const fallback = melodyResult.fallbackReason
    ? ` · ${melodyResult.fallbackReason}`
    : '';
  $('fileMeta').textContent +=
    note ||
    ` · 旋律 ${melodyResult.notes.length} 个音（${src}）${fallback}`;
  updateRhythm(res);
  rebuild();
  if (audioMode !== 'original') void applyAudioMode(audioMode);
}

function applyPendingMelody(): void {
  if (!pendingMelodyApply || !analysis || !melodyResult) return;
  applyMelodyChart(analysis, ` · 已应用音符驱动（${melodyResult.notes.length} 音）`);
}

function startMelodyFor(dec: DecodedAudio, res: AnalysisResult): void {
  const gen = ++melodyGen;
  melodyHandle?.cancel();
  melodyHandle = null;
  pendingMelodyApply = false;
  const cancelBtn = $<HTMLButtonElement>('melodyCancel');
  cancelBtn.hidden = false;
  $('fileMeta').textContent += ' · 加载旋律模型… · 预览降级中';

  void (async () => {
    try {
      const pcm22 = await resampleTo22050(dec.pcm, dec.sr);
      if (gen !== melodyGen) return;

      const handle = startMelodyInWorker(pcm22, (p) => {
        if (gen !== melodyGen) return;
        const b = p.backend ? `（${backendLabel(p.backend)}）` : '';
        $('fileMeta').textContent =
          (p.phase === 'model'
            ? `加载旋律模型…${b}`
            : `提取旋律 ${(p.ratio * 100).toFixed(0)}%${b} …`) + ' · 预览降级中';
      }, { backend: melodyBackendPref });
      melodyHandle = handle;
      syncPreviewQuality();
      const mel = await handle.promise;
      if (gen !== melodyGen) return;

      melodyHandle = null;
      clearLiteStatus();
      syncPreviewQuality();
      cancelBtn.hidden = true;
      if (mel.source === 'basic-pitch' && currentCacheKey) {
        const key = currentCacheKey;
        void putCachedNotes(key, mel.notes).then((ok) => {
          if (!ok && gen === melodyGen) {
            console.warn('[melody-cache] 写入失败', key);
            $('fileMeta').textContent += ' · 旋律缓存写入失败';
          }
        });
      }
      const refined =
        mel.source === 'basic-pitch' ? snapNotesToOnsets(mel.notes, res.onsets ?? []) : mel.notes;
      const result: MelodyResult = {
        notes: refined,
        source: mel.source,
        backend: mel.backend,
        fallbackReason: mel.fallbackReason,
      };
      melodyResult = result;
      const decision = selectRhythmMode(res, result, rhythmSource);
      const playing = transport.playing;

      if (!playing) {
        applyMelodyChart(res);
        return;
      }

      if (decision.mode === 'notes' && motionChoice !== 'classic') {
        let next: Scene | null = null;
        try {
          next = buildSceneFor(result.notes);
        } catch (err) {
          console.warn('[upgrade] 音符场景构建失败，改为暂停后应用', err);
        }
        const nextImpacts =
          next?.motion === 'natural' ? next.natural?.impacts : next?.motion === 'bead' ? next.bead?.impacts : null;
        if (next && nextImpacts && next.chart.noteDriven) {
          const nowVisual = transport.time + offsetSec - transport.outputCompensation;
          const impact = nextImpacts.find((x) => x.t >= nowVisual + 0.2);
          if (impact) {
            pendingUpgrade = {
              scene: next,
              at: Math.max(nowVisual + 0.05, impact.t - UPGRADE_FADE_SEC / 2),
            };
            pendingMelodyApply = false;
            $('fileMeta').textContent +=
              ` · 音符已就绪（${result.notes.length} 音），即将切到音符玻璃珠`;
            dirty = true;
            return;
          }
        }
        pendingMelodyApply = true;
        $('fileMeta').textContent +=
          ` · 音符已就绪（${result.notes.length} 音），暂停/跳转后应用`;
        return;
      }

      if (decision.mode === 'notes') {
        // 音符就绪但当前是经典运动：保持旧行为，暂停/seek 再应用，避免播放中跳图
        pendingMelodyApply = true;
        $('fileMeta').textContent +=
          ` · 音符已就绪（${result.notes.length} 音），暂停/跳转后应用（经典运动）`;
        return;
      }

      // 网格/鼓组：保持正在播放的拍点玻璃珠，不切图；旋律留给手动音符与玻璃音高
      invalidateGlass();
      if (audioMode !== 'original') pendingGlassRefresh = true;
      updateRhythm(res);
      $('fileMeta').textContent +=
        rhythmSource === 'grid'
          ? ` · 旋律已就绪（${result.notes.length} 音，节拍网格未切换）`
          : ` · 旋律已就绪（${result.notes.length} 音，自动仍用节拍网格）`;
    } catch (err) {
      if (gen !== melodyGen) return;
      melodyHandle = null;
      clearLiteStatus();
      syncPreviewQuality();
      cancelBtn.hidden = true;
      const notes = fftMelody(dec.pcm, dec.sr);
      melodyResult = {
        notes,
        source: 'fft-fallback',
        backend: 'fallback',
        fallbackReason: err instanceof Error ? err.message : String(err),
      };
      invalidateGlass();
      $('fileMeta').textContent += ' · 旋律提取失败，已降级 FFT';
      applyMelodyChart(res);
      console.warn('[melody] worker failed', err);
    }
  })();
}

function cancelMelody(): void {
  resetMelodyWorker();
  if (!analysis) return;
  melodyResult = null;
  updateRhythm(analysis);
  rebuild();
  $('fileMeta').textContent += ' · 已取消旋律提取，使用节拍网格';
  if (audioMode !== 'original') void applyAudioMode(audioMode);
}

async function loadFile(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  const loadToken = ++loadGen;
  resetMelodyWorker();
  clearUpgrade();
  pendingGlassRefresh = false;
  currentCacheKey = null;
  clearLog();
  $('fileName').textContent = file.name;

  try {
    if (!/^audio\//.test(file.type) && !/\.(mp3|wav|m4a|flac|ogg|aac|opus)$/i.test(file.name)) {
      throw new Error('这看起来不是音频文件。请选择 mp3 / wav / m4a。');
    }

    // 缓存查询与解码/分析并行：命中时首次 rebuild 就能用音符玻璃珠
    const cacheLookup = (async () => {
      const hash = await hashFile(file);
      if (!hash) return { key: null as string | null, notes: null };
      const key = cacheKey(hash);
      const notes = await getCachedNotes(key);
      return { key, notes };
    })();

    const t0 = performance.now();
    const dec = await decodeFile(file, decodeCtx);
    if (dec.duration < 1) throw new Error('音频太短了（不足 1 秒）');

    decoded = dec;
    transport.setBuffer(dec.buffer);

    // 新歌默认原曲：上一首还在渲染的玻璃轨立即失效
    audioToken++;
    audioMode = 'original';
    $<HTMLSelectElement>('audioMode').value = 'original';
    setAudioStatus('当前为原曲；切到玻璃声会先生成玻璃音轨');

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
    const cached = await cacheLookup;
    if (loadToken !== loadGen) return;
    if (cached.key) currentCacheKey = cached.key;

    let keepMelody = false;
    if (cached.key && cached.notes) {
      const refined = snapNotesToOnsets(cached.notes, res.onsets ?? []);
      if (refined.length >= 4) {
        melodyResult = { notes: refined, source: 'basic-pitch', backend: 'cache' };
        keepMelody = true;
      } else {
        // 缓存里的音符在当前分析下几乎全被 onset 精修丢弃，视为失效
        void deleteCachedNotes(cached.key);
      }
    }

    applyAnalysis(res, { keepMelody });
    $('fileMeta').textContent +=
      ` · 分析耗时 ${ms}ms` +
      (keepMelody ? ` · 旋律缓存命中（${melodyResult?.notes.length ?? 0} 音）` : '');
    dirty = true;

    // 分析完成后立即释放文件选择；旋律在后台 Worker 继续，可取消/换歌。
    busy = false;
    if (keepMelody) {
      $('melodyCancel').hidden = true;
      if (audioMode !== 'original') void applyAudioMode(audioMode);
    } else {
      startMelodyFor(dec, res);
    }
  } catch (err) {
    showLog(err instanceof Error ? err.message : String(err));
  } finally {
    if (loadToken === loadGen) busy = false;
  }
}

// ---------- 导出 ----------

async function runExport(): Promise<void> {
  if (!scene || !decoded || exporting) return;

  // 导出必须使用当前最新场景：如果音符升级还在等待撞击点，先落地再导出
  if (pendingUpgrade || upgradeTransition) finishUpgrade();

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

    // 分享档按曲长选 1080p60 / 720p60，与预览共用同一个 draw()
    const profile = shareProfile(scene.chart.duration);
    const canvas = document.createElement('canvas');
    canvas.width = profile.width;
    canvas.height = profile.height;
    const exportView: View = {
      w: profile.width,
      h: profile.height,
      scale: profile.width / DEFAULT_TRACK_W,
    };
    const exportAssets = createAssets(makeCanvas, exportView);

    const t0 = performance.now();
    const result = await exportMp4({
      scene,
      audioBuffer: await getFinalBuffer(audioMode),
      canvas,
      view: exportView,
      assets: exportAssets,
      sceneScratch: createSceneScratch(),
      fps: profile.fps,
      videoBitrate: profile.videoBitrate,
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
      `完成 · ${(result.frames / profile.fps).toFixed(1)}s / ${result.frames} 帧 · 耗时 ${secs.toFixed(1)}s · ` +
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
  if (transport.playing) {
    transport.pause();
    settlePlayback();
  } else void transport.play();
});

transport.onEnded = () => {
  dirty = true;
  settlePlayback();
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
  settlePlayback();
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
  if (pendingUpgrade || upgradeTransition) {
    cancelUpgrade(rhythmSource === 'notes' ? '已手动切到音符驱动' : '已取消音符升级');
  }
  if (pendingMelodyApply) {
    if (rhythmSource === 'notes') {
      applyPendingMelody();
      return;
    }
    if (rhythmSource === 'grid') {
      pendingMelodyApply = false;
      $('fileMeta').textContent += ' · 已改为节拍网格';
    }
    if (rhythmSource === 'auto') return;
  }
  updateRhythm(analysis);
  rebuild();
});

$<HTMLSelectElement>('audioMode').addEventListener('change', (e) => {
  void applyAudioMode((e.target as HTMLSelectElement).value as AudioMode);
});

$<HTMLSelectElement>('motion').addEventListener('change', (e) => {
  motionChoice = (e.target as HTMLSelectElement).value as MotionChoice;
  if (!analysis) return;
  if (pendingUpgrade || upgradeTransition) {
    cancelUpgrade(motionChoice === 'classic' ? '已取消音符升级（经典运动）' : '已取消音符升级（手动选运动）');
  }
  rebuild();
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
$('melodyCancel').addEventListener('click', () => cancelMelody());

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && decoded && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    if (transport.playing) {
      transport.pause();
      settlePlayback();
    } else void transport.play();
  }
});

// 首帧先画一次空场景，避免白屏
previewCtx.fillStyle = '#04050a';
previewCtx.fillRect(0, 0, previewView.w, previewView.h);
// 支持/调试用：暴露当前播放音轨的信息（48k = 玻璃/混音/重采样原曲，44.1k = 初始原曲）
const debugApi = {
  get mode() { return audioMode; },
  get playingSr() { return transport.bufferInfo?.sampleRate ?? 0; },
  get playingDur() { return +(transport.bufferInfo?.duration ?? 0).toFixed(2); },
  get glassSr() { return glassBuffer?.sampleRate ?? 0; },
  get glassPeak() {
    if (!glassBuffer) return 0;
    const d = glassBuffer.getChannelData(0);
    let p = 0;
    for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
    return +p.toFixed(3);
  },
  get glassRms() { return glassBuffer ? +rmsOf(glassBuffer).toFixed(3) : 0; },
  get glassStale() { return glassStale; },
  get previewLite() { return previewLite; },
  get previewCanvas() { return { w: viewCanvas.width, h: viewCanvas.height }; },
  get glassNoteCount() { return buildGlassNotes().length; },
  get decodedSr() { return decoded?.buffer.sampleRate ?? 0; },
  get melodyNotes() { return melodyResult?.notes ?? []; },
  get melodySource() { return melodyResult?.source ?? null; },
  get melodyBackend() { return melodyResult?.backend ?? null; },
  get melodyFallbackReason() { return melodyResult?.fallbackReason ?? null; },
  get melodyBackendPref() { return melodyBackendPref; },
  setMelodyBackend(v: MelodyBackendPref) { melodyBackendPref = v; },
  get cacheKey() { return currentCacheKey; },
  async cacheStats() { return getCacheStats(); },
  async clearCache() { return clearMelodyCache(); },
  get rhythm() { return rhythmEffective; },
  get rhythmReason() { return rhythmReason; },
  get chart() { return chart; },
  get scene() { return scene; },
  get exportProfile() { return scene ? shareProfile(scene.chart.duration) : null; },
  get motion() { return scene?.motion ?? null; },
  get motionChoice() { return motionChoice; },
  get motionReason() { return scene?.reason ?? ''; },
  get upgradePending() {
    return pendingUpgrade
      ? {
          at: +pendingUpgrade.at.toFixed(3),
          impacts:
            pendingUpgrade.scene.natural?.impacts.length ??
            pendingUpgrade.scene.bead?.impacts.length ??
            0,
        }
      : null;
  },
  get upgradeTransition() {
    return upgradeTransition
      ? { start: +upgradeTransition.start.toFixed(3), end: +upgradeTransition.end.toFixed(3) }
      : null;
  },
  get glassRefreshPending() { return pendingGlassRefresh; },
  get bead() { return scene?.bead ?? null; },
  get natural() { return scene?.natural ?? null; },
  get analysis() { return analysis; },
  get melody() { return melodyResult; },
  get melodyPending() { return pendingMelodyApply; },
  get melodyBusy() { return melodyHandle !== null; },
  get time() { return +transport.time.toFixed(3); },
  get playing() { return transport.playing; },
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
