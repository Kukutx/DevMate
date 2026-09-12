FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DEVMATE_BIND_HOST=0.0.0.0

WORKDIR /opt/devmate
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config-file-lock.cjs ./
COPY tunnel-provider.js ./
COPY gateway ./gateway
COPY host ./host
COPY shared ./shared
COPY scripts ./scripts
COPY vscode-host/shared-tunnel-record-store.js ./vscode-host/shared-tunnel-record-store.js
COPY vscode-host/tunnel-settings.js ./vscode-host/tunnel-settings.js

RUN mkdir -p /var/lib/devmate /srv/devmate-workspaces \
  && chown -R node:node /opt/devmate /var/lib/devmate /srv/devmate-workspaces

USER node
EXPOSE 8787
VOLUME ["/var/lib/devmate", "/srv/devmate-workspaces"]
ENTRYPOINT ["node", "/opt/devmate/scripts/devmate-command.mjs"]
CMD ["serve", "--config", "/var/lib/devmate/config.json"]
