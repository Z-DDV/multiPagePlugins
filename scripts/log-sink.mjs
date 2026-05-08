import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const LOG_FILE = resolve(PROJECT_ROOT, 'runtime.log');
const HOST = '127.0.0.1';
const PORT = 17373;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

async function handleLog(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('error', () => sendJson(res, 500, { ok: false, error: 'read error' }));
  req.on('end', async () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = raw ? JSON.parse(raw) : {};
      const line = `${JSON.stringify(parsed)}\n`;
      await appendFile(LOG_FILE, line, 'utf8');
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === '/log') {
    handleLog(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[log-sink] listening on http://${HOST}:${PORT}/log`);
  // eslint-disable-next-line no-console
  console.log(`[log-sink] writing to ${LOG_FILE}`);
});

