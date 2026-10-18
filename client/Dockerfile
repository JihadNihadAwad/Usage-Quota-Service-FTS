# ---- build stage: compile the demo client ---------------------------------
# The client imports one module from src/ (the predefined plan ids), so the
# build needs a slice of src plus the client tree. src/domain is copied only
# so tsc can resolve predefined.ts's type-only Rules import - the emitted
# predefined.js has no runtime imports from it.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.client.json ./
COPY client ./client
COPY src/db/predefined.ts ./src/db/predefined.ts
COPY src/domain ./src/domain
RUN npm run build:client

# ---- runtime stage ---------------------------------------------------------
# Compiled output mirrors the source tree (dist-client/client/... +
# dist-client/src/db/...), so the relative imports resolve as-is. Static
# assets are copied to /app/public and pointed at via STATIC_DIR.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV STATIC_DIR=/app/public
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist-client ./dist-client
COPY client/public ./public
USER node
EXPOSE 3001
CMD ["node", "dist-client/client/server.js"]
