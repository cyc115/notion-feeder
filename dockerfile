# syntax=docker/dockerfile:1
# Base image pinned to an explicit minor (homelab CLAUDE.md rule 6 — no floating
# tags). Replaces mhart/alpine-node:16, which is EOL and unmaintained since 2022.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json webpack.config.cjs ./
COPY src ./src
# `npm i` masked build failures because the original used `;` between commands;
# `&&` makes a failed install fail the image build.
RUN npm install && npm run build-prod

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist/index.js /app/index.js
# Run as the image's built-in unprivileged user (homelab CLAUDE.md rule 7).
USER node
CMD ["node", "index.js"]
