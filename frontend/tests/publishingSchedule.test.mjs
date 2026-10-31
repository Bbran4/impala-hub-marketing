import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
test('publishing and sync have a five-minute runtime without a competing daily Vercel timer', () => {
  assert.equal(config.functions['api/marketing/facebook/publish-due.ts'].maxDuration, 300);
  assert.equal(config.functions['api/marketing/facebook/sync.ts'].maxDuration, 300);
  assert.equal(config.functions['api/marketing/facebook/publish.ts'].maxDuration, 300);
  assert.ok(!(config.crons || []).some((job) => job.path === '/api/marketing/facebook/publish-due'));
});
