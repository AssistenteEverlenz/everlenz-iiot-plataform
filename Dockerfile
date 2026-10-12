FROM node:26-bookworm-slim AS base
WORKDIR /app
RUN npm install -g pnpm@10.28.2 && pnpm config set store-dir /pnpm/store
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/ingestor/package.json apps/ingestor/package.json
COPY apps/simulator/package.json apps/simulator/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/adapters/package.json packages/adapters/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENV IIOT_LOAD_ENV=false NEXT_TELEMETRY_DISABLED=1

FROM base AS service-build
RUN pnpm --filter @iiot/api --filter @iiot/ingestor --filter @iiot/simulator --filter @iiot/database build
RUN pnpm --filter @iiot/api deploy --prod --offline /out/api \
 && pnpm --filter @iiot/ingestor deploy --prod --offline /out/ingestor \
 && pnpm --filter @iiot/database deploy --prod --offline /out/database

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
USER node
FROM runtime AS api
ENV SERVICE_NAME=api API_HOST=0.0.0.0
COPY --from=service-build --chown=node:node /out/api ./
EXPOSE 3001
CMD ["node","dist/index.js"]
FROM runtime AS ingestor
ENV SERVICE_NAME=ingestor
COPY --from=service-build --chown=node:node /out/ingestor ./
EXPOSE 3002
CMD ["node","dist/index.js"]
FROM runtime AS database-tools
ENV SERVICE_NAME=database
COPY --from=service-build --chown=node:node /out/database ./
CMD ["node","dist/status.js"]

# Preserved development target; never used by the production Compose.
FROM service-build AS services
USER node
CMD ["node","apps/api/dist/index.js"]

FROM base AS web-build
RUN pnpm --filter @iiot/web build
FROM runtime AS web
ENV SERVICE_NAME=web HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# The standalone server serves public/ from next to server.js but does not copy it itself
# (the Everlenz fallback tab icon lives there).
COPY --from=web-build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --chown=node:node apps/web/production.mjs ./production.mjs
EXPOSE 3000
CMD ["node","production.mjs"]
