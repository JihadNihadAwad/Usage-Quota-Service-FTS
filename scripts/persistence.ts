import { execFileSync } from 'node:child_process';
import { deepStrictEqual } from 'node:assert';

// Accounts, users, plans, assignments, usage, and request history live in
// the database, so they survive a restart.
//
// This probe runs against the DOCKER COMPOSE stack (localhost:3000 - the
// same thing `docker compose up --build` provides), not the test db.
// It restarts ONLY the api container, mid-flight, and proves:
//   - the data written before the restart is still there afterwards
//   - a retry of the same request_id after the restart replays the stored
//     decision verbatim and is not charged again
//
// Run: npm run test:persistence   (stack must be up: docker compose up -d --wait)

const API_BASE = process.env.USAGE_API_URL ?? 'http://localhost:3000';

interface Json {
  [key: string]: unknown;
}

async function get(path: string, key: string): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, body: (await res.json()) as Json };
}

async function post(
  path: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key !== undefined ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

function fail(message: string): never {
  console.error(`\n[persistence] FAIL: ${message}`);
  process.exit(1);
}

function expectEq(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/healthz`);
      if (res.ok) {
        const ready = await fetch(`${API_BASE}/readyz`);
        if (ready.ok) return;
      }
    } catch {
      // still restarting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail('api did not become ready within 60s of the restart');
}

async function main(): Promise<void> {
  // 0. Stack must be running.
  try {
    const health = await fetch(`${API_BASE}/healthz`);
    if (!health.ok) throw new Error(`healthz returned ${health.status}`);
  } catch {
    fail('the compose stack is not reachable on :3000 - run `docker compose up -d --wait` first');
  }

  // 1. Write data: an account, a user, and one accepted consume.
  const stamp = Date.now().toString(36);
  const created = await post('/v1/accounts', { name: `PersistenceProbe-${stamp}` });
  expectEq(created.status, 201, 'bootstrap status');
  const key = (created.body.api_key as { key: string }).key;
  const accountId = (created.body.account as { id: string }).id;

  const user = await post('/v1/users', { external_id: 'probe-user' }, key);
  expectEq(user.status, 201, 'user creation status');
  const userId = (user.body as { id: string }).id;

  const request_id = `persist-${stamp}`;
  const consumed = await post('/v1/consume', { user_id: userId, request_id, units: 7 }, key);
  expectEq(consumed.status, 200, 'consume status');
  expectEq((consumed.body as { accepted: boolean }).accepted, true, 'consume accepted');
  console.log(`[persistence] wrote: account ${accountId}, user, request ${request_id} (7 units)`);

  // 2. Kill the api container mid-flight (the db keeps running).
  console.log('[persistence] restarting the api container…');
  execFileSync('docker', ['compose', 'restart', 'api'], { stdio: 'inherit' });
  await waitForApi();
  console.log('[persistence] api is back — verifying the data survived');

  // 3. The same key still authenticates; the same data is still there.
  const account = await get('/v1/account', key);
  expectEq(account.status, 200, 'account readable after restart');
  expectEq((account.body as { id: string }).id, accountId, 'account id');

  const usage = await get('/v1/usage', key);
  expectEq((usage.body as { used_units: number }).used_units, 7, 'account usage');

  const history = await get('/v1/history?limit=100', key);
  const items = (history.body as { items: Array<{ request_id: string }> }).items;
  if (!items.some((item) => item.request_id === request_id)) {
    fail(`history lost the request after the restart (items: ${JSON.stringify(items)})`);
  }

  // 4. A retry of the same request_id replays the stored decision verbatim
  //    and is not charged again. Deep equality, not byte equality: the stored
  //    body lives in a jsonb column, which normalizes key order (decision
  //    #28) - the contract is content-identical.
  const replay = await post('/v1/consume', { user_id: userId, request_id, units: 7 }, key);
  expectEq(replay.status, 200, 'replay status');
  try {
    deepStrictEqual(replay.body, consumed.body);
  } catch {
    fail('replayed decision differs from the original');
  }

  const usageAfter = await get('/v1/usage', key);
  expectEq(
    (usageAfter.body as { used_units: number }).used_units,
    7,
    'usage unchanged by the replay',
  );

  console.log(
    '[persistence] PASS — data survived the restart; the retry replayed and was not re-charged',
  );
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
