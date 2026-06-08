const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const INDEX_PATH = path.join(__dirname, 'web', 'index.html');
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function joinUrl(baseUrl, endpoint) {
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '');
  const normalizedPath = String(endpoint || '').replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

async function handleProxy(req, res) {
  let parsed;
  try {
    const raw = await parseBody(req);
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

  const outgoingHeaders = parsed.headers && typeof parsed.headers === 'object' ? parsed.headers : {};
  const fetchOptions = {
    method,
    headers: outgoingHeaders
  };

  if (method !== 'GET' && parsed.body !== undefined && parsed.body !== null && parsed.body !== '') {
    fetchOptions.body = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body);
  }

  try {
    const response = await fetch(target, fetchOptions);
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
      const html = fs.readFileSync(INDEX_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Unable to load UI');
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`wt-apimadeeasy listening on http://${HOST}:${PORT}`);
});
