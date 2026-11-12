# tailnet-artifacts server image. See deploy/docker/ for a Compose file with a Tailscale sidecar.
FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/vladgurovich/tailnet-artifacts" \
      org.opencontainers.image.description="Self-hosted, versioned artifact links for AI agents over Tailscale" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bin ./bin
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production \
    ARTIFACTS_DATA_DIR=/data \
    ARTIFACTS_HOST=127.0.0.1 \
    ARTIFACTS_PORT=8790
VOLUME /data
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.ARTIFACTS_PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node", "/app/bin/tailnet-artifacts.js"]
CMD ["serve"]
