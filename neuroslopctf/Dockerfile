FROM node:26-alpine AS build
RUN npm install -g pnpm@12.9.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/thingamajig/package.json packages/thingamajig/
COPY apps/server/package.json apps/server/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json turbo.json ./
COPY packages packages
COPY apps apps
RUN pnpm -r run build \
    && pnpm --filter @backend/server deploy --prod --legacy /out

FROM node:26-alpine AS runtime
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /out/ apps/server/
COPY --from=build --chown=node:node /app/apps/frontend/dist/ apps/frontend/dist/
RUN mkdir -p /data/attachments && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
