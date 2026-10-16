import pg from 'pg';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 }) : null;

const app = createApp({
  env,
  checkReady: async () => {
    if (!pool) throw new Error('DATABASE_URL is not configured');
    await pool.query('select 1');
  }
});

const server = app.listen(env.PORT, () => {
  console.log(`api listening on port ${env.PORT} (${env.APP_ENV})`);
});

// ECS, Docker and systemd stop containers with SIGTERM: finish requests, then close the pool.
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await pool?.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
