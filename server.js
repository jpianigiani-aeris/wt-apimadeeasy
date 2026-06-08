const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const INDEX_PATH = path.join(__dirname, 'web', 'index.html');
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024; // 2MB limit for incoming proxy payloads.
const OUTBOUND_REQUEST_TIMEOUT_MS = 15000;
const BLOCKED_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
const CACHED_INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf-8');

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req, res) {
  return new Promise((resolve, reject) => {
    let data = '';
    let totalBytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        sendJson(res, 413, { error: 'Request body too large' });
        req.destroy();
        resolve(null);
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(data);
    });
    req.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

function joinUrl(baseUrl, endpoint) {
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '');
  const normalizedPath = String(endpoint || '').replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const safeHeaders = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || '').trim().toLowerCase();
    if (!name || BLOCKED_HEADER_NAMES.has(name)) {
      continue;
    }
    safeHeaders[name] = String(rawValue);
  }
  return safeHeaders;
}

async function handleProxy(req, res) {
  let parsed;
  try {
    const raw = await parseBody(req, res);
    if (raw === null) {
      return;
    }
    parsed = JSON.parse(raw || '{}');
  } catch (error) {
    return sendJson(res, 400, { error: 'Invalid JSON payload' });
  }

  const method = String(parsed.method || 'GET').toUpperCase();
  const baseUrl = String(parsed.baseUrl || '').trim();
  const endpoint = String(parsed.endpoint || '').trim();

  if (!ALLOWED_METHODS.has(method)) {
    return sendJson(res, 400, { error: `Unsupported method: ${method}` });
  }

  let target;
  try {
    target = new URL(joinUrl(baseUrl, endpoint));
  } catch {
    return sendJson(res, 400, { error: 'Invalid baseUrl or endpoint' });
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return sendJson(res, 400, { error: 'Only http and https are supported' });
  }

  const outgoingHeaders = sanitizeHeaders(parsed.headers);
  const fetchOptions = {
    method,
    headers: outgoingHeaders
  };

  const hasBody = parsed.body !== null && parsed.body !== undefined && parsed.body !== '';
  if (METHODS_WITH_BODY.has(method) && hasBody) {
    fetchOptions.body = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OUTBOUND_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(target, { ...fetchOptions, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    const responseHeaders = Object.fromEntries(response.headers.entries());

    let body = text;
    const contentType = responseHeaders['content-type'] || '';
    if (contentType.includes('application/json') && text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return sendJson(res, 200, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      return sendJson(res, 504, {
        error: 'Target endpoint timed out'
      });
    }
    return sendJson(res, 502, {
      error: 'Unable to reach target endpoint',
      details: error.message
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && req.url === '/api/request') {
    return handleProxy(req, res);
  }

  if (req.method === 'GET' && req.url === '/') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(CACHED_INDEX_HTML);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Unable to load UI');
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`Watchtower API Made Easy listening on http://localhost:${PORT}`);
});
