ARG BASE_IMAGE=registry.gitlab.steamos.cloud/steamrt/sniper/platform:latest
FROM ${BASE_IMAGE} AS runtime
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 lib32gcc-s1 lib32stdc++6 tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10000 cs2kz \
    && useradd -u 10000 -g 10000 -m -d /home/cs2kz cs2kz \
    && mkdir -p /server /state /opt/steamcmd /run/cs2kz \
    && curl --fail --location --retry 5 --proto '=https' --proto-redir '=https' \
        https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd.tar.gz \
    && tar -xzf /tmp/steamcmd.tar.gz -C /opt/steamcmd \
    && rm /tmp/steamcmd.tar.gz \
    && chown -R 10000:10000 /server /state /opt/steamcmd /run/cs2kz
COPY runtime/ /opt/cs2kz/
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

FROM runtime AS pterodactyl
USER root
RUN groupadd -g 1000 container \
    && useradd -u 1000 -g 1000 -m -d /home/container -s /bin/bash container
COPY config/settings.json /opt/cs2kz/defaults/settings.json
COPY examples/config/server.cfg /opt/cs2kz/defaults/server.cfg
RUN python3 -c 'import json; from pathlib import Path; p = Path("/opt/cs2kz/defaults/settings.json"); data = json.loads(p.read_text()); data["maintenance"]["interval_hours"] = 0; p.write_text(json.dumps(data, indent=2) + "\n")'
ENV USER=container HOME=/home/container PTERODACTYL=1 \
    SERVER_DIR=/home/container STATE_DIR=/home/container/.cs2kz/state \
    CONFIG_DIR=/home/container/.cs2kz/config STEAMCMD_DIR=/home/container/.cs2kz/steamcmd \
    CONTROL_SOCKET=/tmp/cs2kz/control.sock
USER container
WORKDIR /home/container
EXPOSE 27015/udp
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "python3", "/opt/cs2kz/pterodactyl.py"]

FROM runtime AS standalone
ENV HOME=/home/cs2kz
USER 10000:10000
WORKDIR /server
EXPOSE 27015/udp
HEALTHCHECK --start-period=30m --interval=30s --timeout=5s --retries=3 CMD ["python3", "/opt/cs2kz/control.py", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/opt/cs2kz/server.py"]
