# Postgres connection-pool exhaustion lab (Node.js + k6, PgBouncer as the fix)

> Status: plan / runbook, not implemented yet. Nothing in the repo has been modified.

Repo: `D:\workspace\study\BE\nodejs-db-connection-example` (Express 5, ESM).
Goal: reproduce Postgres connection exhaustion from a Node.js `pg.Pool`, measure it with **Grafana k6**,
then show the same load succeeding through **PgBouncer** (transaction pooling). Grafana dashboards come last;
all earlier phases are verified from the terminal.

## Photo of this machine (checked, not assumed)

| Finding | Impact |
| --- | --- |
| Docker **not installed** (no `docker.exe`, no Docker Desktop, no WSL distro, no service) | Step 0 installs it. |
| Postgres **18** installed and running: service `postgresql-x64-18`, listening on **5432**, data dir `D:\Program Files\PostgreSQL\18\data` | Container Postgres uses **5433**; never touch the local cluster. |
| `psql` not on PATH; exists at `D:\Program Files\PostgreSQL\18\bin\psql.exe` | Only needed for ad-hoc checks; containers have `psql`. |
| Node v22.22.0; `winget`, `choco` available; no k6/Grafana/Prometheus/PgBouncer | k6 + observability run as containers. |

## The four layers, and which limit each one has

```
k6 VUs --HTTP keep-alive--> Node/Express --pg.Pool--> PgBouncer :6432 --> Postgres :5432
   |                              |                        |                    |
 VUs, arrival rate,        pool.max,              default_pool_size,    max_connections=25
 noVUConnectionReuse       connectionTimeout      max_client_conn=500   (22 usable for demo)
```

Core lesson: **`max_connections` is a global server budget; a pool is per-process.**
Pools do not divide capacity, they multiply: `pool.max × replicas`. A DB connection is a forked OS
process (~5–10 MB) plus auth/TLS setup. A pooler makes the DB-side count a single deliberate number
instead of a function of how many app instances you happened to deploy.

Port map: Postgres **5433**, PgBouncer **6432**, postgres_exporter 9187, pgbouncer_exporter 9127,
Prometheus **9090**, Grafana **3001**, app replicas **3101–3103**.

---

## Step 0 — Install Docker Desktop (one time, ~15 min + possible reboot)

```powershell
# admin PowerShell
wsl --install -d Ubuntu
# reboot if prompted, then:
winget install -e --id Docker.DockerDesktop
```

Start Docker Desktop, wait for "Engine running", then:

```powershell
docker version
docker run --rm hello-world
```

Checkpoint: `Server: Docker Engine` version printed; hello-world exits 0.

---

## Step 1 — Infra files (no app code yet)

### `docker-compose.yml`

```yaml
name: pg-pool-lab

services:
  postgres:
    image: postgres:16-alpine
    command:
      - postgres
      - -c
      - max_connections=25
      - -c
      - superuser_reserved_connections=3
      - -c
      - log_connections=on
      - -c
      - log_disconnections=on
      - -c
      - idle_in_transaction_session_timeout=15s
      - -c
      - password_encryption=md5
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
      POSTGRES_HOST_AUTH_METHOD: md5
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/10-init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d app"]
      interval: 3s
      timeout: 3s
      retries: 20

  pgbouncer:
    image: edoburu/pgbouncer:latest
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "6432:6432"
    volumes:
      - ./docker/pgbouncer/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./docker/pgbouncer/userlist.txt:/etc/pgbouncer/userlist.txt:ro

  postgres-exporter:
    image: prometheuscommunity/postgres-exporter:latest
    profiles: ["obs"]
    environment:
      DATA_SOURCE_NAME: "postgresql://postgres:postgres@postgres:5432/app?sslmode=disable"
    ports:
      - "9187:9187"

  pgbouncer-exporter:
    image: prometheuscommunity/pgbouncer-exporter:latest
    profiles: ["obs"]
    depends_on:
      - pgbouncer
    environment:
      PGBOUNCER_EXPORTER_CONNECTION_STRING: "postgres://demo:demo@pgbouncer:6432/pgbouncer?sslmode=disable"
    ports:
      - "9127:9127"

  prometheus:
    image: prom/prometheus:latest
    profiles: ["obs"]
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=2d
      - --web.enable-remote-write-receiver
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:latest
    profiles: ["obs"]
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
      GF_USERS_ALLOW_SIGN_UP: "false"
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./docker/grafana/dashboards:/var/lib/grafana/dashboards:ro
    ports:
      - "3001:3000"

volumes:
  pgdata:
```

