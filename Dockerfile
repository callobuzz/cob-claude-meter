# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Drop dev dependencies so the runtime layer only carries what it needs.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app

# Day boundaries are computed in local time. Alpine ships no timezone database,
# so without tzdata a TZ like Asia/Kolkata silently resolves to UTC and evening
# work lands on the wrong calendar day.
RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    CLAUDE_METER_LOG_PATHS=/logs \
    CLAUDE_METER_DATA_DIR=/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY data ./data

# Session logs are mounted read-only; /data holds tags + the scan cache.
RUN mkdir -p /data /logs && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node dist/cli.js serve --host \"$HOST\" --port \"$PORT\" --data-dir \"$CLAUDE_METER_DATA_DIR\""]
