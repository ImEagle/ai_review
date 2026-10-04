'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const gitlib = require('./git');
const state = require('./state');
const { formatFeedback } = require('./feedback');

const UI_DIR = path.join(__dirname, '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 20 * 1024 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Creates the review server. `onDone(result)` is called once, when the reviewer
 * submits or cancels: result = { status: 'submitted'|'cancelled', review, markdown }.
 */
function createReviewServer({ root, gitDir, initialScope = 'working', hook = false, onDone }) {
  const token = crypto.randomBytes(16).toString('hex');
  let done = false;
  let port = 0;

  const finish = (result) => {
    if (done) return;
    done = true;
    onDone(result);
  };

  const api = {
    'GET /api/meta': () => ({
      repo: path.basename(root),
      root,
      hook,
      initialScope,
      ...gitlib.getScopes(root),
      draft: state.readDraft(gitDir),
      previous: state.lastHistory(gitDir),
    }),
    'GET /api/diff': (_req, url) => gitlib.getDiff(root, url.searchParams.get('scope') || 'working', { context: url.searchParams.get('context') || 3 }),
    'PUT /api/draft': async (req) => {
      state.writeDraft(gitDir, await readBody(req));
      return { ok: true };
    },
    'POST /api/submit': async (req) => {
      const body = await readBody(req);
      const scope = body.scope || initialScope;
      const review = {
        submittedAt: new Date().toISOString(),
        scope,
        verdict: body.verdict || 'comment',
        general: body.general || '',
        comments: Array.isArray(body.comments) ? body.comments : [],
      };
      const markdown = formatFeedback(review, { scopeLabel: gitlib.scopeLabel(root, scope) });
      state.saveHistory(gitDir, { ...review, markdown });
      state.clearDraft(gitDir);
      setImmediate(() => finish({ status: 'submitted', review, markdown }));
      return { ok: true };
    },
    'POST /api/cancel': () => {
      setImmediate(() => finish({ status: 'cancelled' }));
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      // Only answer requests addressed to our own loopback origin (DNS rebinding guard).
      const host = req.headers.host || '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'forbidden host' });

      const url = new URL(req.url, `http://${host}`);
      const st = req.method === 'GET' && STATIC[url.pathname];
      if (st) {
        return send(res, 200, fs.readFileSync(path.join(UI_DIR, st[0])), st[1]);
      }

      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'not found' });
      if (req.headers['x-review-token'] !== token) return send(res, 403, { error: 'bad token' });
      if (done) return send(res, 410, { error: 'review already finished' });
      send(res, 200, await handler(req, url));
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  return {
    server,
    token,
    listen(wantPort = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantPort, '127.0.0.1', () => {
          port = server.address().port;
          resolve(`http://127.0.0.1:${port}/?t=${token}`);
        });
      });
    },
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

module.exports = { createReviewServer };
