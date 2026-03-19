FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/src/config/tasks.json ./src/config/tasks.json

RUN mkdir -p /app/logs \
  && chown -R node:node /app/logs /app/src/config

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
