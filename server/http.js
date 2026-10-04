'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const gitlib = require('./git');
const state = require('./state');
const { formatFeedback } = require('./feedback');
const { ReviewerStore, InputError, agentPrompt } = require('./reviewers');

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
 *
 * Two audiences, two tokens:
 *   /api/*        – the browser UI (X-Review-Token, or ?t= for the SSE stream)
 *   /agent-api/*  – agent reviewers via agent.js (X-Agent-Token); they can read the
 *                   diff, comment and give a verdict, but never submit or accept/reject.
 */
function createReviewServer({ root, gitDir, initialScope = 'working', hook = false, onDone }) {
  const token = crypto.randomBytes(16).toString('hex');
  const agentToken = crypto.randomBytes(16).toString('hex');
  let done = false;
  let port = 0;
  const sseClients = new Set();

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  const store = new ReviewerStore({ root, gitDir, scope: initialScope, onChange: (snap) => broadcast('agents', snap) });

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
      agentPrompt: agentPrompt(root),
      agents: store.snapshot(),
    }),
    'GET /api/diff': (_req, url) => gitlib.getDiff(root, url.searchParams.get('scope') || 'working', { context: url.searchParams.get('context') || 3 }),
    'GET /api/agents': () => store.snapshot(),
    'PUT /api/draft': async (req) => {
      state.writeDraft(gitDir, await readBody(req));
      return { ok: true };
    },
    'POST /api/agent-comments/bulk': async (req) => {
      const { author, status } = await readBody(req);
      store.bulk(author, status);
      return store.snapshot();
    },
    'POST /api/agent-comments/:id': async (req, _url, id) => {
      store.setStatus(id, (await readBody(req)).status);
      return store.snapshot();
    },
    'POST /api/reviewers/:name': async (req, _url, name) => {
      store.setSummaryStatus(name, (await readBody(req)).summaryStatus);
      return store.snapshot();
    },
    'POST /api/submit': async (req) => {
      const body = await readBody(req);
      const scope = body.scope || initialScope;
      const userComments = (Array.isArray(body.comments) ? body.comments : []).map((c) => ({ ...c, author: null }));
      const agentComments = store.commentsFor();
      const reviewers = store.snapshot().reviewers;
      // Everything the user didn't explicitly reject goes to the implementing agent.
      const review = {
        submittedAt: new Date().toISOString(),
        scope,
        verdict: body.verdict || 'comment',
        general: body.general || '',
        comments: [...userComments, ...store.sendable()],
        reviewers: reviewers.map((r) => (r.summaryStatus === 'rejected' ? { ...r, summary: '' } : r)),
      };
      const markdown = formatFeedback(review, { scopeLabel: gitlib.scopeLabel(root, scope) });
      state.saveHistory(gitDir, { ...review, allAgentComments: agentComments, allReviewers: reviewers, markdown });
      state.clearDraft(gitDir);
      store.clear();
      setImmediate(() => finish({ status: 'submitted', review, markdown }));
      return { ok: true };
    },
    'POST /api/cancel': () => {
      setImmediate(() => finish({ status: 'cancelled' }));
      return { ok: true };
    },
  };

  const agentApi = {
    'GET /agent-api/info': () => ({ root, scope: initialScope, reviewers: store.snapshot().reviewers }),
    'GET /agent-api/diff': (_req, url) =>
      gitlib.getDiff(root, url.searchParams.get('scope') || initialScope, { context: url.searchParams.get('context') || 3 }),
    'POST /agent-api/join': async (req) => store.join((await readBody(req)).name),
    'POST /agent-api/comment': async (req) => {
      const b = await readBody(req);
      return store.addComment(b.name, b);
    },
    'POST /agent-api/reply': async (req) => {
      const b = await readBody(req);
      return store.addReply(b.name, b.to, b.body, b.stance);
    },
    'POST /agent-api/finish': async (req) => {
      const b = await readBody(req);
      return store.finish(b.name, b.verdict, b.summary);
    },
    'GET /agent-api/comments': (_req, url) => {
      const name = url.searchParams.get('name');
      return store.commentsFor(url.searchParams.get('all') ? null : name);
    },
  };

  // Route lookup with one optional ":param" segment at the end.
  const route = (table, method, pathname) => {
    if (table[`${method} ${pathname}`]) return [table[`${method} ${pathname}`]];
    for (const key of Object.keys(table)) {
      const m = /^(\S+) (.*)\/:\w+$/.exec(key);
      if (m && m[1] === method && pathname.startsWith(m[2] + '/')) {
        const param = pathname.slice(m[2].length + 1);
        if (param && !param.includes('/')) return [table[key], decodeURIComponent(param)];
      }
    }
    return null;
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

      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (url.searchParams.get('t') !== token) return send(res, 403, { error: 'bad token' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: agents\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }

      const isAgent = url.pathname.startsWith('/agent-api/');
      const found = route(isAgent ? agentApi : api, req.method, url.pathname);
      if (!found) return send(res, 404, { error: 'not found' });
      const expected = isAgent ? agentToken : token;
      const given = isAgent ? req.headers['x-agent-token'] : req.headers['x-review-token'];
      if (given !== expected) return send(res, 403, { error: 'bad token' });
      if (done) return send(res, 410, { error: 'This review has already been submitted or closed.' });
      send(res, 200, await found[0](req, url, found[1]));
    } catch (err) {
      send(res, err instanceof InputError ? 400 : 500, { error: err.message });
    }
  });

  return {
    server,
    token,
    agentToken,
    listen(wantPort = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantPort, '127.0.0.1', () => {
          port = server.address().port;
          state.writeSession(gitDir, { port, agentToken, scope: initialScope, pid: process.pid, startedAt: new Date().toISOString() });
          resolve(`http://127.0.0.1:${port}/?t=${token}`);
        });
      });
    },
    close() {
      state.clearSession(gitDir);
      for (const res of sseClients) res.end();
      server.closeAllConnections?.();
      server.close();
    },
  };
}

module.exports = { createReviewServer };
