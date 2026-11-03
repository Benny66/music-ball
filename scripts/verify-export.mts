/**
 * 分享档回归：任何时长 ≤80MB，1080p/720p 切换点，始终 60fps。
 *
 *   npm run verify:export
 */
import assert from 'node:assert/strict';

import { shareProfile, SHARE_FPS } from '../src/export/profile.ts';

const MB = 1_000_000;

function estimatedBytes(durationSec: number): number {
  const p = shareProfile(durationSec);
  return ((p.videoBitrate + p.audioBitrate) / 8) * durationSec;
}

for (const duration of [60, 168.5, 180, 240, 242, 270, 280, 300, 392, 600]) {
  const p = shareProfile(duration);
  assert.equal(p.fps, SHARE_FPS);
  assert.ok(estimatedBytes(duration) <= 80 * MB, `${duration}s 估算超过 80MB`);
  console.log(
    `${duration.toFixed(1)}s → ${p.width}×${p.height}@${p.fps}  ` +
      `视频 ${(p.videoBitrate / 1e6).toFixed(2)}Mbps  估算 ${(estimatedBytes(duration) / MB).toFixed(1)}MB`,
  );
}

assert.deepEqual(
  (() => {
    const p = shareProfile(180);
    return [p.width, p.height];
  })(),
  [1080, 1920],
);
assert.deepEqual(
  (() => {
    const p = shareProfile(240);
    return [p.width, p.height];
  })(),
  [1080, 1920],
);
assert.deepEqual(
  (() => {
    const p = shareProfile(280);
    return [p.width, p.height];
  })(),
  [720, 1280],
);
assert.equal(shareProfile(60).videoBitrate, 3_200_000);
assert.ok(shareProfile(280).videoBitrate < 2_000_000);

console.log('分享档回归通过');
