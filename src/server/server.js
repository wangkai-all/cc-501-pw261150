import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, closeDb } from '../db/database.js';
import { createPlan, listPlans } from '../services/plans.js';
import {
  createSubscription,
  listSubscriptions,
  recordEvent,
  getSubscription,
} from '../services/subscriptions.js';
import { runBilling, listInvoices, getInvoice } from '../services/billing.js';
import {
  requestCorrection,
  listCorrections,
  getCorrection,
  recoverPendingCorrections,
  diffInvoices,
  injectApplyFault,
} from '../services/corrections.js';
import { createRefund, listRefunds } from '../services/refunds.js';
import { ingestWebhook, listWebhookEvents } from '../services/webhooks.js';
import { deliverPending, listNotifications } from '../services/notifications.js';
import { listAudit } from '../services/audit.js';
import {
  subscriptionTimeline,
  billingAnalysis,
  correctionDetail,
  overview,
} from '../services/queries.js';
import { localDateToUtc } from '../shared/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(Object.assign(new Error('payload too large'), { status: 413 }));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Route table. Every handler receives (db, params, body, req). Keeping the
 * table declarative makes the API surface auditable in one place.
 */
const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, time: new Date().toISOString() })],
  ['GET', /^\/api\/overview$/, (db) => overview(db)],

  ['GET', /^\/api\/plans$/, (db) => listPlans(db)],
  ['POST', /^\/api\/plans$/, (db, _p, body) => createPlan(db, body)],

  ['GET', /^\/api\/subscriptions$/, (db) => listSubscriptions(db)],
  ['POST', /^\/api\/subscriptions$/, (db, _p, body) => createSubscription(db, body)],
  ['GET', /^\/api\/subscriptions\/([\w-]+)$/, (db, [id]) => {
    const sub = getSubscription(db, id);
    if (!sub) throw Object.assign(new Error('subscription not found'), { status: 404 });
    return sub;
  }],
  [
    'POST',
    /^\/api\/subscriptions\/([\w-]+)\/events$/,
    (db, [id], body) => recordEvent(db, id, body),
  ],
  ['GET', /^\/api\/subscriptions\/([\w-]+)\/timeline$/, (db, [id]) => subscriptionTimeline(db, id)],
  ['GET', /^\/api\/subscriptions\/([\w-]+)\/analysis$/, (db, [id], _b, req) => {
    const asOf = new URL(req.url, 'http://x').searchParams.get('asOf');
    return billingAnalysis(db, id, {
      asOfUtc: asOf ? new Date(asOf).getTime() : Date.now(),
    });
  }],

  ['POST', /^\/api\/billing\/run$/, (db, _p, body) => runBilling(db, {
    asOfUtc: body?.asOf ? new Date(body.asOf).getTime() : Date.now(),
    subscriptionId: body?.subscriptionId || null,
  })],
  ['GET', /^\/api\/subscriptions\/([\w-]+)\/invoices$/, (db, [id]) => listInvoices(db, id)],
  ['GET', /^\/api\/invoices\/([\w-]+)$/, (db, [id]) => {
    const inv = getInvoice(db, id);
    if (!inv) throw Object.assign(new Error('invoice not found'), { status: 404 });
    return inv;
  }],
  ['GET', /^\/api\/invoices\/([\w-]+)\/diff\/([\w-]+)$/, (db, [oldId, newId]) =>
    diffInvoices(db, oldId, newId)],

  ['POST', /^\/api\/subscriptions\/([\w-]+)\/corrections$/, (db, [id], body) =>
    requestCorrection(db, id, body.triggerEventId, { reason: body.reason }),
  ],
  ['GET', /^\/api\/corrections$/, (db) => listCorrections(db)],
  ['GET', /^\/api\/subscriptions\/([\w-]+)\/corrections$/, (db, [id]) => listCorrections(db, id)],
  ['GET', /^\/api\/corrections\/([\w-]+)$/, (db, [id]) => correctionDetail(db, id)],
  ['POST', /^\/api\/corrections\/recover$/, (db) => recoverPendingCorrections(db)],
  ['POST', /^\/api\/test\/inject-fault$/, () => {
    injectApplyFault();
    return { injected: true };
  }],

  ['POST', /^\/api\/subscriptions\/([\w-]+)\/refunds$/, (db, [id], body) =>
    createRefund(db, { ...body, subscriptionId: id })],
  ['GET', /^\/api\/refunds$/, (db) => listRefunds(db)],
  ['GET', /^\/api\/subscriptions\/([\w-]+)\/refunds$/, (db, [id]) => listRefunds(db, id)],

  ['POST', /^\/api\/webhooks$/, (db, _p, body) => ingestWebhook(db, body)],
  ['GET', /^\/api\/webhooks$/, (db) => listWebhookEvents(db)],

  ['POST', /^\/api\/notifications\/deliver$/, (db) => deliverPending(db)],
  ['GET', /^\/api\/notifications$/, (db) => listNotifications(db, {})],

  ['GET', /^\/api\/audit$/, (db, _p, _b, req) => {
    const u = new URL(req.url, 'http://x');
    return listAudit(db, {
      entityType: u.searchParams.get('entityType') || undefined,
      entityId: u.searchParams.get('entityId') || undefined,
      limit: Number(u.searchParams.get('limit') || 200),
    });
  }],
];

async function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://x').pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

export function createApp(db = getDb()) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res);

      const body = req.method === 'POST' ? await readBody(req) : {};
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = url.pathname.match(pattern);
        if (!match) continue;
        const result = handler(db, match.slice(1), body, req);
        return send(res, 200, result);
      }
      send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      const status = err.status || 500;
      send(res, status, {
        error: String(err.message || err),
        code: err.code || null,
      });
    }
  });
  return { server, db };
}

export function startServer(port = Number(process.env.PORT || 3000)) {
  const { server, db } = createApp();
  // Self-heal any correction that was reserved but not applied (crash or
  // injected failure). Applied corrections are left untouched, so this is safe
  // to run on every boot and under multi-instance deploys.
  try {
    const recovered = recoverPendingCorrections(db);
    if (recovered.length) console.log('startup recovery finished corrections:', recovered);
  } catch (err) {
    console.error('startup recovery failed (will retry on next boot):', err.message);
  }
  server.listen(port, () => {
    console.log(`billing service listening on http://localhost:${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      closeDb(db);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

export { localDateToUtc };

// Entry point when run directly (`npm start`); tests import createApp instead.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startServer();
}
