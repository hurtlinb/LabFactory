FROM node:20-bullseye AS deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-bullseye
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=deps /usr/src/app/package*.json ./
# dashboard/server.js importe depuis ../config, ../lib et ../db/migrations
COPY dashboard ./dashboard
COPY config ./config
COPY lib ./lib
COPY db ./db
ARG BUILD_TAG
ENV NODE_ENV=production
ENV BUILD_TAG=${BUILD_TAG}
CMD ["node", "dashboard/server.js"]
