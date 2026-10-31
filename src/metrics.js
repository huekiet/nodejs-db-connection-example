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
