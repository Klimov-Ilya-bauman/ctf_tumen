FROM node:26 AS ui-deps
WORKDIR /src/web/frontend/ui
COPY web/frontend/ui/package.json web/frontend/ui/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM ui-deps AS ui-source
COPY api/openapi.yaml /src/api/openapi.yaml
COPY proto/testdata /src/proto/testdata
COPY web/frontend/ui/ ./
RUN npm run gen:api

FROM ui-source AS ui-build
RUN npm run build

FROM ui-source AS ui-test
RUN npx tsc --noEmit
RUN npm run lint
RUN npm test
RUN npm run build && touch /tmp/ui-test-passed

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
COPY --chmod=0644 web/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=ui-build /src/web/frontend/ui/dist/ /usr/share/nginx/html/
USER 101
EXPOSE 8080

FROM runtime AS test
COPY --from=ui-test /tmp/ui-test-passed /tmp/ui-test-passed
RUN nginx -t
