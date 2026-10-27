/**
 * 播放时钟。
 *
 * 唯一可信的时间源是 AudioContext.currentTime —— 它跑在音频线程上。
 * 绝不能用 performance.now() 或 setInterval 累加：音频时钟跑在独立晶振上，
 * 与主线程时钟会缓慢漂移，而且 setInterval 的误差是单调累积的（每拍慢 8ms，一分钟就废）。
 *
 * rAF 只决定「什么时候画」，不决定「画第几秒」。画面因此始终是 t 的纯函数。
 */
export class Transport {
  readonly ctx: AudioContext;
  private gain: GainNode;
  private buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private startAt = 0;
  private from = 0;
  private pausedAt = 0;
  private token = 0;

  playing = false;
  onEnded: (() => void) | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(ctx.destination);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.stopSource();
    this.buffer = buffer;
    this.pausedAt = 0;
    this.playing = false;
  }

  /**
   * 播放中无缝换音轨（用于「玻璃声 / 原曲 / 混音」切换）。
   * 现有的 setBuffer 会把 pausedAt 清零，播放中调用会跳回开头 —— 这是个坑。
   */
  async swapBuffer(buffer: AudioBuffer): Promise<void> {
    const t = this.time;
    const wasPlaying = this.playing;
    this.setBuffer(buffer);
    this.pausedAt = t;
    if (wasPlaying) await this.play(t);
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get time(): number {
    if (!this.buffer) return 0;
    if (!this.playing) return this.pausedAt;
    const t = this.from + Math.max(0, this.ctx.currentTime - this.startAt);
    return Math.min(t, this.buffer.duration);
  }

  async play(from = this.pausedAt): Promise<void> {
    if (!this.buffer) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();

    const start = from >= this.buffer.duration - 0.02 ? 0 : from;
    this.stopSource();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);

    const token = ++this.token;
    src.onended = () => {
      if (token !== this.token) return;
      this.playing = false;
      this.pausedAt = this.buffer?.duration ?? 0;
      this.onEnded?.();
    };

    const startAt = this.ctx.currentTime + 0.03;
    src.start(startAt, Math.max(0, start));

    this.src = src;
    this.startAt = startAt;
    this.from = Math.max(0, start);
    this.playing = true;
  }

  pause(): void {
    const t = this.time;
    this.stopSource();
    this.pausedAt = t;
    this.playing = false;
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.duration));
    if (this.playing) {
      void this.play(clamped);
    } else {
      this.pausedAt = clamped;
    }
  }

  private stopSource(): void {
    this.token++;
    if (this.src) {
      try {
        this.src.onended = null;
        this.src.stop();
      } catch {
        /* already stopped */
      }
      this.src.disconnect();
      this.src = null;
    }
  }

  dispose(): void {
    this.stopSource();
    this.gain.disconnect();
  }

  /**
   * 输出设备延迟补偿量（秒）。
   *
   * `currentTime` 是「音频线程渲染到哪」，真正出扬声器还要经过 outputLatency + baseLatency。
   * 不补偿的话，蓝牙耳机（AirPods 120–300ms）下球会抢在鼓点前面落地。
   *
   * ⚠️ Chrome 在蓝牙设备上经常只报 10–30ms（不含 A2DP 缓冲），所以这个值只能当下界，
   * 不可靠时 UI 要提示手动校准。方向是「视觉减去它」：t_visual = t_audio − L。
   */
  get outputCompensation(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number; baseLatency?: number };
    let raw = 0;
    if (typeof ctx.outputLatency === 'number' && Number.isFinite(ctx.outputLatency)) {
      raw += ctx.outputLatency;
    }
    if (typeof ctx.baseLatency === 'number' && Number.isFinite(ctx.baseLatency)) {
      raw += ctx.baseLatency;
    }
    // 减掉 1 帧的显示滞后（draw 到屏幕点亮约 16.7ms）
    raw -= 1 / 60;
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return Math.min(raw, 0.4);
  }

  /** 输出设备是否可疑（采样率异常低通常是蓝牙 HFP 通话模式，延迟会很大） */
  get outputSuspicious(): boolean {
    return this.ctx.sampleRate < 32000;
  }
}
