# syntax=docker/dockerfile:1
#
# Container image for Second Brain — Docker Space (or any Docker host).
#
# Two stages: the builder needs the dev dependencies to run `next build`, the
# runner only carries the standalone server that `output: "standalone"` emits,
# so the final image has no toolchain and no full dependency tree.
#
# Hugging Face routes traffic to the Space's `app_port` (7860 unless the Space
# README says otherwise), hence PORT below.

FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=7860 \
    HOSTNAME=0.0.0.0 \
    SB_DATA_DIR=/data

# The memory lives outside the image layer. On a Space this directory is
# ephemeral: it resets whenever the Space restarts or is paused.
RUN mkdir -p /data

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 7860
CMD ["node", "server.js"]
