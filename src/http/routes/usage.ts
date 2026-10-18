import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { IdParam, MonthQuery, type MonthQueryInput } from '../dto.js';
import { resolveMonthStart } from '../month-param.js';
import { authCtx } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { serializeUsage } from '../serialize.js';
import { getAccountUsage, getUserUsage } from '../../services/usage.js';

export function usageRoutes(db: Db): Router {
  const router = Router();

  router.get('/usage', validate({ query: MonthQuery }), async (req, res) => {
    const auth = authCtx(req);
    const query = req.query as unknown as MonthQueryInput;
    const usage = await getAccountUsage(db, auth.accountId, resolveMonthStart(query.month));
    res.json(serializeUsage(usage));
  });

  router.get(
    '/users/:id/usage',
    validate({ params: IdParam, query: MonthQuery }),
    async (req, res) => {
      const auth = authCtx(req);
      const { id } = req.params as unknown as { id: string };
      const query = req.query as unknown as MonthQueryInput;
      const usage = await getUserUsage(db, auth.accountId, id, resolveMonthStart(query.month));
      res.json(serializeUsage(usage));
    },
  );

  return router;
}
