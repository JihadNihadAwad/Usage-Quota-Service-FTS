import { Router } from 'express';
import type { Db } from '../../db/client.js';
import {
  CreatePlanBody,
  IdParam,
  ScopeQuery,
  UpdatePlanBody,
  type CreatePlanInput,
  type ScopeQueryInput,
  type UpdatePlanInput,
} from '../dto.js';
import { authCtx } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { serializePlan } from '../serialize.js';
import { createPlan, listPlans, updatePlan } from '../../services/plans.js';

export function planRoutes(db: Db): Router {
  const router = Router();

  // Predefined catalog + this account's custom plans.
  router.get('/plans', validate({ query: ScopeQuery }), async (req, res) => {
    const auth = authCtx(req);
    const query = req.query as unknown as ScopeQueryInput;
    const items = await listPlans(db, auth.accountId, query.scope);
    res.json({ items: items.map(serializePlan) });
  });

  router.post('/plans', validate({ body: CreatePlanBody }), async (req, res) => {
    const auth = authCtx(req);
    const body = req.body as CreatePlanInput;
    const plan = await createPlan(db, auth.accountId, {
      name: body.name,
      scope: body.scope,
      rules: body.rules,
    });
    res.status(201).json(serializePlan(plan));
  });

  // Predefined -> 403 PLAN_IMMUTABLE; foreign custom -> 404 (masking).
  router.patch(
    '/plans/:id',
    validate({ params: IdParam, body: UpdatePlanBody }),
    async (req, res) => {
      const auth = authCtx(req);
      const { id } = req.params as unknown as { id: string };
      const body = req.body as UpdatePlanInput;
      const plan = await updatePlan(db, auth.accountId, id, {
        name: body.name,
        rules: body.rules,
      });
      res.json(serializePlan(plan));
    },
  );

  return router;
}
