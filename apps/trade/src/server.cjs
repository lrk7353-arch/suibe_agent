'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { handleTurn } = require('./engine/engine.cjs');
const S = require('./engine/state.cjs');
const C = require('./engine/constants.cjs');
const { fromEnv } = require('./engine/model-adapter.cjs');

const SRC_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SRC_DIR, '..');
const PUBLIC_DIR = path.join(SRC_DIR, 'public');
const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');
const AUDIT_DIR = path.join(RUNS_DIR, 'audit');
const CASES_FILE = path.join(PROJECT_ROOT, 'tests', 'cases', 'trade-cases.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function ensureDirs() {
  for (const dir of [RUNS_DIR, AUDIT_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeSession(id) {
  const text = String(id || '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : `anon-${Date.now().toString(36)}`;
}

function readCasesSummary() {
  try {
    const data = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    const cases = Array.isArray(data.cases) ? data.cases : [];
    const byCategory = {};
    for (const c of cases) byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    return { total: cases.length, byCategory, version: data.meta?.version || null };
  } catch {
    return { total: 0, byCategory: {}, version: null };
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveFile(res, filePath, extraHeaders = {}) {
  fs.readFile(filePath, (err, buffer) => {
    if (err) return json(res, 404, { ok: false, message: '没有这个文件' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    });
    res.end(buffer);
  });
}

async function readJson(req, limit = 96 * 1024) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > limit) {
      const err = new Error('请求体过大');
      err.code = 'body_too_large';
      throw err;
    }
    parts.push(part);
  }
  const raw = Buffer.concat(parts).toString('utf8');
  if (!raw) throw Object.assign(new Error('请求体为空'), { code: 'empty_body' });
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad_json' }); }
}

function appendAudit(sessionId, record) {
  try {
    ensureDirs();
    const file = path.join(AUDIT_DIR, `session-${sanitizeSession(sessionId)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    try { fs.appendFileSync(path.join(RUNS_DIR, 'server-errors.log'), `${new Date().toISOString()} audit ${err.message}\n`); } catch { /* 忽略日志写入失败 */ }
  }
}

function createServer({ port = 18866, model = null, now = () => Date.now() } = {}) {
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const startedAt = Date.now();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return json(res, 403, { ok: false, code: 'origin_denied', message: '请求来源不受支持' });
      const commonHeaders = {
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'"
      };

      if (req.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), commonHeaders);
        if (url.pathname === '/demo.css') return serveFile(res, path.join(PUBLIC_DIR, 'demo.css'), commonHeaders);
        if (url.pathname === '/demo.js') return serveFile(res, path.join(PUBLIC_DIR, 'demo.js'), commonHeaders);
        if (url.pathname.startsWith('/assets/')) {
          const name = path.basename(url.pathname);
          return serveFile(res, path.join(PUBLIC_DIR, 'assets', name), commonHeaders);
        }
        if (url.pathname === '/api/health') {
          return json(res, 200, {
            ok: true,
            version: C.DEMO_VERSION,
            port,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            model: model
              ? { mode: model.mode || 'http', provider: model.provider || 'http', name: model.name, model: model.model || null, note: '真实模型只负责参数提案，金额由确定性工具计算' }
              : { mode: 'simulated', provider: 'simulated', name: 'rules-v1', note: '离线规则抽取，可复现' },
            cases: readCasesSummary(),
            teachingCase: { caseId: C.CASE_ID, currency: 'USD', note: '固定教学数据，非实时查询' }
          });
        }
        if (url.pathname === '/api/cases') {
          return json(res, 200, { ok: true, ...readCasesSummary() });
        }
        if (url.pathname === '/api/sample-export') {
          const format = ['md', 'html', 'json'].includes(url.searchParams.get('format')) ? url.searchParams.get('format') : 'md';
          const fileMap = { md: '小贸-进口成本案例-示例.md', html: '小贸-进口成本案例-示例.html', json: '小贸-进口成本案例-示例.json' };
          return serveFile(res, path.join(PROJECT_ROOT, 'samples', fileMap[format]), commonHeaders);
        }
        if (url.pathname.startsWith('/samples/')) {
          const name = path.basename(url.pathname);
          if (!/\.(md|html|json)$/.test(name)) return json(res, 404, { ok: false, message: '没有这个文件' });
          return serveFile(res, path.join(PROJECT_ROOT, 'samples', name), commonHeaders);
        }
        // 同目录静态文件（仅供页面资源与本地自检使用，禁止路径穿越）
        const base = path.basename(url.pathname);
        if (/^[A-Za-z0-9._-]+$/.test(base) && MIME[path.extname(base).toLowerCase()]) {
          const candidate = path.join(PUBLIC_DIR, base);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return serveFile(res, candidate, commonHeaders);
        }
        return json(res, 404, { ok: false, code: 'not_found', message: '没有这个入口' });
      }

      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed', message: '只支持 GET/POST' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { ok: false, code: 'content_type', message: '请使用 application/json' });

      if (url.pathname === '/api/turn') {
        const body = await readJson(req);
        const textInput = typeof body.text === 'string' ? body.text.trim() : '';
        if (!textInput) return json(res, 400, { ok: false, code: 'empty_text', message: '请输入内容' });
        if (textInput.length > 500) return json(res, 400, { ok: false, code: 'text_too_long', message: '请使用 500 字以内的输入' });
        const sessionId = sanitizeSession(body.sessionId);
        const incoming = body.state && typeof body.state === 'object' ? body.state : S.createState();
        const started = process.hrtime.bigint();
        const result = await handleTurn({ text: textInput, state: incoming, sessionId, model, now: now() });
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        const response = { ok: true, ...result, serverTime: new Date(now()).toISOString() };
        appendAudit(sessionId, {
          ts: new Date(now()).toISOString(),
          sessionId,
          turnId: result.turnId,
          input: textInput,
          answer: result.answer,
          phase: result.phase,
          stateVersion: result.state?.version,
          toolCalls: result.toolCalls,
          audit: result.audit,
          durationMs: Math.round(durationMs * 1000) / 1000
        });
        return json(res, 200, response);
      }

      if (url.pathname === '/api/reset') {
        const body = await readJson(req).catch(() => ({}));
        const sessionId = sanitizeSession(body.sessionId);
        const state = S.createState(now());
        appendAudit(sessionId, { ts: new Date(now()).toISOString(), sessionId, type: 'reset', stateVersion: state.version });
        return json(res, 200, { ok: true, state });
      }

      return json(res, 404, { ok: false, code: 'not_found', message: '没有这个入口' });
    } catch (err) {
      const code = err?.code || 'server_error';
      const status = code === 'body_too_large' ? 413 : 400;
      try { fs.appendFileSync(path.join(RUNS_DIR, 'server-errors.log'), `${new Date().toISOString()} ${code} ${err.message}\n`); } catch { /* 忽略 */ }
      return json(res, status, { ok: false, code, message: code === 'body_too_large' ? '请求体过大' : '请求未完成，请重试' });
    }
  });
}

function parseArgs(argv) {
  const envPort = Number(process.env.TRADE_DEMO_PORT || 18866);
  const args = { port: Number.isFinite(envPort) ? envPort : 18866 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) {
      const p = Number(argv[i + 1]);
      if (Number.isInteger(p) && p > 1024 && p < 65536) args.port = p;
      i += 1;
    }
  }
  return args;
}

if (require.main === module) {
  ensureDirs();
  const { port } = parseArgs(process.argv.slice(2));
  const useRealModel = process.env.TRADE_DEMO_USE_REAL_MODEL === '1';
  const model = fromEnv(process.env, { allowDeepSeek: useRealModel });
  if (!model && process.env.DEEPSEEK_API_KEY) console.log('检测到 DEEPSEEK_API_KEY；当前为模拟模式。设置 TRADE_DEMO_USE_REAL_MODEL=1 可启用真实模型（需可用余额）。');
  const server = createServer({ port, model });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用。请用 --port 指定一个空闲端口，例如：node src/server.cjs --port 18867`);
    } else {
      console.error(`服务启动失败：${err.message}`);
    }
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    try { fs.writeFileSync(path.join(RUNS_DIR, `server-${port}.pid`), String(process.pid), 'utf8'); } catch { /* 忽略 */ }
    console.log(`小贸经贸演示已启动：http://127.0.0.1:${port}`);
    console.log(`模型：${model ? model.name + '（' + (model.mode === 'deepseek' ? 'DeepSeek 真实模型' : '真实模型') + '，仅参数提案）' : '模拟模型 rules-v1（离线可复现）'}`);
    console.log(`固定教学案例：${C.CASE_ID}`);
    console.log('按 Ctrl+C 停止。');
  });
  const stop = () => server.close(() => {
    try { fs.rmSync(path.join(RUNS_DIR, `server-${port}.pid`), { force: true }); } catch { /* 忽略 */ }
    process.exit(0);
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer, sanitizeSession };
