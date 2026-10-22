// Cost-isolation probe, run INSIDE the api container (compose network).
//
// Times the same consume-shaped transaction two ways:
//   A) eight statements, one round trip each - how src/services/consume.ts
//      runs in steady state (the month's counter rows already exist; only
//      the first consume of a month pays the two setup INSERTs)
//   B) the same statements in ONE multi-statement query - one round trip
//
// The delta is pure round-trip overhead; what remains in B is statement
// execution. Sequential iterations mimic the per-account lock regime, so
// 1/B is the per-account ceiling batching would buy.
//
//   docker compose cp performance/probe-cost.cjs api:/app/probe-cost.cjs
//   docker compose exec -w /app api node probe-cost.cjs

const { Pool } = require('pg');

const ACCOUNT = '1e43d8c1-b037-4642-bc4f-692db9213684';
const USER = 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8';
const MONTH = new Date().toISOString().slice(0, 7) + '-01';
const UNITS = 1;
const N = 300;

const statements = [
  `select u.plan_id, p.rules as user_rules from users u join plans p on p.id = u.plan_id where u.id = '${USER}' and u.account_id = '${ACCOUNT}'`,
  `select a.account_plan_id, p.rules as account_rules from accounts a join plans p on p.id = a.account_plan_id where a.id = '${ACCOUNT}'`,
  `select used_units, accepted_requests from account_usage where account_id = '${ACCOUNT}' and month_start = '${MONTH}' for update`,
  `select used_units, accepted_requests from user_usage where user_id = '${USER}' and month_start = '${MONTH}' for update`,
  `select user_id, units from requests where account_id = '${ACCOUNT}' and request_id = 'probe'`,
  `update account_usage set used_units = used_units + ${UNITS}, accepted_requests = accepted_requests + 1, updated_at = now() where account_id = '${ACCOUNT}' and month_start = '${MONTH}' returning used_units`,
  `update user_usage set used_units = used_units + ${UNITS}, accepted_requests = accepted_requests + 1, updated_at = now() where user_id = '${USER}' and month_start = '${MONTH}' returning used_units`,
  `insert into requests (account_id, user_id, request_id, units, month_start, accepted, units_consumed, account_plan_id, user_plan_id, account_rules, user_rules, response) values ('${ACCOUNT}', '${USER}', 'probe-' || md5(clock_timestamp()::text), ${UNITS}, '${MONTH}', true, ${UNITS}, '4e95a392-346e-42e2-a96e-48f25c9a130b', '9db4a36e-50d5-4a7e-8ab7-0de220611455', '{}', '{}', '{}')`,
];

async function sequential(client) {
  await client.query('begin');
  for (const s of statements) await client.query(s);
  await client.query('commit');
}

// One multi-statement string = one round trip (simple query protocol).
// Wrapped in a savepoint-free begin/commit of its own.
const batched = 'begin;\n' + statements.join(';\n') + ';\ncommit;';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  // warm-up
  await sequential(client);
  await client.query(batched);

  const t0 = performance.now();
  for (let i = 0; i < N; i++) await sequential(client);
  const seqMs = (performance.now() - t0) / N;

  const t1 = performance.now();
  for (let i = 0; i < N; i++) await client.query(batched);
  const batchMs = (performance.now() - t1) / N;

  console.log(`per-transaction, ${N} iterations each, api container -> db container:`);
  console.log(`  A eight statements, one round trip each: ${seqMs.toFixed(3)} ms  (ceiling ~${(1000 / seqMs).toFixed(0)}/s per account)`);
  console.log(`  B same statements, ONE round trip:      ${batchMs.toFixed(3)} ms  (ceiling ~${(1000 / batchMs).toFixed(0)}/s per account)`);
  console.log(`  round-trip share: ${(100 * (seqMs - batchMs) / seqMs).toFixed(0)}% of the current path`);

  // undo the probe's charges (invariant checker tolerates them, but keep the dataset clean)
  await client.query(
    `update account_usage set used_units = used_units - ${N * 2}, accepted_requests = accepted_requests - ${N * 2} where account_id = $1 and month_start = $2`,
    [ACCOUNT, MONTH],
  );
  await client.query(
    `update user_usage set used_units = used_units - ${N * 2}, accepted_requests = accepted_requests - ${N * 2} where user_id = $1 and month_start = $2`,
    [USER, MONTH],
  );
  await client.query(`delete from requests where request_id like 'probe-%'`);

  client.release();
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
