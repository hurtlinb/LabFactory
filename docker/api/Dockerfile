FROM node:24-bookworm AS builder
WORKDIR /usr/src/app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm
WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/db ./db
COPY --from=builder /usr/src/app/package*.json ./
RUN npm ci --omit=dev
RUN node --input-type=module -e "await import('@kubernetes/client-node')"
ENV NODE_ENV=production
CMD ["npm", "run", "start:api"]
