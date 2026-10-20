-- Pure-compute probe, run INSIDE the db container over the unix socket
-- (zero network): the same consume-shaped statements as probe-cost.cjs,
-- batched into one simple-protocol query per transaction.
--
--   docker compose cp performance/probe-db.sql db:/tmp/probe-db.sql
--   docker compose exec db pgbench -U postgres -c 1 -t 300 -f /tmp/probe-db.sql fts
--
-- Compare with probe-cost.cjs run inside the api container: the delta is
-- the socket/network + driver share of the consume path.

begin;
select u.plan_id, p.rules as user_rules from users u join plans p on p.id = u.plan_id where u.id = 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8' and u.account_id = '1e43d8c1-b037-4642-bc4f-692db9213684';
select a.account_plan_id, p.rules as account_rules from accounts a join plans p on p.id = a.account_plan_id where a.id = '1e43d8c1-b037-4642-bc4f-692db9213684';
insert into account_usage (account_id, month_start, used_units) values ('1e43d8c1-b037-4642-bc4f-692db9213684', '2026-10-01', 0) on conflict do nothing;
insert into user_usage (user_id, month_start, used_units) values ('d9338d00-2d6c-43c7-a727-1ae8dc1ae8c8', '2026-10-01', 0) on conflict do nothing;
select used_units, accepted_requests from account_usage where account_id = '1e43d8c1-b037-4642-bc4f-692db9213684' and month_start = '2026-10-01' for update;
select used_units, accepted_requests from user_usage where user_id = 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8' and month_start = '2026-10-01' for update;
select user_id, units from requests where account_id = '1e43d8c1-b037-4642-bc4f-692db9213684' and request_id = 'probe';
update account_usage set used_units = used_units + 1, accepted_requests = accepted_requests + 1, updated_at = now() where account_id = '1e43d8c1-b037-4642-bc4f-692db9213684' and month_start = '2026-10-01' returning used_units;
update user_usage set used_units = used_units + 1, accepted_requests = accepted_requests + 1, updated_at = now() where user_id = 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8' and month_start = '2026-10-01' returning used_units;
insert into requests (account_id, user_id, request_id, units, month_start, accepted, units_consumed, account_plan_id, user_plan_id, account_rules, user_rules, response) values ('1e43d8c1-b037-4642-bc4f-692db9213684', 'd9338d00-2d6c-43c7-a727-1ae8dc1ae8c8', 'probe-' || md5(clock_timestamp()::text), 1, '2026-10-01', true, 1, '4e95a392-346e-42e2-a96e-48f25c9a130b', '9db4a36e-50d5-4a7e-8ab7-0de220611455', '{}', '{}', '{}');
commit;
