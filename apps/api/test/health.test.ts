import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

const env = loadEnv({ APP_ENV: 'test', LOG_LEVEL: 'silent', APP_VERSION: 'test' });

describe('health endpoints', () => {
  it('reports liveness', async () => {
    const app = createApp({ env, checkReady: async () => {} });
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'api', version: 'test' });
  });

  it('reports readiness failure with 503', async () => {
    const app = createApp({
      env,
      checkReady: async () => {
        throw new Error('db down');
      }
    });
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
  });

  it('returns the standard error format for unknown API routes', async () => {
    const app = createApp({ env, checkReady: async () => {} });
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('environment validation', () => {
  it('rejects an invalid port', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/PORT/);
  });
});
