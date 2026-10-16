import { ErrorCode } from '@phl/shared';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { Env } from './config/env.js';
import { type ReadinessCheck, healthRouter } from './routes/health.js';

export interface AppDeps {
  env: Env;
  checkReady: ReadinessCheck;
}

/** Builds the Express app without listening, so tests can import it. All routes live under /api. */
export function createApp({ env, checkReady }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind the Caddy reverse proxy

  app.use(
    pinoHttp({
      level: env.LOG_LEVEL,
      genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]']
    })
  );
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter(env.APP_VERSION, checkReady));

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: { code: ErrorCode.NotFound, message: 'Not found', requestId: String(req.id) }
    });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({
      error: {
        code: ErrorCode.Internal,
        message: 'Internal server error',
        requestId: String(req.id)
      }
    });
  };
  app.use(errorHandler);

  return app;
}
