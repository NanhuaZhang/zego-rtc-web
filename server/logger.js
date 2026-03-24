const { AsyncLocalStorage } = require('async_hooks');

const requestContextStorage = new AsyncLocalStorage();

const LEVEL_PRIORITIES = {
  debug: 10,
  info: 20,
  log: 20,
  warn: 30,
  error: 40,
};

function getConfiguredLogLevel() {
  const configured = String(process.env.LOG_LEVEL || 'log').toLowerCase();
  return LEVEL_PRIORITIES[configured] ? configured : 'log';
}

function shouldLog(level) {
  const normalizedLevel = LEVEL_PRIORITIES[level] ? level : 'log';
  const configuredLevel = getConfiguredLogLevel();
  return LEVEL_PRIORITIES[normalizedLevel] >= LEVEL_PRIORITIES[configuredLevel];
}

function getConsoleMethod(level) {
  if (level === 'debug' || level === 'info' || level === 'log') {
    return 'log';
  }
  return level;
}

function sanitizeForLog(value, seen = new WeakSet()) {
  const secretKeyPattern = /(apikey|accesskey|secret|token|signature)/i;

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}...<truncated>` : value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForLog(item, seen));
  }

  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if (secretKeyPattern.test(key)) {
      result[key] = '[REDACTED]';
      return;
    }
    result[key] = sanitizeForLog(item, seen);
  });
  return result;
}

function extractError(error) {
  if (!error) {
    return undefined;
  }

  return sanitizeForLog({
    message: error.message,
    code: error.code,
    stack: error.stack,
    response: error.response
      ? {
          status: error.response.status,
          data: error.response.data,
        }
      : undefined,
  });
}

function getRequestContext() {
  return requestContextStorage.getStore();
}

function withRequestContext(context, fn) {
  return requestContextStorage.run(context, fn);
}

function log(level, scope, message, data) {
  const normalizedLevel = LEVEL_PRIORITIES[level] ? level : 'log';
  if (!shouldLog(normalizedLevel)) {
    return;
  }

  const timestamp = new Date().toISOString();
  const context = getRequestContext();
  const scopeWithTrace = context?.requestId ? `${scope}#${context.requestId}` : scope;
  const prefix = `[${timestamp}] [${normalizedLevel.toUpperCase()}] [${scopeWithTrace}] ${message}`;
  const consoleMethod = getConsoleMethod(normalizedLevel);

  if (data === undefined) {
    console[consoleMethod](prefix);
    return;
  }

  console[consoleMethod](prefix, sanitizeForLog(data));
}

module.exports = {
  extractError,
  getRequestContext,
  log,
  sanitizeForLog,
  withRequestContext,
};
