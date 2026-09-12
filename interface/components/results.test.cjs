const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const fs = require('node:fs');
const path = require('node:path');
async function setup() {
  const { createI18n } = await import('../i18n/i18n.mjs');
  const { createResults } = await import('./results.mjs');
  const { document } = parseHTML('<html><body></body></html>');
  const i18n = createI18n({ catalogs: Object.fromEntries(['en', 'zh-CN'].map(locale => [locale,
    JSON.parse(fs.readFileSync(path.join(__dirname, `../i18n/ui.${locale}.json`)))])) });
  return { document, i18n, components: createResults({ document, i18n }) };
}
const window = { input: { day: '2026-08-27', start: '16:30', end: '16:31' },
  normalized: { start: '2026-08-27T20:30:00Z', end: '2026-08-27T20:31:00Z', timezone: 'America/Toronto' } };
test('timeline preserves service window and ordered intervals; fixed action receives original identity', async () => {
  const { components } = await setup(); let selected;
  const range = { id: 'event-7', start: '16:30', end: '16:31' };
  const card = components.timeline({ ranges: [range], window, action: value => { selected = value; } });
  card.querySelector('button').click(); assert.equal(selected, range);
  assert.match(card.textContent, /20:30:00Z/); assert.match(card.textContent, /America\/Toronto/);
  assert.match(card.textContent, /not proof/);
  assert.match(components.timeline({ ranges: [] }).textContent, /No footage/);
  assert.doesNotMatch(components.timeline({ window }).textContent, /No footage/);
});
test('job shows honest partial and preserves the same registered player across progress and locale updates', async () => {
  const { components, i18n } = await setup();
  const view = { status: 'running', complete: false, job: { jobId: 'job-1', window, stage: 'capture', progress: 0.2 }, videos: [], diagnostics: [] };
  const card = components.job(view); assert.match(card.textContent, /Running/); assert.equal(card.querySelector('video'), null);
  const partial = { ...view, status: 'partial', validation: { passed: true }, job: { ...view.job, stage: 'done', progress: 1,
    error: { code: 'PARTIAL_RECORDING', message: 'Missing coverage' }, result: { outcome: 'partial' } },
    videos: [{ id: 'media', name: 'partial.mp4', outcome: 'partial', url: '/api/v1/jobs/job-1/artifacts/media' }] };
  components.updateJob(card, partial);
  assert.match(card.textContent, /Partial — playable footage is not complete/);
  const video = card.querySelector('video'); video.currentTime = 17;
  assert.equal(video.src, partial.videos[0].url); assert.equal(card.querySelector('a').href, partial.videos[0].url + '?download');
  i18n.setPreference('zh-CN'); components.updateJob(card, partial);
  assert.equal(card.querySelector('video'), video); assert.equal(video.currentTime, 17);
  assert.match(card.textContent, /部分 — 可播放不等于完整/);
  assert.match(card.querySelector('[data-error]').textContent, /仅获取部分录像/);
  assert.equal(card.querySelector('progress').value, 1);
});

test('known reason, stage and job error codes use ordinary localized text while unknown upstream details stay literal', async () => {
  const { components, i18n } = await setup(); i18n.setPreference('zh-CN');
  const device = components.device({ name: 'Front Door', model: 'T8600', serial: 'a', availability: 'unknown',
    state: { reason: 'inventory_does_not_prove_reachability' } });
  assert.match(device.textContent, /设备列表无法确认当前是否在线/);
  assert.doesNotMatch(device.textContent, /inventory_does_not_prove_reachability/);
  const view = { status: 'partial', job: { jobId: 'one', serial: 'a', window, stage: 'decode', progress: .85,
    error: { code: 'PARTIAL_RECORDING', message: 'Only a partial result is available' } }, videos: [] };
  const card = components.job(view);
  assert.match(card.querySelector('[data-stage]').textContent, /检查播放质量/);
  assert.doesNotMatch(card.querySelector('[data-stage]').textContent, /decode/);
  assert.match(card.querySelector('[data-error]').textContent, /仅获取部分录像/);
  assert.doesNotMatch(card.querySelector('[data-error]').textContent, /PARTIAL_RECORDING/);
  assert.match(card.querySelector('pre').textContent, /PARTIAL_RECORDING/, 'raw service detail remains available in diagnostics');
  const unknown = components.device({ name: 'Keep 原名', model: 'T8600', serial: 'a', availability: 'unknown', state: { reason: 'Firmware report 123' } });
  assert.match(unknown.textContent, /Keep 原名/); assert.match(unknown.textContent, /Firmware report 123/);
  components.updateJob(card, { ...view, job: { ...view.job, stage: 'Provider stage 123', error: { code: 'NEW_ERROR', message: 'Provider detail 456' } } });
  assert.match(card.querySelector('[data-stage]').textContent, /Provider stage 123/);
  assert.equal(card.querySelector('[data-error]').textContent, 'Provider detail 456');
});
test('device cards separate dated offline evidence from execution eligibility; device names stay literal', async () => {
  const { components } = await setup();
  const card = components.device({ name: '<img src=x>', model: 'T8600', serial: 'a', availability: 'offline',
    state: { reason: 'connect_failed', observedAt: '2026-08-27' }, recordingExport: { supported: true, status: 'protocol_hint' } });
  assert.equal(card.querySelector('img'), null); assert.match(card.textContent, /<img src=x>/);
  assert.match(card.textContent, /Last observed offline/); assert.match(card.textContent, /Recording export eligible/);
  assert.match(card.textContent, /not verified/);
});

test('reachable stable task and service errors use ordinary EN and Chinese text in shared job cards', async () => {
  const { components, i18n } = await setup();
  const messages = {
    JOB_NOT_FOUND: ['Task not found. Check the task ID.', '未找到任务，请核对任务编号。'],
    JOB_UNAVAILABLE: ['The export could not be started. Check existing tasks before continuing.', '无法开始导出，请先查看已有任务再继续。'],
    JOB_CANCELLED: ['This task was cancelled.', '此任务已取消。'],
    CAPABILITY_RECORDS_UNAVAILABLE: ['Device verification records are unavailable. Check the local service.', '无法读取设备验证记录，请检查本地服务。'],
    SERVICE_STOPPING: ['The local service is shutting down. Reconnect after it restarts.', '本地服务正在关闭，请在重启后重新连接。'],
    INTERNAL_ERROR: ['The local service could not complete this request. Check its status before continuing.', '本地服务未能完成请求，请检查服务状态后再继续。'],
    INVALID_RESPONSE: ['The local service returned an unexpected response. Check its status before continuing.', '本地服务返回了异常结果，请检查服务状态后再继续。'],
    NORMALIZATION_REQUIRED: ['First specify the device and recording time to find available footage.', '请先提供设备和录像时间，查询可用录像。'],
  };
  for (const [index, locale] of ['en', 'zh-CN'].entries()) {
    i18n.setPreference(locale);
    for (const [code, values] of Object.entries(messages)) {
      const error = { code, message: `Raw upstream ${code}` };
      assert.equal(components.error(error), values[index], `${locale} ${code}`);
      const card = components.job({ status: 'failed', job: { jobId: code, stage: 'completed', error }, videos: [] });
      assert.equal(card.querySelector('[data-error]').textContent, values[index]);
      assert.match(card.querySelector('pre').textContent, /Raw upstream/, 'raw diagnostics remain available');
    }
  }
});
