// Thin typed HTTP client for the usage API's wire format. Shared by the web
// demo server and the headless runner, so both run exactly the same steps.
//
// Every method returns { request, data }: the request descriptor (method,
// path, body) is surfaced with each call so the demo can SHOW the API
// request next to its response - part of the demo.
//
// Note the consume semantics: a REJECTED quota decision is a
// 200 with `accepted: false` in the body - only transport/protocol failures
// throw here.

export interface RequestInfo {
  method: string;
  path: string;
  body?: unknown;
}

export interface ApiResult<T> {
  request: RequestInfo;
  data: T;
}

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly request: RequestInfo,
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

export interface HistoryItemDto {
  id: number;
  request_id: string;
  user_id: string;
  units: number;
  accepted: boolean;
  units_consumed: number;
  rejection: { level: string; rule: string } | null;
  month: string;
  created_at: string;
}

export interface HistoryPageDto {
  items: HistoryItemDto[];
  next_cursor: string | null;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;
}

export class UsageApi {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(
    key: string | null,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<ApiResult<T>> {
    const request: RequestInfo = { method: init?.method ?? 'GET', path, body: init?.body };
    const hasBody = init?.body !== undefined;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: request.method,
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
        request,
      );
    }
    return { request, data: body as T };
  }

  /** Unauthenticated bootstrap (the only unauthenticated call the demo makes). */
  createAccount(name: string): Promise<ApiResult<CreatedAccountDto>> {
    return this.call<CreatedAccountDto>(null, '/accounts', { method: 'POST', body: { name } });
  }

  getAccount(key: string): Promise<ApiResult<AccountDto>> {
    return this.call<AccountDto>(key, '/account');
  }

  patchAccountPlan(key: string, planId: string): Promise<ApiResult<AccountDto>> {
    return this.call<AccountDto>(key, '/account', {
      method: 'PATCH',
      body: { account_plan_id: planId },
    });
  }

  createUser(key: string, externalId: string, planId?: string): Promise<ApiResult<UserDto>> {
    return this.call<UserDto>(key, '/users', {
      method: 'POST',
      body:
        planId === undefined
          ? { external_id: externalId }
          : { external_id: externalId, plan_id: planId },
    });
  }

  getUser(key: string, userId: string): Promise<ApiResult<UserDto>> {
    return this.call<UserDto>(key, `/users/${userId}`);
  }

  patchUserPlan(key: string, userId: string, planId: string): Promise<ApiResult<UserDto>> {
    return this.call<UserDto>(key, `/users/${userId}`, {
      method: 'PATCH',
      body: { plan_id: planId },
    });
  }

  listUsers(key: string): Promise<ApiResult<{ items: UserDto[] }>> {
    return this.call<{ items: UserDto[] }>(key, '/users');
  }

  createPlan(
    key: string,
    name: string,
    scope: 'account' | 'user',
    rules: Record<string, number>,
  ): Promise<ApiResult<PlanDto>> {
    return this.call<PlanDto>(key, '/plans', { method: 'POST', body: { name, scope, rules } });
  }

  patchPlan(
    key: string,
    planId: string,
    body: { name?: string; rules?: Record<string, number> },
  ): Promise<ApiResult<PlanDto>> {
    return this.call<PlanDto>(key, `/plans/${planId}`, { method: 'PATCH', body });
  }

  listPlans(key: string, scope?: 'account' | 'user'): Promise<ApiResult<{ items: PlanDto[] }>> {
    return this.call<{ items: PlanDto[] }>(key, `/plans${queryString({ scope })}`);
  }

  consume(
    key: string,
    userId: string,
    requestId: string,
    units: number,
  ): Promise<ApiResult<ConsumeDecisionDto>> {
    return this.call<ConsumeDecisionDto>(key, '/consume', {
      method: 'POST',
      body: { user_id: userId, request_id: requestId, units },
    });
  }

  getAccountUsage(key: string, month?: string): Promise<ApiResult<UsageDto>> {
    return this.call<UsageDto>(key, `/usage${queryString({ month })}`);
  }

  getUserUsage(key: string, userId: string, month?: string): Promise<ApiResult<UsageDto>> {
    return this.call<UsageDto>(key, `/users/${userId}/usage${queryString({ month })}`);
  }

  listHistory(
    key: string,
    filters: {
      limit?: number;
      cursor?: string;
      user_id?: string;
      month?: string;
      outcome?: 'accepted' | 'rejected';
    } = {},
  ): Promise<ApiResult<HistoryPageDto>> {
    const { limit, cursor, user_id, month, outcome } = filters;
    return this.call<HistoryPageDto>(
      key,
      `/history${queryString({ limit, cursor, user_id, month, outcome })}`,
    );
  }

  listUserHistory(
    key: string,
    userId: string,
    limit?: number,
    cursor?: string,
  ): Promise<ApiResult<HistoryPageDto>> {
    return this.call<HistoryPageDto>(
      key,
      `/users/${userId}/history${queryString({ limit, cursor })}`,
    );
  }
}
