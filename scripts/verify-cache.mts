/**
 * 旋律缓存纯逻辑回归（Node 没有 IndexedDB，验证降级与键/哈希）。
 *
 *   npm run verify:cache
 */
import assert from 'node:assert/strict';

import {
  CACHE_VERSION,
  MODEL_VERSION,
  cacheKey,
  clearMelodyCache,
  getCacheStats,
  getCachedNotes,
  hashFile,
  putCachedNotes,
  selectEvictions,
} from '../src/analysis/melody-cache.ts';

async function main(): Promise<void> {
  const a = new File([new Uint8Array([1, 2, 3, 4])], 'a.wav', { type: 'audio/wav' });
  const b = new File([new Uint8Array([1, 2, 3, 4])], 'b.wav', { type: 'audio/wav' });
  const c = new File([new Uint8Array([4, 3, 2, 1])], 'a.wav', { type: 'audio/wav' });

  const ha = await hashFile(a);
  const hb = await hashFile(b);
  const hc = await hashFile(c);
  assert.ok(ha && /^[0-9a-f]{64}$/.test(ha), `hash 格式 ${ha}`);
  assert.equal(ha, hb, '同内容不同文件名应同哈希');
  assert.notEqual(ha, hc, '不同内容应不同哈希');

  const key = cacheKey(ha!);
  assert.ok(key.startsWith(`${ha}:`), key);
  assert.ok(key.includes(MODEL_VERSION), key);
  assert.ok(key.endsWith(`:${CACHE_VERSION}`), key);
  assert.notEqual(key, cacheKey(hc!));

  // Node 没有 IndexedDB：所有缓存操作应降级，不抛错
  assert.equal(await getCachedNotes(key), null);
  assert.equal(await putCachedNotes(key, []), false);
  assert.deepEqual(await getCacheStats(), { count: 0, bytes: 0 });
  assert.equal(await clearMelodyCache(), false);

  // 淘汰：按 lastUsed 从旧到新；条目数或字节数任一超限都要降下来
  const entries = [
    { key: 'old', lastUsed: 1, size: 10 },
    { key: 'mid', lastUsed: 2, size: 10 },
    { key: 'new', lastUsed: 3, size: 10 },
  ];
  assert.deepEqual(selectEvictions(entries, 3, 100), []);
  assert.deepEqual(selectEvictions(entries, 2, 100), ['old']);
  assert.deepEqual(selectEvictions(entries, 3, 25), ['old']);
  assert.deepEqual(selectEvictions(entries, 3, 15), ['old', 'mid']);
  assert.deepEqual(selectEvictions(entries, 1, 10), ['old', 'mid']);
  assert.deepEqual(selectEvictions([], 1, 1), []);

  console.log('✓ melody-cache 纯逻辑与 Node 降级通过');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
