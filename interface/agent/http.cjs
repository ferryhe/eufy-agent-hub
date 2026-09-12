const path = require('node:path');
const { RecordingTools } = require('../../agent/tools.cjs');
const { createRecordingAgent } = require('../../agent/runtime.cjs');

// One resident owns this conversation. Browser requests only observe its work.
function installAgentRoutes(server, { getOrigin, ...options }) {
  let client, runtime, active, stopping = false;
  const getClient = () => {
    if (client) return client;
    const baseUrl = getOrigin();
    client = new RecordingTools({ baseUrl, statePath: options.statePath
      ?? process.env.EUFY_INTERFACE_AGENT_STATE
      ?? path.resolve(__dirname, `../../output/agent/interface-${new URL(baseUrl).port}.json`) });
    client.state.interface ??= { turns: [] };
    for (const turn of client.state.interface.turns) {
      if (turn.state === 'running') {
        turn.state = 'interrupted';
        turn.error = { code: 'TURN_INTERRUPTED', message: 'The resident restarted. Existing jobs remain available; send a new message to continue.' };
      }
    }
    client.save();
    return client;
  };
  async function snapshot() {
    const c = getClient();
    const jobs = await Promise.all([...new Set(Object.values(c.state.requests).map(r => r.jobId).filter(Boolean))]
      .map(jobId => c.job({ jobId })));
    return { turns: c.state.interface.turns, receipts: Object.values(c.state.receipts), jobs,
      notices: c.events.filter(e => e.output?.error).map(e => e.output), busy: Boolean(active) };
  }
  const original = server.listeners('request')[0];
  server.removeListener('request', original);
  server.on('request', async (req, res) => {
    const origin = getOrigin(), route = new URL(req.url, origin).pathname;
    if (!route.startsWith('/interface/agent/')) return original(req, res);
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const fail = (status, code, message) => send(status, { error: { code, message } });
    try {
      if (req.headers.host !== new URL(origin).host) return fail(403, 'LOCAL_HOST_REQUIRED', 'Use the local service address.');
      if (req.method === 'GET' && route === '/interface/agent/state') return send(200, await snapshot());
      if (req.method !== 'POST' || route !== '/interface/agent/turn') return fail(404, 'NOT_FOUND', 'Unknown interface route.');
      if (req.headers.origin !== origin) return fail(403, 'LOCAL_ORIGIN_REQUIRED', 'Use the local page.');
      if (!req.headers['content-type']?.startsWith('application/json')) return fail(415, 'JSON_REQUIRED', 'Use JSON.');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 20000) return fail(413, 'INPUT_TOO_LONG', 'Input is too long.');
      }
      let data;
      try { data = JSON.parse(body); } catch { return fail(400, 'INVALID_REQUEST', 'Invalid JSON.'); }
      if (!data || Object.keys(data).some(k => !['id', 'text', 'locale'].includes(k))
        || typeof data.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(data.id)
        || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 16000
        || !['en', 'zh-CN'].includes(data.locale)) return fail(400, 'INVALID_REQUEST', 'Provide a message, turn ID and response locale.');
      const c = getClient(), turns = c.state.interface.turns;
      if (turns.some(t => t.id === data.id)) return send(202, { id: data.id, reused: true });
      if (active) return fail(409, 'TURN_BUSY', 'A conversation turn is still running.');
      if (stopping) return fail(503, 'SERVICE_STOPPING', 'The resident is stopping.');
      // Keep SDK construction lazy: normal login/browsing works without an API key.
      try { runtime ??= createRecordingAgent({ ...options, client: c }); }
      catch { return fail(503, 'AGENT_UNAVAILABLE', 'The recording assistant is not configured. Normal browsing is available.'); }
      const turn = { id: data.id, text: data.text, locale: data.locale, state: 'running', response: '', notices: [] };
      turns.push(turn); c.events.length = 0; c.save();
      active = Promise.resolve().then(() => runtime.turn(data.text, { preferredLocale: data.locale }))
        .then(result => { turn.response = result.text; turn.state = 'completed'; })
        .catch(() => {
          turn.state = 'failed';
          turn.error = { code: 'AGENT_FAILED', message: 'The assistant could not finish this turn. Existing jobs continue; review their status before continuing.' };
        }).finally(() => {
          turn.notices = c.events.filter(e => e.output?.error).map(e => e.output);
          try { c.save(); } finally { active = null; }
        });
      // Do not bind the owned promise to req/res abort or close.
      active.catch(() => {});
      send(202, { id: turn.id, reused: false });
    } catch { fail(503, 'INTERFACE_UNAVAILABLE', 'The conversation state is unavailable.'); }
  });
  return { async shutdown() { stopping = true; await active; } };
}
module.exports = { installAgentRoutes };