### `docker/postgres/init.sql`

```sql
SET password_encryption = 'md5';

CREATE ROLE demo LOGIN PASSWORD 'demo';
GRANT CONNECT ON DATABASE app TO demo;
GRANT USAGE, CREATE ON SCHEMA public TO demo;

CREATE TABLE IF NOT EXISTS items (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE items OWNER TO demo;
INSERT INTO items (name) SELECT 'item-' || g FROM generate_series(1, 10000) g;
```

`demo` is deliberately **not** a superuser, so `superuser_reserved_connections=3` really is unavailable to
the app: usable budget = 25 − 3 = **22**.

### `docker/pgbouncer/userlist.txt`

```
"demo" "md5c514c91e4ed341f263e458d44b3bb0a7"
```

That is `md5('demo' + 'demo')` — md5 auth requires `md5(password + username)`, and the Postgres role
must store an md5 hash (hence `password_encryption=md5` + the `ALTER` in `init.sql`).

### `docker/pgbouncer/pgbouncer.ini`

```ini
[databases]
app = host=postgres port=5432 dbname=app

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 10
min_pool_size = 0
reserve_pool_size = 5
reserve_pool_timeout = 3
max_client_conn = 500
max_db_connections = 10
query_wait_timeout = 5
server_idle_timeout = 60
admin_users = demo
stats_users = demo
ignore_startup_parameters = extra_float_digits
log_connections = 1
log_disconnections = 1
```

### Bring up + verify (terminal only)

```powershell
docker compose up -d
docker compose ps
docker compose exec -T postgres psql -U postgres -d app -c "show max_connections;"
docker compose exec -T postgres psql -U postgres -d app -c "select rolname, rolsuper from pg_roles where rolname in ('postgres','demo');"
docker compose exec -T postgres psql -U postgres -d app -c "select count(*) from items;"
docker compose exec -T -e PGPASSWORD=demo postgres psql -h pgbouncer -p 6432 -U demo -d app -c "select 1 as via_pgbouncer;"
```

Checkpoint: `25` · `demo | f` · `10000` · PgBouncer returns `1`.

If PgBouncer auth fails, the md5 pair is the suspect:

```powershell
docker compose exec -T postgres psql -U postgres -d app -c "select rolname, left(rolpassword,3) from pg_authid where rolname='demo';"   # must be md5
```

---

## Step 2 — App (index.js untouched)

```powershell
npm i pg prom-client
```

Add to `package.json`: `"start": "node server.js"`.

### `src/db.js`

```js
import pg from 'pg';

const { Pool, Client } = pg;

export { Client };

export const dbConfig = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? 'demo',
  password: process.env.DB_PASSWORD ?? 'demo',
  database: process.env.DB_NAME ?? 'app',
};

export const pool = new Pool({
  ...dbConfig,
  max: Number(process.env.POOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.POOL_IDLE_MS ?? 10000),
  connectionTimeoutMillis: Number(process.env.POOL_CONNECT_TIMEOUT_MS ?? 5000),
  application_name: process.env.APP_NAME ?? `demo-${process.env.PORT ?? 3101}`,
});

pool.on('error', (err) => console.error(`[pool] idle client error: ${err.message}`));
```

