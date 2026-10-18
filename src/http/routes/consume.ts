import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { ConsumeBody } from '../dto.js';
import { ApiError } from '../errors.js';
import { validate } from '../middleware/validate.js';

/**
 * The consume endpoint validates its input shape and authenticates,
 * but the transaction orchestrator owns the locked read. A partial, unlocked
 * consume would be the one correctness hazard this project cannot afford, so
 * until the transaction exists the route answers 501 explicitly.
 */
export function consumeRoutes(_db: Db): Router {
  const router = Router();

  router.post('/consume', validate({ body: ConsumeBody }), () => {
    throw new ApiError(
      501,
      'NOT_IMPLEMENTED',
      'the consume transaction is implemented in the next phase',
    );
  });

  return router;
}
