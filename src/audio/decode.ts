/**
 * 文件 → AudioBuffer + 单声道 PCM。
 *
 * mp3 在浏览器里只能先 decodeAudioData 拿到 AudioBuffer，这是唯一入口。
 * 这里一次性解码，后续播放用同一个 AudioBuffer，分析与播放天然共享同一份数据，
 * 因此不存在「分析用的音频比播放的音频晚 25ms」这类跨链路偏差。
 */
export interface DecodedAudio {
  buffer: AudioBuffer;
  /** 单声道混音后的 PCM，交给 Worker 分析 */
  pcm: Float32Array;
  sr: number;
  duration: number;
}

export async function decodeFile(file: File, ctx: BaseAudioContext): Promise<DecodedAudio> {
  const raw = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(raw);

  const channels = buffer.numberOfChannels;
  const len = buffer.length;
  const pcm = new Float32Array(len);

  if (channels === 1) {
    pcm.set(buffer.getChannelData(0));
  } else {
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) pcm[i] += data[i];
    }
    const inv = 1 / channels;
    for (let i = 0; i < len; i++) pcm[i] *= inv;
  }

  return { buffer, pcm, sr: buffer.sampleRate, duration: buffer.duration };
}
