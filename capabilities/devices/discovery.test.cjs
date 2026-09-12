const test = require('node:test');
const assert = require('node:assert/strict');

const page = devices => ({ devices });

test('offline page model merges by serial, keeps unknown models and never proves Mega pagination', async () => {
  const { collectDevicePages } = require('./discovery.cjs');
  async function* pages() {
    yield page([{ device_sn: 'base', device_model: 'T8030' }, { device_sn: 'unknown', device_model: 'FUTURE_MODEL' }]);
    yield page([{ device_sn: 'base', device_model: 'T8030', device_name: 'Updated base' }, { device_sn: 'missing-model' }]);
  }
  const result = await collectDevicePages(pages());
  assert.deepEqual(result.devices.map(device => device.device_sn), ['base', 'unknown', 'missing-model']);
  assert.equal(result.devices[0].device_name, 'Updated base');
  assert.equal(result.devices[1].device_model, 'FUTURE_MODEL');
  assert.equal(result.error, null);
  assert.equal(result.discovery.status, 'succeeded');
  assert.equal(result.discovery.completeness, 'unknown');
  assert.equal(result.discovery.pagination, 'unverified');
  assert.equal(result.discovery.pagesRead, 2);
  assert.equal(result.discovery.receivedCount, 4);
  assert.equal(result.discovery.uniqueCount, 3);
});

test('offline later-page failure retains earlier devices, cap evidence and retryable incomplete status', async () => {
  const { collectDevicePages } = require('./discovery.cjs');
  let fail = true;
  async function* pages() {
    yield page(Array.from({ length: 100 }, (_, i) => ({ device_sn: `fixture-${i}`, device_model: 'UNKNOWN' })));
    if (fail) throw new Error('offline second-page failure');
    yield page([{ device_sn: 'last', device_model: 'FUTURE_MODEL' }]);
  }
  const failed = await collectDevicePages(pages());
  assert.equal(failed.devices.length, 100);
  assert.equal(failed.error.message, 'offline second-page failure');
  assert.equal(failed.discovery.status, 'failed');
  assert.equal(failed.discovery.completeness, 'incomplete');
  assert.equal(failed.discovery.failedPage, 2);
  assert.equal(failed.discovery.pagesRead, 1);
  assert.equal(failed.discovery.receivedCount, 100);
  assert.equal(failed.discovery.limitReached, true);
  assert.equal(failed.discovery.retryable, true);
  assert.ok(failed.discovery.reasons.includes('request_limit_reached'));
  assert.ok(failed.discovery.reasons.includes('inventory_request_failed'));
  fail = false;
  const retried = await collectDevicePages(pages());
  assert.equal(retried.devices.length, 101);
  assert.equal(retried.error, null);
  assert.equal(retried.discovery.status, 'succeeded');
  assert.equal(retried.discovery.completeness, 'unknown');
  assert.equal(retried.discovery.failedPage, null);
  assert.equal(retried.discovery.retryable, false);
});

test('malformed later pages fail without erasing prior valid inventory', async () => {
  const { collectDevicePages } = require('./discovery.cjs');
  for (const badPage of [{ unexpected: [] }, page([{ device_sn: 'ignored' }, {}])]) {
    async function* pages() { yield page([{ device_sn: 'known' }]); yield badPage; }
    const result = await collectDevicePages(pages());
    assert.deepEqual(result.devices, [{ device_sn: 'known' }]);
    assert.equal(result.discovery.completeness, 'incomplete');
    assert.equal(result.discovery.failedPage, 2);
    assert.equal(result.discovery.uniqueCount, 1);
    assert.ok(result.discovery.reasons.includes('invalid_inventory'));
  }
});

test('real discovery wrapper makes one known call and does not trust unverified continuation or completeness fields', async () => {
  const { readDeviceInventory } = require('./discovery.cjs');
  for (const count of [0, 2, 100]) {
    let calls = 0;
    const result = await readDeviceInventory({ getDevsListDecrypted: async (...args) => {
      calls++;
      assert.deepEqual(args, []);
      return { devices: Array.from({ length: count }, (_, i) => ({ device_sn: `fixture-${i % 99}` })),
        page: 1, next_cursor: 'unverified-fixture', has_more: false, total: count, completeness: 'complete' };
    } });
    assert.equal(calls, 1);
    assert.equal(result.discovery.status, 'succeeded');
    assert.equal(result.discovery.completeness, 'unknown');
    assert.equal(result.discovery.pagination, 'unverified');
    assert.equal(result.discovery.limitReached, count === 100);
    assert.equal(result.discovery.receivedCount, count);
    assert.equal(result.devices.length, Math.min(count, 99));
  }
});
