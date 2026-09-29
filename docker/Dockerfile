# Build from the repo root:  docker build -f docker/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# supercronic runs the daily schedule inside the container (see docker/crontab)
RUN apk add --no-cache supercronic tzdata
# Mountain time, as the Windows task ran: the crontab times and report dates follow it
ENV TZ=America/Denver \
    NODE_ENV=production \
    LOG_TO_STDOUT=1 \
    OLLAMA_URL=http://host.docker.internal:11434
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/crontab ./crontab
# Cached data, reports, site output, and OCR logs all live under the working directory
RUN mkdir -p data reports output formatted-reports logs && chown -R node:node /app
USER node
# Runs until stopped. One-off commands: docker exec outlier-caucus node dist/index.js <command>
CMD ["supercronic", "/app/crontab"]
