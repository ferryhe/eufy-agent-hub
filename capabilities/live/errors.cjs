const statuses = { UNAUTHENTICATED: 401, DEVICE_NOT_FOUND: 404, LIVE_SESSION_NOT_FOUND: 404,
  LIVE_UNSUPPORTED: 422, LIVE_NOT_VERIFIED: 409, LIVE_REQUEST_CONFLICT: 409, SERVICE_BUSY: 409, LIVE_INACTIVE: 409,
  LIVE_MEDIA_CLAIMED: 409, LIVE_SCOPE_CHANGED: 409, SERVICE_STOPPING: 503, DEVICE_OFFLINE: 503,
  LIVE_CONNECTION_LOST: 503, LIVE_COMMAND_REJECTED: 502, LIVE_COMMAND_TIMEOUT: 504, LIVE_MEDIA_TIMEOUT: 504,
  LIVE_CLIENT_TIMEOUT: 408, LIVE_DECODER_ERROR: 502, LIVE_RUNTIME_ERROR: 503, LIVE_CLEANUP_FAILED: 503 };
const failure = code => Object.assign(new Error(code), { code, status: statuses[code] || 503 });
const safeError = error => statuses[error?.code] ? failure(error.code)
  : error?.status && error?.code ? error : failure('LIVE_CONNECTION_LOST');
module.exports = { failure, safeError };
