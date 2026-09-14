const Ajv = require('ajv');
const deviceSchemas = require('../capabilities/devices/schemas.cjs');
const { CAPABILITIES, STATUSES } = require('../capabilities/devices/capabilities.cjs');
const string = { type: 'string' };
const nonempty = { type: 'string', pattern: '\\S' };
const nullableString = { type: ['string', 'null'] };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = items => ({ type: 'array', items });
const time = { day: string, start: string, end: string, timezone: string, endDay: string };
const window = object({ version: { const: 1 },
  input: object({ day: string, start: string, end: string, timezone: nullableString }),
  normalized: object({ start: string, end: string, timezone: string }),
});
const errorCodes = ['UNAUTHENTICATED', 'UNSUPPORTED_DEVICE', 'DEVICE_UNAVAILABLE', 'DEVICE_NOT_FOUND',
  'SERVICE_BUSY', 'SERVICE_STOPPING', 'INVALID_REQUEST', 'INVALID_WINDOW', 'INVALID_TIMEZONE',
  'AMBIGUOUS_OR_NONEXISTENT_TIME', 'JSON_REQUIRED', 'INPUT_TOO_LONG', 'LOCAL_HOST_REQUIRED',
  'LOCAL_ORIGIN_REQUIRED', 'JOB_UNAVAILABLE', 'JOB_NOT_FOUND', 'ARTIFACT_NOT_FOUND', 'NOT_FOUND',
  'INTERNAL_ERROR', 'PARTIAL_RECORDING', 'EXPORT_FAILED', 'JOB_CANCELLED', 'JOB_INTERRUPTED', 'LOGIN_REQUIRED', 'CAPABILITY_RECORDS_UNAVAILABLE',
  'PLAYBACK_SESSION_NOT_FOUND', 'CONTROL_NOT_VERIFIED', 'CONTROL_INACTIVE', 'CONTROL_SCOPE_CHANGED', 'CONTROL_CONTEXT_UNAVAILABLE',
  'CONTROL_CONNECTION_LOST', 'CONTROL_REJECTED', 'CONTROL_RESPONSE_INVALID', 'CONTROL_SEND_FAILED', 'CONTROL_TIMEOUT',
  'CONTROL_STARTUP_TIMEOUT', 'CONTROL_MEDIA_TIMEOUT', 'CONTROL_CLEANUP_FAILED', 'PAUSE_MEDIA_ADVANCED',
  'PLAYBACK_REQUEST_NOT_FOUND', 'PLAYBACK_REQUEST_CONFLICT', 'PLAYBACK_REQUEST_EXPIRED', 'PLAYBACK_STALE_SESSION',
  'PLAYBACK_CLIENT_CONFLICT', 'PLAYBACK_NO_RECORDING', 'PLAYBACK_MEDIA_UNAVAILABLE', 'PLAYBACK_MEDIA_TIMEOUT',
  'PLAYBACK_MEDIA_SLOW_CLIENT', 'PLAYBACK_DECODER_FAILED', 'PLAYBACK_RUNTIME_UNAVAILABLE',
  'LIVE_SESSION_NOT_FOUND', 'LIVE_REQUEST_CONFLICT', 'LIVE_CLIENT_CONFLICT', 'LIVE_UNSUPPORTED', 'LIVE_CAPABILITY_UNKNOWN',
  'LIVE_DEVICE_OFFLINE', 'LIVE_SCOPE_CHANGED', 'LIVE_CONNECTION_FAILED', 'LIVE_CONNECTION_LOST', 'LIVE_COMMAND_REJECTED',
  'LIVE_COMMAND_TIMEOUT', 'LIVE_MEDIA_TIMEOUT', 'LIVE_RUNTIME_UNAVAILABLE', 'LIVE_DECODER_FAILED', 'LIVE_CLEANUP_FAILED', 'LIVE_INACTIVE'];
