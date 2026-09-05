ARG BASE_IMAGE=registry.gitlab.steamos.cloud/steamrt/sniper/platform:latest
FROM node:24-bookworm-slim AS dependencies
WORKDIR /opt/cs2kz
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM ${BASE_IMAGE} AS runtime
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl lib32gcc-s1 lib32stdc++6 tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10000 cs2kz \
    && useradd -u 10000 -g 10000 -m -d /home/cs2kz cs2kz \
    && mkdir -p /server /state /opt/steamcmd /run/cs2kz \
    && curl --fail --location --retry 5 --proto '=https' --proto-redir '=https' \
        https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd.tar.gz \
    && tar -xzf /tmp/steamcmd.tar.gz -C /opt/steamcmd \
    && rm /tmp/steamcmd.tar.gz \
    && chown -R 10000:10000 /server /state /opt/steamcmd /run/cs2kz
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /opt/cs2kz/node_modules /opt/cs2kz/node_modules
COPY runtime/ /opt/cs2kz/
COPY --chmod=755 runtime/cs2kz /usr/local/bin/cs2kz
COPY pterodactyl/egg-cs2kz.json /opt/cs2kz/egg-cs2kz.json

FROM runtime AS pterodactyl
USER root
RUN groupadd -g 1000 container \
    && useradd -u 1000 -g 1000 -m -d /home/container -s /bin/bash container
COPY config/settings.json /opt/cs2kz/defaults/settings.json
COPY examples/config/server.cfg /opt/cs2kz/defaults/server.cfg
RUN node -e 'const fs = require("node:fs"); const p = "/opt/cs2kz/defaults/settings.json"; const data = JSON.parse(fs.readFileSync(p)); data.maintenance.interval_hours = 0; fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n")'
ENV USER=container HOME=/home/container PTERODACTYL=1 \
    SERVER_DIR=/home/container STATE_DIR=/home/container/.cs2kz/state \
    CONFIG_DIR=/home/container/.cs2kz/config STEAMCMD_DIR=/home/container/.cs2kz/steamcmd \
    CONTROL_SOCKET=/tmp/cs2kz/control.sock
USER container
WORKDIR /home/container
EXPOSE 27015/udp
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "cs2kz", "pterodactyl"]

FROM runtime AS standalone
ENV HOME=/home/cs2kz
USER 10000:10000
WORKDIR /server
EXPOSE 27015/udp
HEALTHCHECK --start-period=30m --interval=30s --timeout=5s --retries=3 CMD ["cs2kz", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "cs2kz", "start"]
