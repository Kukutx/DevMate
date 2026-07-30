FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/devmate
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY gateway ./gateway
COPY scripts ./scripts
COPY extension.js extension-entry-platform.js extension-entry-win32.js extension-entry.js ngrok-launch-compat.js ngrok-support.js tunnel-provider.js ./

RUN mkdir -p /var/lib/devmate /srv/devmate-workspaces \
  && chown -R node:node /opt/devmate /var/lib/devmate /srv/devmate-workspaces

USER node
EXPOSE 8787
VOLUME ["/var/lib/devmate", "/srv/devmate-workspaces"]
ENTRYPOINT ["node", "/opt/devmate/scripts/devmate-cli.mjs"]
CMD ["serve", "--config", "/var/lib/devmate/config.json"]
