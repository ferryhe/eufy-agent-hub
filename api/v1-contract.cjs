const Ajv = require('ajv');
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
  'INTERNAL_ERROR', 'PARTIAL_RECORDING', 'EXPORT_FAILED', 'JOB_CANCELLED', 'LOGIN_REQUIRED'];
const error = object({ code: { enum: errorCodes }, message: string });
const artifact = object({ id: string, name: string, path: string, url: string,
  playable: { type: 'boolean' }, validated: { type: 'boolean' },
  outcome: { enum: ['complete', 'partial', 'failed', 'cancelled', null] },
});
const device = object({ serial: string, name: string, model: nullableString, homeBaseId: nullableString,
  channel: { type: ['integer', 'null'] }, availability: { enum: ['unknown', 'unavailable'] },
  recordingExport: object({ supported: { type: 'boolean' }, status: { enum: ['verified', 'unsupported'] } }),
});
const result = { type: ['object', 'null'], required: ['outcome'], properties: {
  outcome: { enum: ['complete', 'partial', 'failed', 'cancelled'] },
  coverageVerified: { type: 'boolean' }, validation: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] },
  window, coverage: { type: ['object', 'null'] }, media: { type: ['object', 'null'] },
  diagnostics: array({ type: 'object' }), completeness: { type: ['object', 'null'] }, timeline: { type: 'object' },
} };
const job = object({ jobId: string, requestId: string, homeBaseId: string, serial: string, window,
  state: { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }, stage: string,
  progress: { type: 'number', minimum: 0, maximum: 1 }, createdAt: string, updatedAt: string,
  result, artifacts: array(artifact), error: { anyOf: [error, { type: 'null' }] },
});
const contract = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:eufy-agent-hub:api:v1',
  title: 'Eufy resident recording API v1',
  definitions: {
    login: object({ email: nonempty, password: { type: 'string', minLength: 1 }, country: { type: 'string', pattern: '^\\s*[a-zA-Z]{2}\\s*$' } }),
    verification: object({ code: nonempty }),
    empty: object({}),
    accepted: object({ ok: { const: true } }),
    identity: { type: 'object', required: ['requestId'], properties: { requestId: nonempty } },
    window: object(time, ['day', 'start', 'end']),
    export: object({ requestId: nonempty, serial: nonempty, ...time }, ['requestId', 'serial', 'day', 'start', 'end']),
    normalizedWindow: window, device, artifact, job,
    error: object({ error }),
    session: object({ authenticated: { type: 'boolean' }, phase: string, captcha: nullableString, busy: { type: 'boolean' }, loginUrl: { const: '/api/v1/session/login' }, verificationUrl: { const: '/api/v1/session/verify' }, logoutUrl: { const: '/api/v1/session/logout' } }),
    devices: object({ devices: array(device) }), deviceResponse: object({ device }),
    ranges: object({ serial: string, window, ranges: array(object({ start: string, end: string })), coverage: { type: 'null' },
      availability: { enum: ['available', 'none'] }, code: { enum: ['NO_RECORDING', null] } }),
    submission: object({ job, reused: { type: 'boolean' } }), jobResponse: object({ job }),
    artifacts: object({ jobId: string, artifacts: array(artifact) }),
  },
};
const ajv = new Ajv({ strict: false });
ajv.addSchema(contract);
const validators = Object.fromEntries(['identity', 'window', 'export', 'login', 'verification', 'empty'].map(name =>
  [name, ajv.getSchema(`${contract.$id}#/definitions/${name}`)]));
function validateRequest(name, data) {
  const validate = validators[name];
  if (!validate(data))
    throw Object.assign(new Error(`Invalid ${name} request: ${ajv.errorsText(validate.errors)}`), { status: 400, code: 'INVALID_REQUEST' });
}
module.exports = { contract, validateRequest };