const error = object({ code: { enum: errorCodes }, message: string });
const discovery = object({ status: { enum: ['not_requested', 'succeeded', 'failed'] },
  completeness: { enum: ['unknown', 'incomplete'] }, pagination: { const: 'unverified' },
  pagesRead: { type: 'integer', minimum: 0 }, receivedCount: { type: 'integer', minimum: 0 },
  uniqueCount: { type: 'integer', minimum: 0 }, limitReached: { type: 'boolean' },
  failedPage: { type: ['integer', 'null'], minimum: 1 }, retryable: { type: 'boolean' }, stale: { type: 'boolean' },
  reasons: array({ enum: ['pagination_unverified', 'request_limit_reached', 'inventory_request_failed', 'invalid_inventory', 'capability_records_unavailable'] }),
});
const artifact = object({ id: string, name: string, path: string, url: string,
  playable: { type: 'boolean' }, validated: { type: 'boolean' },
  outcome: { enum: ['complete', 'partial', 'failed', 'cancelled', null] },
});
const device = object({ serial: string, name: string, model: nullableString, homeBaseId: nullableString,
  channel: { type: ['integer', 'null'], minimum: 0 }, availability: { enum: ['unknown', 'unavailable', 'online', 'offline'] },
  recordingExport: object({ supported: { type: 'boolean' }, status: { enum: STATUSES } }),
  firmware: deviceSchemas.firmware,
  state: object({ inventoryStatus: { type: ['integer', 'null'] }, reason: string, observedAt: nullableString }),
  verificationScope: deviceSchemas.scope, verificationHistory: array(deviceSchemas.record),
  capabilities: object(Object.fromEntries(CAPABILITIES.map(name => [name, deviceSchemas.capability]))),
});
const result = { type: ['object', 'null'], required: ['outcome'], properties: {
  outcome: { enum: ['complete', 'partial', 'failed', 'cancelled'] },
  coverageVerified: { type: 'boolean' }, validation: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] },
  window, coverage: { type: ['object', 'null'] }, media: { type: ['object', 'null'] },
  diagnostics: array({ type: 'object' }), completeness: { type: ['object', 'null'] }, timeline: { type: 'object' },
} };
const job = object({ jobId: string, requestId: string, homeBaseId: string, serial: string, window,
  state: { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }, stage: string,
  retryOfJobId: nullableString, attempt: { type: 'integer', minimum: 1 }, cancellationRequestedAt: nullableString,
  progress: { type: 'number', minimum: 0, maximum: 1 }, createdAt: string, updatedAt: string,
  result, artifacts: array(artifact), error: { anyOf: [error, { type: 'null' }] },
});
const playbackProperties = { sessionId: nonempty,
  state: { enum: ['opening', 'playing', 'pausing', 'paused', 'resuming', 'closing', 'closed', 'failed'] },
  verificationScope: deviceSchemas.scope, speed: { enum: [1, 2, 4, 16] },
  positionMs: { type: ['integer', 'null'] }, pauseExpiresAtMs: { type: ['integer', 'null'] }, maxPauseMs: { const: 30000 },
  allowedOperations: array({ enum: ['pause', 'resume', 'close'] }), verifiedStartSpeeds: deviceSchemas.controls.properties.verifiedStartSpeeds,
  stopConfirmed: { type: 'boolean' }, cleanupComplete: { type: 'boolean' }, error: { anyOf: [error, { type: 'null' }] },
  operations: array(object({ operation: { enum: ['start', 'pause', 'resume', 'stop'] }, sentAtMs: { type: 'integer' },
    receivedAtMs: { type: ['integer', 'null'] }, returnCode: { type: ['integer', 'null'] } })),
  channelChecks: object(Object.fromEntries(['queryMatched', 'queryRejected', 'commandMatched', 'commandRejected', 'mediaMatched', 'mediaRejected']
    .map(name => [name, { type: 'integer', minimum: 0 }]))), channelIsolation: { const: 'unverified' },
  requestId: nonempty, residentEpoch: nonempty, window,
  resources: object(Object.fromEntries(['protocolClosed', 'connectionClosed', 'decoderClosed', 'streamsClosed'].map(name => [name, { type: 'boolean' }]))),
  media: object({ url: nonempty, contentType: { const: 'multipart/x-mixed-replace; boundary=frame' },
    timestampSemantics: { const: 'source-received-position' }, sourceReceivedPositionMs: { type: ['integer', 'null'] },
    firstFrameLatencyMs: { type: ['integer', 'null'], minimum: 0 },
    mediaEpoch: { type: 'integer', minimum: 1 }, frameSequence: { type: 'integer', minimum: 0 },
    decodedFrames: { type: 'integer', minimum: 0 }, bytes: { type: 'integer', minimum: 0 }, connected: { type: 'boolean' },
    audio: { const: false }, maxFps: { const: 5 }, maxWidth: { const: 960 }, expiresAtMs: { type: 'integer' } }),
};
const playbackRequired = ['sessionId', 'state', 'verificationScope', 'speed', 'positionMs', 'pauseExpiresAtMs', 'maxPauseMs',
  'allowedOperations', 'verifiedStartSpeeds', 'stopConfirmed', 'cleanupComplete', 'error', 'operations', 'channelChecks', 'channelIsolation'];
