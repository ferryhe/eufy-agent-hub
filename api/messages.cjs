function messageI18n(key, params = {}) {
  return { key, params };
}

function serviceError(message, key, params = {}, options) {
  const error = new Error(message, options);
  error.i18n = messageI18n(key, params);
  return error;
}

function setMessage(state, message, i18n) {
  state.message = message;
  if (i18n) state.messageI18n = i18n;
  else delete state.messageI18n;
}

function errorBody(error) {
  return { error: error.message, ...(error.i18n ? { errorI18n: error.i18n } : {}) };
}

module.exports = { messageI18n, serviceError, setMessage, errorBody };
