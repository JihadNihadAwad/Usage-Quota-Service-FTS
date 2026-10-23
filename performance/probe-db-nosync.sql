-- Durability probe: the same zero-network transaction with the WAL fsync
-- moved off the commit path (synchronous_commit = off). Postgres keeps
-- every guarantee EXCEPT losing the last few milliseconds of commits if
-- the server crashes hard. A quota service must not make that trade; this
-- probe exists to show what the fsync costs, not to recommend it.
--
--   docker compose cp performance/probe-db-nosync.sql db:/tmp/probe-db-nosync.sql
--   docker compose exec db pgbench -U postgres -c 1 -t 300 -f /tmp/probe-db-nosync.sql fts
--
-- month_start is pinned to the 2026-10 evidence run, and the charges stay
-- (the invariant checker tolerates them; probe-cost.cjs is the variant
-- that undoes its own).

begin;
set local synchronous_commit = off;
select u.plan_id, p.rules as user_rules from users u join plans p on p.id = u.plan_id where u.id = 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8' and u.account_id = '1e43d8c1-b037-4642-bc4f-692db9213684';
select a.account_plan_id, p.rules as account_rules from accounts a join plans p on p.id = a.account_plan_id where a.id = '1e43d8c1-b037-4642-bc4f-692db9213684';
select used_units, accepted_requests from account_usage where account_id = '1e43d8c1-b037-4642-bc4f-692db9213684' and month_start = '2026-10-01' for update;
select used_units, accepted_requests from user_usage where user_id = 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8' and month_start = '2026-10-01' for update;
select user_id, units from requests where account_id = '1e43d8c1-b037-4642-bc4f-692db9213684' and request_id = 'probe';
update account_usage set used_units = used_units + 1, accepted_requests = accepted_requests + 1, updated_at = now() where account_id = '1e43d8c1-b037-4642-bc4f-692db9213684' and month_start = '2026-10-01' returning used_units;
update user_usage set used_units = used_units + 1, accepted_requests = accepted_requests + 1, updated_at = now() where user_id = 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8' and month_start = '2026-10-01' returning used_units;
insert into requests (account_id, user_id, request_id, units, month_start, accepted, units_consumed, account_plan_id, user_plan_id, account_rules, user_rules, response) values ('1e43d8c1-b037-4642-bc4f-692db9213684', 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8', 'probe-' || md5(clock_timestamp()::text), 1, '2026-10-01', true, 1, '4e95a392-346e-42e2-a96e-48f25c9a130b', '9db4a36e-50d5-4a7e-8ab7-0de220611455', '{}', '{}', '{}');
commit;
