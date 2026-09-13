# Production image for Cloudflare Containers (which run linux/amd64).
#
# The app runs as a plain `next start` server rather than on Workers, because
# the server-side image pipeline uses native and WASM Node packages — sharp
# (libvips), potrace and rhino3dm — that cannot load in the Workers runtime.
# cloudflare/worker.ts forwards every request to this container.

FROM --platform=linux/amd64 node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM --platform=linux/amd64 node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/package.json /app/next.config.ts ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
