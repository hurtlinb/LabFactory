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
ENV NODE_ENV=production
ENV BUILD_TAG=${BUILD_TAG}
CMD ["node", "dashboard/server.js"]
