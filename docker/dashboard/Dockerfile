FROM node:24-bookworm AS deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=deps /usr/src/app/package*.json ./
# dashboard/server.js importe depuis ../config, ../lib et ../db/migrations
COPY dashboard ./dashboard
COPY config ./config
COPY lib ./lib
COPY ansible/collections.json ./ansible/collections.json
COPY db ./db
RUN node --input-type=module -e "await import('./lib/ansibleTasks.js'); await import('@kubernetes/client-node')"
COPY CHANGELOG.md ./
ARG BUILD_TAG
# Version computed from the git tags by the dev build (empty otherwise: package.json is used).
ARG APP_VERSION
ENV NODE_ENV=production
ENV BUILD_TAG=${BUILD_TAG}
ENV APP_VERSION=${APP_VERSION}
CMD ["node", "dashboard/server.js"]
