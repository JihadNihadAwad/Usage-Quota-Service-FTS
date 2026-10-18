import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { CreateAccountBody, UpdateAccountBody, type CreateAccountInput } from '../dto.js';
import { authCtx } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { serializeAccount, serializeCreatedAccount } from '../serialize.js';
import { createAccount, getAccount, updateAccountPlan } from '../../services/accounts.js';

/**
 * POST /accounts - the unauthenticated bootstrap endpoint, deliberately mounted BEFORE the auth gate in the server.
 */
export function publicAccountRoutes(db: Db): Router {
  const router = Router();
  router.post('/accounts', validate({ body: CreateAccountBody }), async (req, res) => {
    const body = req.body as CreateAccountInput;
    const created = await createAccount(db, {
      name: body.name,
      accountPlanId: body.account_plan_id,
    });
    res.status(201).json(serializeCreatedAccount(created));
  });
  return router;
}

/** GET/PATCH /account - the calling account inspects or re-plans itself. */
export function accountRoutes(db: Db): Router {
  const router = Router();

  router.get('/account', async (req, res) => {
    const auth = authCtx(req);
    const account = await getAccount(db, auth.accountId);
    res.json(serializeAccount(account));
  });

  router.patch('/account', validate({ body: UpdateAccountBody }), async (req, res) => {
    const auth = authCtx(req);
    const body = req.body as { account_plan_id: string };
    const account = await updateAccountPlan(db, auth.accountId, body.account_plan_id);
    res.json(serializeAccount(account));
  });

  return router;
}
