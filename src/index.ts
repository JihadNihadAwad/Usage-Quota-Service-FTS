import { loadEnv } from './config/env.js';
import { createApp } from './http/server.js';
import { logger, setLogLevel } from './lib/logger.js';

// Dev entry (`npm run dev`). Containers use src/start.ts instead: it
// applies migrations and seeds before listening, so a container is
// self-initializing.
const env = loadEnv();
setLogLevel(env.LOG_LEVEL);
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('api listening', { port: env.PORT, logLevel: env.LOG_LEVEL });
});

const shutdown = (signal: string) => {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
