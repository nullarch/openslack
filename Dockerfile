# Build: the server bundled into one file, plus the web client.
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm release

# Run: no dependencies to install, one process, one data directory.
FROM node:24-alpine
WORKDIR /app
COPY --from=build /src/packages/cli/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.mjs"]
