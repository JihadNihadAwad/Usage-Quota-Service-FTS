import { Router } from 'express';
import type { Db } from '../../db/client.js';
import {
  HistoryQuery,
  IdParam,
  UserHistoryQuery,
  type HistoryQueryInput,
  type UserHistoryQueryInput,
} from '../dto.js';
import { resolveMonthStart } from '../month-param.js';
import { authCtx } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { serializeHistoryItem } from '../serialize.js';
import { listHistory } from '../../services/history.js';

export function historyRoutes(db: Db): Router {
  const router = Router();

  router.get('/history', validate({ query: HistoryQuery }), async (req, res) => {
    const auth = authCtx(req);
    const query = req.query as unknown as HistoryQueryInput;
    const page = await listHistory(db, auth.accountId, {
      userId: query.user_id,
      monthStart: query.month === undefined ? undefined : resolveMonthStart(query.month),
      outcome: query.outcome,
      limit: query.limit,
      cursor: query.cursor,
    });
    res.json({ items: page.items.map(serializeHistoryItem), next_cursor: page.nextCursor });
  });

  router.get(
    '/users/:id/history',
    validate({ params: IdParam, query: UserHistoryQuery }),
    async (req, res) => {
      const auth = authCtx(req);
      const { id } = req.params as unknown as { id: string };
      const query = req.query as unknown as UserHistoryQueryInput;
      const page = await listHistory(db, auth.accountId, {
        userId: id,
        monthStart: query.month === undefined ? undefined : resolveMonthStart(query.month),
        outcome: query.outcome,
        limit: query.limit,
        cursor: query.cursor,
      });
      res.json({ items: page.items.map(serializeHistoryItem), next_cursor: page.nextCursor });
    },
  );

  return router;
}
