// Manual browser fixture only: synthetic inventory/capture/model, real resident/SDK/UI.
const fs = require('node:fs');
const path = require('node:path');
const { ScriptedModel, functionCall, assistantMessage, modelResponder } = require('@openai/agents/testing');
const { fixture, window } = require('./fixture.cjs');
const { runFfmpeg } = require('../../capabilities/recordings/export.cjs');
const call = (name, args, id = name) => [functionCall(name, args, { callId: id })];
const last = request => {
  const result = request.input.filter(i => i.type === 'function_call_result').at(-1);
  return JSON.parse(typeof result.output === 'string' ? result.output : result.output.text);
};
async function start() {
  const evidence = process.env.EUFY_FIXTURE_EVIDENCE;
  if (!evidence) throw new Error('Set EUFY_FIXTURE_EVIDENCE to an external evidence directory.');
  fs.mkdirSync(evidence, { recursive: true });
  const media = path.join(evidence, 'synthetic.mp4'), raw = path.join(evidence, 'synthetic.h264');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=20', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', media]);
  await runFfmpeg(['-y', '-i', media, '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', raw]);
  let receiptId, jobId, loseResponse = false;
  const model = new ScriptedModel([]);
  const options = { model, loggedOut: true, challenge: true, partial: true, delay: 12000, media,
    devices: [{ device_sn: 'CAMERA001', device_name: 'Synthetic camera' },
      { device_sn: 'CAMERA002', device_name: 'Repeated' }, { device_sn: 'CAMERA003', device_name: 'Repeated' }],
    recordings: { close() {}, status: { device: 'Synthetic camera' },
      listWindow: async () => [{ record_id: 1, start_time: new Date('2026-08-27T20:30:00Z'), end_time: new Date('2026-08-27T20:30:03Z') }],
      download: async (id, directory, normalizedWindow) => {
        fs.mkdirSync(directory, { recursive: true }); const prefix = path.join(directory, String(id));
        fs.copyFileSync(raw, prefix + '.video'); fs.writeFileSync(prefix + '.audio', '');
        fs.writeFileSync(prefix + '.json', JSON.stringify({ complete: true, window: normalizedWindow,
          metadata: { videoCodec: 0, videoFPS: 20 }, record: { record_id: id, device_sn: 'CAMERA001',
            start_time: '2026-08-27T20:30:00Z', end_time: '2026-08-27T20:30:03Z' } }));
        return { prefix };
      } },
  };
  const f = await fixture(options);
  const original = f.server.listeners('request')[0]; f.server.removeListener('request', original);
  f.server.on('request', async (req, res) => {
    const route = new URL(req.url, f.url).pathname;
    if (route === '/') {
      const end = res.end.bind(res);
      res.end = chunk => end(String(chunk).replace('</html>', '<script src="/fixture/probe.js"></script></html>'));
    }
    if (route === '/fixture/probe.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`let nextVideo = 0;
        const probe = document.createElement('details'); probe.id = 'fixture-probe';
        probe.innerHTML = '<summary>Synthetic fixture diagnostics</summary><pre></pre>'; document.body.append(probe);
        setInterval(() => {
          for (const video of document.querySelectorAll('video')) if (!video.dataset.fixtureVideo) {
            video.dataset.fixtureVideo = String(++nextVideo); video.loop = true; video.muted = true;
          }
          probe.querySelector('pre').textContent = JSON.stringify({ synthetic: true,
            layout: JSON.parse(localStorage.getItem('eufy-agent-hub.workspace') || 'null'),
            videos: [...document.querySelectorAll('video')].map(v => ({ id: v.dataset.fixtureVideo, src: v.src, time: v.currentTime, paused: v.paused, readyState: v.readyState })) }, null, 2);
        }, 300);`);
    }
    if (loseResponse && route === '/interface/agent/turn' && req.method === 'POST') {
      loseResponse = false;
      // The real adapter accepts and persists the turn, then the connection loses its reply.
      res.end = () => { res.destroy(); return res; };
    }
    if (route !== '/fixture/scenario') return original(req, res);
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body || '{}');
    options.offline = data.scenario === 'offline'; options.empty = data.scenario === 'empty';
    options.failed = data.scenario === 'failed'; options.partial = data.scenario !== 'complete';
    const args = { ...window, ...(data.window || {}) };
    if (data.scenario === 'missing') args.start = '';
    if (data.scenario === 'ambiguous') args.device = 'Repeated';
    if (data.scenario === 'error') args.timezone = 'Invalid/Zone';
    const view = value => ({ type: '', deviceIds: null, receiptId: null, jobId: null, artifactId: null, ...value });
    if (data.scenario === 'workspace-devices') model.enqueue(call('workspace_present', { version: 1, views: [view({ type: 'device-list' })] }), [assistantMessage('Synthetic device workspace.')]);
    else if (data.scenario === 'export-present-failed') model.enqueue(call('recording_ranges', args),
      modelResponder(({ request }) => { receiptId = last(request).id; return call('recording_export', { receiptId }); }),
      modelResponder(() => { throw new Error('Synthetic model failure after export acceptance'); }));
    else if (data.scenario === 'workspace') {
      model.enqueue(call('devices_list', {}), call('recording_ranges', args),
        modelResponder(({ request }) => { receiptId = last(request).id; return call('recording_export', { receiptId }); }),
        modelResponder(({ request }) => { jobId = last(request).job.jobId; return call('workspace_present', { version: 1, views: [
          view({ type: 'job-card', jobId }), view({ type: 'timeline', receiptId }),
          view({ type: 'device-list', deviceIds: ['CAMERA001'] }), view({ type: 'future-card' }),
        ] }); }), [assistantMessage('Synthetic workspace composed. The resident owns the export.')]);
    }
    else if (data.scenario === 'workspace-player') model.enqueue(call('job_artifacts', { jobId }),
      modelResponder(({ request }) => call('workspace_present', { version: 1, views: [
        view({ type: 'player', jobId, artifactId: last(request).videos[0].id }),
        view({ type: 'device-list', deviceIds: ['CAMERA001'] }), view({ type: 'timeline', receiptId }),
        view({ type: 'job-card', jobId }), view({ type: 'future-card' }),
      ] })), [assistantMessage('Synthetic player uses the existing registered artifact.')]);
    else if (data.scenario === 'snapshot') { /* Counters only; enqueue no model calls. */ }
    else if (data.scenario === 'response-lost') {
      loseResponse = true;
      model.enqueue([assistantMessage('请提供录像日期。')]);
    }
    else if (data.scenario === 'job-not-found') model.enqueue(call('job_get', { jobId: 'mistyped-job-id' }, 'lookup'), [assistantMessage('请核对任务编号。')]);
    else if (data.scenario === 'model-failed') model.enqueue(modelResponder(() => { throw new Error('Synthetic model failure'); }));
    else if (data.scenario === 'again') model.enqueue(call('recording_export', { receiptId }, 'again'), [assistantMessage('Same resident job. Playback can continue in the main area.')]);
    else model.enqueue(call('recording_ranges', args, `ranges-${model.calls.length}`),
      modelResponder(({ request }) => {
        const output = last(request);
        if (output.error) return [assistantMessage(`Fixture explanation: ${output.error.message}`)];
        receiptId = output.id; return call('recording_export', { receiptId }, `export-${model.calls.length}`);
      }),
      ...(['partial', 'complete', 'failed'].includes(data.scenario) ? [[assistantMessage('Fixture: export submitted. The main area shows the service window and durable job; local status checks need no model calls.')]] : []));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, calls: f.calls, modelCalls: model.calls.length }));
  });
  fs.writeFileSync(path.join(evidence, 'browser-fixture.json'), JSON.stringify({ url: f.url, directory: f.directory, synthetic: true }, null, 2));
  console.log(JSON.stringify({ url: f.url, synthetic: true }));
  process.on('SIGTERM', async () => { await f.close(); process.exit(0); });
}
if (require.main === module) start().catch(error => { console.error(error); process.exitCode = 1; });
