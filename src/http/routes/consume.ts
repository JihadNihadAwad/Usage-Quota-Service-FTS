import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { ConsumeBody, type ConsumeInput } from '../dto.js';
import { authCtx } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { consume } from '../../services/consume.js';

export function consumeRoutes(db: Db): Router {
  const router = Router();

  // 200 for BOTH accepted and rejected decisions: a quota decision is a
  // successful API call. Replays of either outcome return the
  // stored body with the same status it was originally sent with; a reused
  // request_id with a changed payload is 409 IDEMPOTENCY_CONFLICT.
  router.post('/consume', validate({ body: ConsumeBody }), async (req, res) => {
    const auth = authCtx(req);
    const body = req.body as ConsumeInput;
    const result = await consume(db, auth.accountId, {
      userId: body.user_id,
      requestId: body.request_id,
      units: body.units,
    });
    res.status(200).json(result.response);
  });

  return router;
}
