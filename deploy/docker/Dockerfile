FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DEVMATE_BIND_HOST=0.0.0.0

WORKDIR /opt/devmate
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config-file-lock.cjs ./
COPY gateway ./gateway
COPY shared ./shared
COPY scripts ./scripts

RUN mkdir -p /var/lib/devmate /srv/devmate-workspaces \
  && chown -R node:node /opt/devmate /var/lib/devmate /srv/devmate-workspaces

USER node
EXPOSE 8787
VOLUME ["/var/lib/devmate", "/srv/devmate-workspaces"]
ENTRYPOINT ["node", "/opt/devmate/scripts/devmate-cli.mjs"]
CMD ["serve", "--config", "/var/lib/devmate/config.json"]
