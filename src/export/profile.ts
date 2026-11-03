/**
 * 分享档：任何时长都 ≤80MB 的导出配置。
 *
 * 视频码率按曲长反算；80MB 里先扣掉 AAC 音频。目标文件留约 5% 余量
 * （76MB 而不是 80MB），给容器开销和编码器码率波动。
 */

export const SHARE_FPS = 60;
export const SHARE_AUDIO_BITRATE = 192_000;
export const SHARE_MAX_VIDEO_BITRATE = 3_200_000;
export const SHARE_TARGET_BYTES = 76_000_000;
export const SHARE_1080P_MIN_BITRATE = 2_000_000;

export interface ShareProfile {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
}

export function shareProfile(durationSec: number): ShareProfile {
  const duration = Math.max(1, durationSec);
  const videoBits = Math.max(0, SHARE_TARGET_BYTES * 8 - SHARE_AUDIO_BITRATE * duration);
  const videoBitrate = Math.min(SHARE_MAX_VIDEO_BITRATE, videoBits / duration);
  const use720 = videoBitrate < SHARE_1080P_MIN_BITRATE;

  return {
    width: use720 ? 720 : 1080,
    height: use720 ? 1280 : 1920,
    fps: SHARE_FPS,
    videoBitrate: Math.round(videoBitrate),
    audioBitrate: SHARE_AUDIO_BITRATE,
  };
}
