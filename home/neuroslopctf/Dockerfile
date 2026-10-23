FROM node:26-alpine

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
RUN pnpm -r run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "apps/server/dist/main.js"]
