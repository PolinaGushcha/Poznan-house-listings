import type { Health } from '@phl/shared';
import { Router } from 'express';

export type ReadinessCheck = () => Promise<void>;

/** Liveness: the process is up. Readiness: dependencies (database) are reachable. */
export function healthRouter(version: string, checkReady: ReadinessCheck): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    const body: Health = { status: 'ok', service: 'api', version };
    res.json(body);
  });

  router.get('/ready', async (req, res) => {
    try {
      await checkReady();
      const body: Health = { status: 'ok', service: 'api', version };
      res.json(body);
    } catch (err) {
      // The reason goes to the log only — the response never exposes database details.
      req.log.warn({ err }, 'readiness check failed');
      const body: Health = { status: 'error', service: 'api', version };
      res.status(503).json(body);
    }
  });

  return router;
}
