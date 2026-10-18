// The demo web server. Serves the static page and executes scenarios
// server-side: the browser never sees the API key - it lives in this
// process's DemoState, and only the key PREFIX is ever rendered.
//
// The demo tool itself is intentionally unauthenticated (localhost /
// compose-network convenience); it is NOT part of the
// service's trust boundary. The usage API behind it does all real auth.

import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import { UsageApi } from './core/api.js';
import { SCENARIO_COUNT, runScenario, scenarioCatalog } from './core/scenarios.js';
import { freshState, type DemoState } from './core/state.js';

const PORT = Number(process.env.CLIENT_PORT ?? 3001);
const USAGE_API_URL = process.env.USAGE_API_URL ?? 'http://localhost:3000/v1';

const state: DemoState = freshState();
const api = new UsageApi(USAGE_API_URL);

const app = express();
app.disable('x-powered-by');

// Static dir: STATIC_DIR lets the container point at the copied assets;
// dev falls back to the source tree next to this file.
const publicDir = process.env.STATIC_DIR ?? fileURLToPath(new URL('./public', import.meta.url));
app.use(express.static(publicDir));

// Scenario catalog + current run status for the page.
app.get('/api/scenarios', (_req, res) => {
  res.json({
    scenarios: scenarioCatalog(),
    setup: state.apiKey !== null,
    runId: state.runId,
    apiUrl: USAGE_API_URL,
  });
});

// Execute one scenario against the current run state. Never returns the key.
app.post('/api/scenario/:number', async (req, res) => {
  const n = Number(req.params.number);
  if (!Number.isInteger(n) || n < 1 || n > SCENARIO_COUNT) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such scenario' } });
    return;
  }
  const result = await runScenario({ api, state }, n);
  res.json(result);
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[client] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'demo server error' } });
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`[client] demo ui on http://localhost:${PORT} (usage api: ${USAGE_API_URL})`);
});
