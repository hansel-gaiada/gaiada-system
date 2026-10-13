# One image for the whole harness: the daemons under test, the HTTPS static server and the client.
# Debian bookworm carries lftp 4.9.2, the same major line as the ubuntu runner's apt package.
FROM debian:bookworm-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server openssh-client vsftpd nginx-light lftp curl jq openssl ca-certificates \
      procps coreutils findutils iproute2 \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/harness/daemon.sh"]
