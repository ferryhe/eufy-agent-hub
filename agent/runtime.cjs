const { Agent, Runner, tool, user, OpenAIProvider } = require('@openai/agents');
const { OpenAI } = require('openai');
const { z } = require('zod');
const { RecordingTools } = require('./tools.cjs');

const instructions = `You help users export historical eufy recordings using resident API tools.
Reply in the user's language. Only export when asked. Ask for missing or ambiguous device/date/start/end; do not invent a year, AM/PM, timezone, or device serial. Relative dates require the user to provide a calendar date. A missing timezone may use the service default, which you must disclose from the receipt. Pass local times unchanged to recording_ranges; the service owns timezone/DST/cross-midnight rules.
Use exact device names from the user; duplicate names require the user to choose a serial. Never select a candidate yourself. Use device capabilities if asked; recordingExport.supported means eligibility, not verified evidence. Unknown Live is not an export blocker.
Before export obtain recording_ranges and use its id as receiptId in recording_export. Repeat requests reuse the same receipt/job. Report errors and ask for corrected details; never work around service time errors. NO_RECORDING means no export. Login/challenge: direct the user to loginPage, never ask for passwords or codes in chat.
After submitting, return job ID, service-normalized window including effective timezone, and current state. Do not repeatedly poll within model turns; the caller can wait without model calls. job_get and job_artifacts are available after logout. Return only actual registered video URLs from tools. Complete is true only when the tool reports complete:true (service succeeded + complete + coverageVerified + validation.passed). Playable partial remains partial. Give useful coverage/validation/diagnostics and errors. Never infer completeness from a file, exit code, or an end marker.
Use workspace_present to compose useful main-workspace results after obtaining tool data: device-list, timeline (receipt id), job-card (job id), player (job id and actual video artifact id). Never invent references or URLs. This tool presents existing data only; it does not export. Include all desired views in order, using null for unused fields. User pinning is independent and retained. Do not generate executable page code.`;

function bounded(value, fallback, max) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Agent limit must be 1–${max}.`);
  return n;
}
function createRecordingAgent(options = {}) {
  const client = options.client || new RecordingTools(options);
  const maxTurns = bounded(options.maxTurns ?? process.env.EUFY_AGENT_MAX_TURNS, 8, 16);
  const maxTokens = bounded(options.maxTokens ?? process.env.EUFY_AGENT_MAX_TOKENS, 1200, 4000);
  const timeoutMs = bounded(options.runTimeoutMs, 120000, 300000);
  const definitions = [
    ['session_status', 'Read login state and normal login page; contains no credentials/challenge material.', z.object({}), () => client.session()],
    ['devices_list', 'List service devices and independent eligibility/verification evidence.', z.object({}), () => client.devices()],
    ['device_resolve', 'Resolve exact user device name/serial. Ambiguous results require user selection.', z.object({ device: z.string() }), x => client.resolve(x.device)],
    ['device_capability', 'Read a named capability for an exactly resolved device.', z.object({ device: z.string(), capability: z.string() }), x => client.capability(x)],
    ['recording_ranges', 'Resolve exact device and normalize local date/time through the service. Null timezone uses service default; null endDay means same day. Returns a receipt id only for available footage.',
      z.object({ device: z.string(), day: z.string(), start: z.string(), end: z.string(), timezone: z.string().nullable(), endDay: z.string().nullable() }), x => client.ranges(x)],
    ['recording_export', 'Submit/reuse one durable export from an acknowledged recording_ranges receipt id.', z.object({ receiptId: z.string() }), x => client.submit(x)],
    ['job_get', 'Read durable progress once. Return control to user while running; do not repeatedly call.', z.object({ jobId: z.string() }), x => client.job(x)],
    ['workspace_present', 'Compose the main workspace using existing service references only. Registered types: device-list, timeline, job-card, player. deviceIds:null lists current inventory. Use null for unused fields. Unknown types show a localized fallback.',
      z.object({ version: z.literal(1), views: z.array(z.object({ type: z.string(), deviceIds: z.array(z.string()).nullable(), receiptId: z.string().nullable(), jobId: z.string().nullable(), artifactId: z.string().nullable() })) }),
      async value => { const { presentation } = await import('../interface/workspace/contract.mjs');
        client.state.presentation = { version: 1, views: presentation(value) }; client.save(); return client.state.presentation; }],
    ['job_artifacts', 'Read registered artifacts and authoritative complete/partial/failed result.', z.object({ jobId: z.string() }), x => client.artifacts(x)],
  ];
  const agent = new Agent({ name: 'Recording assistant', instructions,
    model: options.model || process.env.EUFY_AGENT_MODEL || 'gpt-4.1-mini',
    modelSettings: { maxTokens, parallelToolCalls: false, store: false, timeoutMs: 30000 },
    tools: definitions.map(([name, description, parameters, execute]) => tool({ name, description, parameters,
      execute: async input => {
        const value = await execute(input);
        client.events.push({ name, input, output: value });
        return JSON.stringify(value);
      } })),
  });
  const runner = new Runner({ tracingDisabled: true,
    ...(typeof agent.model === 'string' ? { modelProvider: new OpenAIProvider({
      openAIClient: new OpenAI({ timeout: 30000, maxRetries: 0 }), useResponses: true,
    }) } : {}),
  });
  let running = false;
  return { agent, client, async turn(text, { signal, preferredLocale } = {}) {
    if (running) throw new Error('This caller-owned session already has an active turn.');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Provide 1–16000 characters.');
    running = true;
    try {
      agent.instructions = instructions + (['en', 'zh-CN'].includes(preferredLocale)
        ? `\nThe caller's preferred response language is ${preferredLocale}. Use it for explanations. Preserve user text, device names and all tool arguments unchanged.` : '');
      (client.state.userInputs ??= []).push(text);
      client.save();
      const result = await runner.run(agent, [...client.state.history, user(text)], {
        maxTurns, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      client.state.history = result.history;
      client.save();
      return { text: result.finalOutput, jobs: Object.values(client.state.requests).map(r => ({ requestId: r.requestId, jobId: r.jobId ?? null })) };
    } finally { running = false; }
  } };
}
module.exports = { createRecordingAgent };