### `src/metrics.js`

```js
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'node_' });

export const poolTotal = new client.Gauge({
  name: 'db_pool_total', help: 'clients in pool (in use + idle)',
  labelNames: ['replica'], registers: [registry],
});
export const poolIdle = new client.Gauge({
  name: 'db_pool_idle', help: 'idle clients in pool',
  labelNames: ['replica'], registers: [registry],
});
export const poolWaiting = new client.Gauge({
  name: 'db_pool_waiting', help: 'acquire() calls waiting',
  labelNames: ['replica'], registers: [registry],
});

export const queryDuration = new client.Histogram({
  name: 'pg_query_duration_seconds', help: 'db operation duration', labelNames: ['op'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 3, 5, 10, 30], registers: [registry],
});

export const poolErrors = new client.Counter({
  name: 'pg_pool_errors_total', help: 'db errors by reason',
  labelNames: ['reason'], registers: [registry],
});

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'http duration', labelNames: ['route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 3, 5, 10, 30], registers: [registry],
});

export const httpTotal = new client.Counter({
  name: 'http_requests_total', help: 'http requests',
  labelNames: ['route', 'status'], registers: [registry],
});

export function startPoolCollector(pool, replica) {
  const labels = { replica };
  const tick = () => {
    poolTotal.set(labels, pool.totalCount);
    poolIdle.set(labels, pool.idleCount);
    poolWaiting.set(labels, pool.waitingCount);
  };
  tick();
  const timer = setInterval(tick, 1000);
  timer.unref();
  return timer;
}
```

### `server.js`

```js
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
```

### Run one replica

```powershell
# terminal A
$env:PORT=3101; $env:APP_NAME='r1'; $env:POOL_MAX=10; $env:DB_PORT=5433; node server.js

# terminal B
curl.exe -s http://localhost:3101/health
curl.exe -s "http://localhost:3101/slow?ms=500"
docker compose exec -T postgres psql -U postgres -d app -c "select state, count(*) from pg_stat_activity where datname='app' group by 1;"
```

Checkpoint: `/health` shows `"total":1`; `pg_stat_activity` shows `idle | 1`. Idle pool members are real
DB processes — that is the first lesson.

---

## Step 3 — k6 baseline (terminal only)

### `load/k6/baseline.js`

```js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3101';

export const options = {
  scenarios: { steady: { executor: 'constant-vus', vus: 10, duration: '30s' } },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(95)<100'],
  },
};

export default function () {
  const res = http.get(`${BASE}/fast`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}
```

```powershell
docker run --rm -i -v "${PWD}/load/k6:/scripts:ro" `
  -e BASE_URL=http://host.docker.internal:3101 `
  grafana/k6 run /scripts/baseline.js
```

Expect: `http_reqs ≈ 2,700–3,000`, `http_req_failed 0.00%`, `p(95) ≈ 5–20 ms`, thresholds green, exit 0.
DB: `idle | 10`. Record these numbers — they are the yardstick.

---

## Step 4 — Queue inside the app pool (still healthy)

### `load/k6/slow.js`

```js
import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3101';

