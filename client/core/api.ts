// Thin typed HTTP client for the usage API's wire format. Shared by the web
// demo server and the headless runner, so both tell exactly the same story.
//
// Note the consume semantics: a REJECTED quota decision is a
// 200 with `accepted: false` in the body - only transport/protocol failures
// throw here.

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export interface PlanDto {
  id: string;
  name: string;
  scope: 'account' | 'user';
  rules: Record<string, number>;
  predefined: boolean;
  created_at: string;
  updated_at: string;
}

export interface AccountDto {
  id: string;
  name: string;
  plan: PlanDto;
  created_at: string;
  updated_at: string;
}

export interface CreatedAccountDto {
  account: AccountDto;
  api_key: { key: string; key_prefix: string; created_at: string };
}

export interface UserDto {
  id: string;
  external_id: string;
  plan: PlanDto;
  created_at: string;
  updated_at: string;
}

export interface LevelStateDto {
  plan_id: string;
  used_units: number;
  remaining: number | null;
}

export interface ConsumeDecisionDto {
  request_id: string;
  accepted: boolean;
  units: number;
  units_consumed: number;
  reason: { level: string; rule: string; message: string } | null;
  all_reasons: Array<{ level: string; rule: string; message: string }> | null;
  account: LevelStateDto;
  user: LevelStateDto;
  evaluated: { account_rules: Record<string, number>; user_rules: Record<string, number> };
}

export interface UsageDto {
  month: string;
  used_units: number;
  allowance: number | null;
  remaining: number | null;
  plan: PlanDto;
}

async function call(
  baseUrl: string,
  key: string | null,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const hasBody = init?.body !== undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(key !== null ? { Authorization: `Bearer ${key}` } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(init?.body) } : {}),
  });

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiCallError(
      res.status,
      envelope?.code ?? 'UNKNOWN',
      envelope?.message ?? res.statusText,
    );
  }
  return body;
}

export class UsageApi {
  constructor(private readonly baseUrl: string) {}

  /** Unauthenticated bootstrap (the only unauthenticated call the demo makes). */
  createAccount(name: string): Promise<CreatedAccountDto> {
    return call(this.baseUrl, null, '/accounts', {
      method: 'POST',
      body: { name },
    }) as Promise<CreatedAccountDto>;
  }

  getAccount(key: string): Promise<AccountDto> {
    return call(this.baseUrl, key, '/account') as Promise<AccountDto>;
  }

  patchAccountPlan(key: string, planId: string): Promise<AccountDto> {
    return call(this.baseUrl, key, '/account', {
      method: 'PATCH',
      body: { account_plan_id: planId },
    }) as Promise<AccountDto>;
  }

  createUser(key: string, externalId: string, planId?: string): Promise<UserDto> {
    return call(this.baseUrl, key, '/users', {
      method: 'POST',
      body:
        planId === undefined
          ? { external_id: externalId }
          : { external_id: externalId, plan_id: planId },
    }) as Promise<UserDto>;
  }

  createPlan(
    key: string,
    name: string,
    scope: 'account' | 'user',
    rules: Record<string, number>,
  ): Promise<PlanDto> {
    return call(this.baseUrl, key, '/plans', {
      method: 'POST',
      body: { name, scope, rules },
    }) as Promise<PlanDto>;
  }

  consume(
    key: string,
    userId: string,
    requestId: string,
    units: number,
  ): Promise<ConsumeDecisionDto> {
    return call(this.baseUrl, key, '/consume', {
      method: 'POST',
      body: { user_id: userId, request_id: requestId, units },
    }) as Promise<ConsumeDecisionDto>;
  }

  getAccountUsage(key: string): Promise<UsageDto> {
    return call(this.baseUrl, key, '/usage') as Promise<UsageDto>;
  }

  getUserUsage(key: string, userId: string): Promise<UsageDto> {
    return call(this.baseUrl, key, `/users/${userId}/usage`) as Promise<UsageDto>;
  }
}
