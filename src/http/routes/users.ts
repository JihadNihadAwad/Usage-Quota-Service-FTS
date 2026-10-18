import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { CreateUserBody, IdParam, UpdateUserBody, type CreateUserInput } from '../dto.js';
import { authCtx } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { serializeUser } from '../serialize.js';
import { createUser, getUser, listUsers, updateUserPlan } from '../../services/users.js';

export function userRoutes(db: Db): Router {
  const router = Router();

  router.post('/users', validate({ body: CreateUserBody }), async (req, res) => {
    const auth = authCtx(req);
    const body = req.body as CreateUserInput;
    const user = await createUser(db, auth.accountId, {
      externalId: body.external_id,
      planId: body.plan_id,
    });
    res.status(201).json(serializeUser(user));
  });

  router.get('/users', async (req, res) => {
    const auth = authCtx(req);
    const users = await listUsers(db, auth.accountId);
    res.json({ items: users.map(serializeUser) });
  });

  router.get('/users/:id', validate({ params: IdParam }), async (req, res) => {
    const auth = authCtx(req);
    const { id } = req.params as unknown as { id: string };
    const user = await getUser(db, auth.accountId, id);
    res.json(serializeUser(user));
  });

  router.patch(
    '/users/:id',
    validate({ params: IdParam, body: UpdateUserBody }),
    async (req, res) => {
      const auth = authCtx(req);
      const { id } = req.params as unknown as { id: string };
      const body = req.body as { plan_id: string };
      const user = await updateUserPlan(db, auth.accountId, id, body.plan_id);
      res.json(serializeUser(user));
    },
  );

  return router;
}