export const options = {
  scenarios: {
    arrive: {
      executor: 'ramping-arrival-rate',
      startRate: 10, timeUnit: '1s',
      preAllocatedVUs: 100, maxVUs: 400,
      stages: [
        { target: 20, duration: '20s' },
        { target: 100, duration: '60s' },
        { target: 100, duration: '20s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<5000'],
  },
};

export default function () {
  http.get(`${BASE}/slow?ms=300`);
}
```

```powershell
docker run --rm -i -v "${PWD}/load/k6:/scripts:ro" `
  -e BASE_URL=http://host.docker.internal:3101 `
  grafana/k6 run /scripts/slow.js
```

Expect at 20 rps: all 200, `p(95) ≈ 350–450 ms`, small `db_pool_waiting`.
At 100 rps: capacity is `10 conns / 0.3 s ≈ 33 rps`, so `http_req_failed` climbs to 60–80 %,
`p(95) ≈ 5000 ms` (`connectionTimeoutMillis`), threshold fails (exit 99) — **but** `pg_stat_activity`
stays at `active | 10` and Postgres CPU stays low.

Lesson: a bounded pool degrades the app, not the database. The terminal shows
`reason=pool_acquire_timeout`, never `too_many_clients`.

---

## Step 5 — Break it: per-process pools × replicas > global budget

Stop terminal A. Start 3 replicas with an oversized pool (120 potential connections vs 22 usable):

```powershell
# three separate terminals
$env:PORT=3101; $env:APP_NAME='r1'; $env:POOL_MAX=40; $env:DB_PORT=5433; node server.js
$env:PORT=3102; $env:APP_NAME='r2'; $env:POOL_MAX=40; $env:DB_PORT=5433; node server.js
$env:PORT=3103; $env:APP_NAME='r3'; $env:POOL_MAX=40; $env:DB_PORT=5433; node server.js
```

### `load/k6/exhaust.js` (reused unchanged in Step 7)

```js
import http from 'k6/http';
import { check } from 'k6';

const URLS = (__ENV.BASE_URLS || 'http://host.docker.internal:3101').split(',');

export const options = {
  scenarios: { pin: { executor: 'constant-vus', vus: 120, duration: '60s' } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const base = URLS[(__VU - 1) % URLS.length];
  const res = http.get(`${base}/hold?ms=1000`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
```

```powershell
docker run --rm -i -v "${PWD}/load/k6:/scripts:ro" `
  -e BASE_URLS=http://host.docker.internal:3101,http://host.docker.internal:3102,http://host.docker.internal:3103 `
  grafana/k6 run /scripts/exhaust.js
```

Expect: `http_req_failed` **70–90 %**, threshold failure (exit 99), bodies like
`{"code":"53300","reason":"too_many_clients","error":"sorry, too many clients already"}`.

```powershell
docker compose exec -T postgres psql -U postgres -d app -c "select count(*) as backends from pg_stat_activity where datname='app';"   # 22
docker compose logs --since 2m postgres | Select-String "FATAL"
```

Lesson: 40 × 3 planned connections against a 22-slot budget starves every other service on that
Postgres, and replica #4 makes it worse. `/fast` fails too — the budget is shared, not per app.

Reset before the next phase:

```powershell
docker compose restart postgres
# Ctrl+C all three node terminals, then restart them
```

---

## Step 6 — Churn and leak

### `load/k6/churn.js`

```js
import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3101';

export const options = {
  scenarios: {
    churn: {
      executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s',
      duration: '60s', preAllocatedVUs: 50, maxVUs: 150,
    },
  },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
};

export default function () {
  http.get(`${BASE}/churn`);
}
```

```powershell
docker run --rm -i -v "${PWD}/load/k6:/scripts:ro" `
  -e BASE_URL=http://host.docker.internal:3101 `
  grafana/k6 run /scripts/churn.js
```

Expect: 50 req/s → 50 TCP handshakes + 50 auth round-trips/s. `p(95)` ≈ 10–30 ms for a `SELECT 1`
(vs 2 ms on the pooled path) and the Postgres log fills with connect/disconnect lines.
Functionally correct, financially wrong.

Leak (single replica, `POOL_MAX=10`):

```powershell
1..25 | ForEach-Object { curl.exe -s "http://localhost:3101/leak"; "" }
docker compose exec -T postgres psql -U postgres -d app -c "select application_name, state, count(*) from pg_stat_activity where datname='app' group by 1,2;"
```

Expect: backends climb past `POOL_MAX` (the leak bypasses the pool) to 22, then `/leak` and `/fast`
return `53300`. `curl.exe -s http://localhost:3101/leak/reset` returns them.

Lesson: the pool bounds leaks only if code goes through it; `idle_in_transaction_session_timeout` is the
DB-side seatbelt.

---

## Step 7 — The same script through PgBouncer

Stop the 3 replicas and restart them pointed at **6432**:

```powershell
$env:PORT=3101; $env:APP_NAME='r1'; $env:POOL_MAX=40; $env:DB_PORT=6432; node server.js
$env:PORT=3102; $env:APP_NAME='r2'; $env:POOL_MAX=40; $env:DB_PORT=6432; node server.js
$env:PORT=3103; $env:APP_NAME='r3'; $env:POOL_MAX=40; $env:DB_PORT=6432; node server.js
```

Re-run the exact Step 5 command (same `exhaust.js`, same 120 VUs).

Expect: `http_req_failed 0.00%`, `p(95) ≈ 1.0–1.1 s`, thresholds green, exit 0.

```powershell
docker compose exec -T postgres psql -U postgres -d app -c "select count(*) from pg_stat_activity where datname='app';"   # 10
docker compose exec -T -e PGPASSWORD=demo postgres psql -h pgbouncer -p 6432 -U demo -d pgbouncer -c "SHOW POOLS;"
```

Expect in `SHOW POOLS`: `cl_active ≈ 120`, `sv_active ≈ 0–10`, `sv_idle ≈ 10`, `maxwait` small.
Same script, same load: 120 app-side connections, 10 database backends, zero errors.

Caveat (2 min, optional): run `/tx?ms=1000` at ~40 rps through PgBouncer. Each in-flight transaction pins
a server connection, so 10 server connections serve ~10 tx/s; `cl_waiting` grows, `maxwait` reaches 5 s,
`query_wait_timeout` drops clients. **A pooler fixes connection count, not connection time.**

---

## Step 8 — Observability (last)

```powershell
docker compose --profile obs up -d
```

### `docker/prometheus/prometheus.yml`

```yaml
global:
  scrape_interval: 2s
  evaluation_interval: 2s

scrape_configs:
  - job_name: app
    static_configs:
      - targets: ['host.docker.internal:3101']
        labels: { replica: r1 }
      - targets: ['host.docker.internal:3102']
        labels: { replica: r2 }
      - targets: ['host.docker.internal:3103']
        labels: { replica: r3 }
  - job_name: postgres
    static_configs:
      - targets: ['postgres-exporter:9187']
  - job_name: pgbouncer
    static_configs:
      - targets: ['pgbouncer-exporter:9127']
```

Targets for replicas you have not started show `down` — expected.

### `docker/grafana/provisioning/datasources/prometheus.yml`

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

### `docker/grafana/provisioning/dashboards/default.yml`

```yaml
apiVersion: 1
providers:
  - name: lab
    folder: Lab
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

Verify and send k6 metrics into the same Prometheus:

```powershell
curl.exe -s http://localhost:9090/-/ready
curl.exe -s http://localhost:9187/metrics | Select-String "pg_stat_activity_count|pg_settings_max_connections"
curl.exe -s http://localhost:9127/metrics | Select-String "cl_waiting|server_active"

docker run --rm -i -v "${PWD}/load/k6:/scripts:ro" `
  -e BASE_URLS=http://host.docker.internal:3101,http://host.docker.internal:3102,http://host.docker.internal:3103 `
  -e K6_PROMETHEUS_RW_SERVER_URL=http://host.docker.internal:9090/api/v1/write `
  -e K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),max `
  grafana/k6 run -o experimental-prometheus-rw /scripts/exhaust.js
```

If k6 rejects the output name, use `-o prometheus-rw`.

Grafana at http://localhost:3001 (admin/admin), 7 panels in this order:

| # | Panel | Query |
| --- | --- | --- |
| 1 | DB backends vs ceiling | `sum(pg_stat_activity_count{datname="app"}) by (state)` + instant `pg_settings_max_connections` |
| 2 | Pool in use / idle / waiting | `db_pool_total`, `db_pool_idle`, `db_pool_waiting` (legend `{{replica}}`) |
| 3 | p95 latency | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[1m])))` |
| 4 | 5xx rate | `sum(rate(http_requests_total{status=~"5.."}[1m])) / sum(rate(http_requests_total[1m]))` |
| 5 | Errors by reason | `sum by (reason) (rate(pg_pool_errors_total[1m]))` |
| 6 | Pooler queue | `pgbouncer_pools_cl_waiting`, `pgbouncer_pools_server_active`, `pgbouncer_pools_maxwait_seconds` |
| 7 | k6 driven load | `k6_http_reqs_total`, `k6_http_req_failed_rate`, `k6_http_req_duration_p95` |

Run Steps 5 and 7 back to back (~2 min each) on the same time range: panel 1 is the whole argument —
**22 pinned + error wall → 10 flat + zero errors**.

`docker/grafana/dashboards/pool-exhaustion.json` (all 7 panels, units, threshold line) to be generated
when the plan is implemented.

---

## Step 9 — Reset / cleanup

```powershell
# stop app replicas
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

docker compose restart postgres          # clear backends between phases
docker compose --profile obs down        # stop everything, keep data
docker compose down -v                   # full wipe (re-runs init.sql on next up)
```

---

## Files to create (full list)

```
docker-compose.yml
docker/postgres/init.sql
docker/pgbouncer/pgbouncer.ini
docker/pgbouncer/userlist.txt
docker/prometheus/prometheus.yml
docker/grafana/provisioning/datasources/prometheus.yml
docker/grafana/provisioning/dashboards/default.yml
docker/grafana/dashboards/pool-exhaustion.json      # last
src/db.js
src/metrics.js
server.js
load/k6/baseline.js
load/k6/slow.js
load/k6/exhaust.js
load/k6/churn.js
```

`index.js` stays untouched. `package.json` gains `pg`, `prom-client`, and a `start` script.

## Expected numbers, at a glance

| Phase | Load | DB backends | App pool waiting | Errors |
| --- | --- | --- | --- | --- |
| 3 baseline | 10 VUs `/fast` | 10 idle | 0 | 0 % |
| 4 slow | 20→100 rps `/slow?ms=300` | 10 active (pinned) | up to ~60 | 60–80 % (acquire timeout) |
| 5 exhaust, no pooler | 120 VUs `/hold?ms=1000` | 22 (ceiling) | 0–40 per replica | 70–90 % (`53300`) |
| 6 churn | 50 rps `/churn` | 1–3, high churn | 0 | 0 % |
| 6 leak | 25 × `/leak` | 22 (ceiling) | 0 | `53300` |
| 7 exhaust, PgBouncer | same as 5 | 10 idle | 0 | 0 % |
| 7 tx, PgBouncer | 40 rps `/tx?ms=1000` | 10 active | pooler `cl_waiting` grows | timeouts after 5 s |

## Why a proxy pooler (the conclusion to write down)

1. `max_connections` is one global budget; app pools are per-process and multiply with replicas.
   A pooler turns the DB-side number into a single controlled knob (`default_pool_size` × poolers).
2. DB connections are expensive to create (fork, memory, auth). Pooling amortises that and bounds leaks.
3. Transparent scale-out: add/restart app replicas without re-planning DB capacity.
4. It does **not** create capacity: long transactions still pin server connections. Short queries, timeouts
   (`statement_timeout`, `idle_in_transaction_session_timeout`, `connectionTimeoutMillis`), and sane pool
   sizes remain mandatory.
5. Transaction pooling has session-state costs: named prepared statements (unless `max_prepared_statements`),
   `SET`, advisory locks, `LISTEN/NOTIFY`, `search_path`. `pg` defaults to unnamed statements, so it works;
   ORMs that use named prepared statements may need configuration or session pooling.
