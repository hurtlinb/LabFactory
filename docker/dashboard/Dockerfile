FROM node:20-bullseye AS deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-bullseye
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=deps /usr/src/app/package*.json ./
COPY dashboard ./dashboard
ENV NODE_ENV=production
CMD ["node", "dashboard/server.js"]
