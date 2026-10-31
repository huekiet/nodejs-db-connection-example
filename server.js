import express from 'express';
import { pool, dbConfig, Client } from './src/db.js';
import {
  registry, startPoolCollector, poolErrors, queryDuration, httpDuration, httpTotal,
} from './src/metrics.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3101);
const REPLICA = process.env.APP_NAME ?? `r-${PORT}`;
const LEAK_MAX = Number(process.env.LEAK_MAX ?? 30);

startPoolCollector(pool, REPLICA);

const stats = () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(err) {
  const msg = err?.message ?? '';
  if (err?.code === '53300') return 'too_many_clients';
  if (err?.code === '57P03') return 'cannot_connect_now';
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET') return 'connect_refused';
  if (err?.code === 'ETIMEDOUT' || /timeout exceeded when trying to connect/i.test(msg)) return 'pool_acquire_timeout';
  return 'query';
}

app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ?? req.path;
    const status = String(res.statusCode);
    httpDuration.observe({ route, status }, seconds);
    httpTotal.inc({ route, status });
    console.log(
      `${REPLICA} ${req.method} ${req.originalUrl} ${status} ${(seconds * 1000).toFixed(1)}ms` +
      (res.locals.reason ? ` reason=${res.locals.reason}` : '')
    );
  });
  next();
});

app.get('/fast', async (req, res) => {
  const end = queryDuration.startTimer({ op: 'fast' });
  await pool.query('select 1');
  end();
  res.json({ ok: true, pool: stats() });
});

app.get('/slow', async (req, res) => {
  const ms = clamp(Number(req.query.ms ?? 1000), 1, 30000);
  const end = queryDuration.startTimer({ op: 'slow' });
  await pool.query('select pg_sleep($1::int / 1000.0)', [ms]);
  end();
  res.json({ ok: true, ms, pool: stats() });
});

// occupies a pool slot for N ms while the DB does almost nothing
// (shape of a request awaiting an external API, or a slow consumer)
app.get('/hold', async (req, res) => {
  const ms = clamp(Number(req.query.ms ?? 1000), 1, 30000);
  const client = await pool.connect();
  try {
    await client.query('select 1');
    const end = queryDuration.startTimer({ op: 'hold' });
    await sleep(ms);
    end();
    res.json({ ok: true, ms, pool: stats() });
  } finally {
    client.release();
  }
});

app.get('/tx', async (req, res) => {
  const ms = clamp(Number(req.query.ms ?? 1000), 1, 10000);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_sleep($1::int / 1000.0)', [ms]);
    await client.query('rollback');
    res.json({ ok: true, ms, pool: stats() });
  } finally {
    client.release();
  }
});

// correct but wasteful: TCP + auth per request
app.get('/churn', async (req, res) => {
  const client = new Client({ ...dbConfig, application_name: `${REPLICA}-churn` });
  const end = queryDuration.startTimer({ op: 'churn' });
  try {
    await client.connect();
    await client.query('select 1');
    res.json({ ok: true });
  } finally {
    end();
    await client.end().catch(() => {});
  }
});

// the bug: a raw Client that is never closed — bypasses the pool entirely
const leaked = [];
app.get('/leak', async (req, res) => {
  if (leaked.length >= LEAK_MAX) {
    return res.status(503).json({ error: 'leak cap reached', leaked: leaked.length });
  }
  const client = new Client({ ...dbConfig, application_name: `${REPLICA}-leak` });
  await client.connect();
  leaked.push(client);
  res.json({ ok: true, leaked: leaked.length, pool: stats() });
});

app.get('/leak/reset', async (req, res) => {
  const n = leaked.length;
  for (const client of leaked.splice(0)) await client.end().catch(() => {});
  res.json({ released: n });
});

app.get('/health', (req, res) => {
  res.json({
    replica: REPLICA, port: PORT, pid: process.pid,
    pool: stats(), leaked: leaked.length,
    db: { host: dbConfig.host, port: dbConfig.port },
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.use((err, req, res, next) => {
  const reason = classify(err);
  poolErrors.inc({ reason });
  res.locals.reason = reason;
  if (!res.headersSent) {
    res.status(503).json({ error: err.message, code: err.code ?? null, reason });
  }
});

process.on('SIGINT', async () => { await pool.end().catch(() => {}); process.exit(0); });

app.listen(PORT, '0.0.0.0', () => console.log(`${REPLICA} listening on :${PORT} -> ${dbConfig.host}:${dbConfig.port}`));