const playback = object(playbackProperties, playbackRequired);
const contract = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:eufy-agent-hub:api:v1',
  title: 'Eufy resident recording API v1',
  definitions: {
    login: object({ email: nonempty, password: { type: 'string', minLength: 1 }, country: { type: 'string', pattern: '^\\s*[a-zA-Z]{2}\\s*$' } }),
    verification: object({ code: nonempty }),
    empty: object({}),
    accepted: object({ ok: { const: true } }),
    identity: { type: 'object', required: ['requestId'], properties: { requestId: nonempty } },
    retry: object({ requestId: nonempty }),
    jobListQuery: object({ pageSize: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }, cursor: nonempty,
      state: { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }, serial: nonempty }, []),
    window: object(time, ['day', 'start', 'end']),
    export: object({ requestId: nonempty, serial: nonempty, ...time }, ['requestId', 'serial', 'day', 'start', 'end']),
    playbackStart: object({ serial: nonempty, ...time, speed: { type: 'number' }, media: { type: 'boolean' }, requestId: nonempty, residentEpoch: nonempty }, ['serial', 'day', 'start', 'end']),
    playbackSeek: object({ requestId: nonempty, residentEpoch: nonempty, ...time }, ['requestId', 'residentEpoch', 'day', 'start', 'end']),
    playbackResponse: object({ playback, reused: { type: 'boolean' } }, ['playback']),
    playbackRequest: object({ requestId: nonempty, residentEpoch: nonempty, operation: { enum: ['create', 'seek'] },
      state: { enum: ['pending', 'succeeded', 'failed'] }, fromSessionId: nullableString, sessionId: nullableString,
      cleanupComplete: { type: 'boolean' }, error: { anyOf: [error, { type: 'null' }] } }),
    playbackRequestResponse: object({ request: { $ref: '#/definitions/playbackRequest' } }),
    liveStart: object({ serial: nonempty, requestId: nonempty, maxDurationMs: { type: 'integer', minimum: 1000, maximum: 60000 } }, ['serial', 'requestId']),
    liveResponse: object({ live: { $ref: '#/definitions/live' }, reused: { type: 'boolean' } }, ['live']),
    live: object({ sessionId: nonempty, requestId: nonempty, serial: nonempty,
      state: { enum: ['opening', 'streaming', 'stopping', 'stopped', 'failed'] }, homeBaseId: nullableString,
      channel: { type: ['integer', 'null'], minimum: 0 }, verificationScope: { anyOf: [deviceSchemas.scope, { type: 'null' }] },
      capability: { anyOf: [deviceSchemas.capability, { type: 'null' }] }, maxDurationMs: { type: 'integer', minimum: 1000, maximum: 60000 },
      expiresAtMs: { type: 'integer' }, stopConfirmed: { type: 'boolean' }, cleanupComplete: { type: 'boolean' },
      resources: object(Object.fromEntries(['protocolClosed', 'connectionClosed', 'decoderClosed', 'streamsClosed'].map(name => [name, { type: 'boolean' }]))),
      error: { anyOf: [error, { type: 'null' }] }, media: object({ url: nonempty,
        contentType: { const: 'multipart/x-mixed-replace; boundary=frame' }, decodedFrames: { type: 'integer', minimum: 0 },
        bytes: { type: 'integer', minimum: 0 }, connected: { type: 'boolean' }, audio: { const: false } }),
      operations: array(object({ operation: { enum: ['start', 'stop'] }, sentAtMs: { type: 'integer' }, returnCode: { type: ['integer', 'null'] } })),
      channelChecks: object(Object.fromEntries(['commandMatched', 'commandRejected', 'mediaMatched', 'mediaRejected']
        .map(name => [name, { type: 'integer', minimum: 0 }]))),
    }),
    normalizedWindow: window, device, discovery, artifact, job,
    error: object({ error, discovery }, ['error']),
    session: object({ authenticated: { type: 'boolean' }, phase: string, captcha: nullableString, busy: { type: 'boolean' }, residentEpoch: nonempty, loginUrl: { const: '/api/v1/session/login' }, verificationUrl: { const: '/api/v1/session/verify' }, logoutUrl: { const: '/api/v1/session/logout' } },
      ['authenticated', 'phase', 'captcha', 'busy', 'residentEpoch', 'loginUrl', 'verificationUrl', 'logoutUrl']),
    devices: object({ devices: array(device), discovery }), deviceResponse: object({ device, discovery }),
    capabilityResponse: object({ serial: string, capability: string, ...deviceSchemas.capability.properties,
      verificationScope: deviceSchemas.scope, discovery }, ['serial', 'capability', 'status', 'reason', 'evidence', 'verificationScope', 'discovery']),
    ranges: object({ serial: string, window, ranges: array(object({ start: string, end: string })), coverage: { type: 'null' },
      availability: { enum: ['available', 'none'] }, code: { enum: ['NO_RECORDING', null] } }),
    submission: object({ job, reused: { type: 'boolean' } }), jobResponse: object({ job }),
    jobList: object({ jobs: array(job), nextCursor: nullableString }),
    artifacts: object({ jobId: string, artifacts: array(artifact) }),
  },
};
const ajv = new Ajv({ strict: false });
ajv.addSchema(contract);
const validators = Object.fromEntries(['identity', 'retry', 'jobListQuery', 'window', 'export', 'playbackStart', 'playbackSeek', 'liveStart', 'login', 'verification', 'empty'].map(name =>
  [name, ajv.getSchema(`${contract.$id}#/definitions/${name}`)]));
function validateRequest(name, data) {
  const validate = validators[name];
  if (!validate(data))
    throw Object.assign(new Error(`Invalid ${name} request: ${ajv.errorsText(validate.errors)}`), { status: 400, code: 'INVALID_REQUEST' });
}
module.exports = { contract, validateRequest };
