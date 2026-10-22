# ---- build stage: compile the TypeScript service --------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: only compiled code + prod deps ------------------------
# Multi-stage keeps the runner small (no dev toolchain, no sources); the
# container runs as the non-root 'node' user; prod deps only.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# tsc does not copy the committed SQL migrations - bring them (and the
# drizzle meta journal) along for the programmatic migrator at startup.
# The post-benchmark invariant checker also runs in this container (node
# type-strips .ts natively), over the compose network - the benchmark flow
# never needs a host-published db port.
COPY --from=build /app/src/db/migrations ./dist/db/migrations
COPY performance/check-invariants.ts ./tools/check-invariants.ts
USER node
EXPOSE 3000
CMD ["node", "dist/start.js"]
