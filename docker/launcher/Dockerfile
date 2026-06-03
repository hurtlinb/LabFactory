FROM node:20-bullseye AS builder
WORKDIR /usr/src/app
COPY package*.json tsconfig.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bullseye
WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/db ./db
COPY --from=builder /usr/src/app/package*.json ./
RUN npm install --production
ENV NODE_ENV=production
CMD ["npm", "run", "start:launcher"]
