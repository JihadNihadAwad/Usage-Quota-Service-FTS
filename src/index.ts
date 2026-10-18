import { loadEnv } from './config/env.js';
import { createApp } from './http/server.js';

// Dev entry (`npm run dev`); src/start.ts is the container entrypoint:
// migrate → seed → listen, all in one process.
const env = loadEnv();
const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT} (log level: ${env.LOG_LEVEL})`);
});

const shutdown = (signal: string) => {
  console.log(`[api] ${signal} received, closing`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
