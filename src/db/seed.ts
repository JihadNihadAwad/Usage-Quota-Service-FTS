import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { closePool, getDb, type Db } from './client.js';
import { PREDEFINED_PLANS } from './predefined.js';
import { plans } from './schema.js';

// Idempotency matters twice here: predefined plans must exist from the moment
// the service starts, and containers restart - so re-running must be a no-op.
// We upsert by fixed id and report insert/update/unchanged so the startup log
// tells the truth about what happened.

// jsonb normalizes object key order, so a naive JSON.stringify comparison of
// a round-tripped rules object against the source literal can mismatch purely
// on ordering. Compare with keys sorted - rules are flat {number} objects.
function sameRules(a: unknown, b: unknown): boolean {
  const canon = (r: unknown) => JSON.stringify(r, Object.keys(r as Record<string, unknown>).sort());
  return canon(a) === canon(b);
}

export interface SeedReport {
  inserted: number;
  updated: number;
  unchanged: number;
}

export async function seedPredefinedPlans(db: Db = getDb()): Promise<SeedReport> {
  const report: SeedReport = { inserted: 0, updated: 0, unchanged: 0 };

  for (const plan of PREDEFINED_PLANS) {
    const [existing] = await db.select().from(plans).where(eq(plans.id, plan.id)).limit(1);

    if (!existing) {
      await db.insert(plans).values({
        id: plan.id,
        accountId: null,
        name: plan.name,
        scope: plan.scope,
        rules: plan.rules,
      });
      report.inserted += 1;
    } else if (
      existing.name !== plan.name ||
      existing.scope !== plan.scope ||
      !sameRules(existing.rules, plan.rules)
    ) {
      await db
        .update(plans)
        .set({ name: plan.name, scope: plan.scope, rules: plan.rules, updatedAt: new Date() })
        .where(eq(plans.id, plan.id));
      report.updated += 1;
    } else {
      report.unchanged += 1;
    }
  }

  return report;
}

async function main(): Promise<void> {
  const report = await seedPredefinedPlans();
  console.log(
    `[seed] predefined plans: ${report.inserted} inserted, ${report.updated} updated, ${report.unchanged} unchanged`,
  );
}

// Run as `npm run seed`, but stay importable (the container entrypoint calls
// seedPredefinedPlans() directly at startup).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await main();
  } catch (err: unknown) {
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
