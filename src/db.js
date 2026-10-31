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
