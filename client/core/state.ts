// Per-run demo state, held SERVER-SIDE (client/server.ts). The API key never
// reaches the browser - only its display prefix does. A new run (Setup, or
// Run all) resets the state and bootstraps a fresh account.

export interface DemoState {
  /** Unique per setup run - prefixes every request_id so replays stay
   *  meaningful within a run and never collide across runs. */
  runId: string;
  apiKey: string | null;
  accountId: string | null;
  aliceUserId: string | null;
  bobUserId: string | null;
  customPlanId: string | null;
  /** Monotonic counter for per-click request ids (scenario 6 reuses its own). */
  callSeq: number;
}

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function freshState(): DemoState {
  return {
    runId: newRunId(),
    apiKey: null,
    accountId: null,
    aliceUserId: null,
    bobUserId: null,
    customPlanId: null,
    callSeq: 0,
  };
}
