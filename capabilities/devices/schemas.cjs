const { CAPABILITIES, STATUSES } = require('./capabilities.cjs');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const nonempty = { type: 'string', pattern: '\\S' };
const nullableString = { anyOf: [nonempty, { type: 'null' }] };
const firmware = object({ main: nullableString, secondary: nullableString });
const identity = { serial: nonempty, model: nullableString, firmware };
const scope = object({ ...identity, homeBase: { anyOf: [object(identity), { type: 'null' }] },
  channel: { type: ['integer', 'null'], minimum: 0 } });
const evidence = object({ source: nonempty, observedAt: nonempty, outcome: nonempty });
const capability = object({ status: { enum: STATUSES }, reason: nonempty, evidence: { type: 'array', items: evidence } });
const record = object({ scope, capability: { enum: CAPABILITIES }, ...capability.properties });
const reachability = object({ serial: nonempty, status: { enum: ['online', 'offline'] }, reason: nonempty, observedAt: nonempty });
const store = object({ version: { const: 1 }, records: { type: 'array', items: record },
  reachability: { type: 'array', items: reachability } }, ['version', 'records']);

module.exports = { firmware, scope, evidence, capability, record, reachability, store };
