ARG SFTP_BASE_IMAGE=debian:bookworm-slim
FROM ${SFTP_BASE_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && groupadd -g 10000 game \
    && useradd -u 10000 -g 10000 -d /files -s /usr/sbin/nologin game \
    && passwd -d game \
    && mkdir -p /srv/jail/files /hostkeys /run/sshd
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
EXPOSE 2222
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
