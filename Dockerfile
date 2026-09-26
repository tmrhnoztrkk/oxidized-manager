# Oxidized Manager = the official Oxidized image + a web UI / API that supervises it.
# The embedded Oxidized runs as a child process of the manager (the image's runit services are not used).
ARG OXIDIZED_VERSION=latest
FROM docker.io/oxidized/oxidized:${OXIDIZED_VERSION}

LABEL org.opencontainers.image.title="Oxidized Manager" \
      org.opencontainers.image.description="Multi-workspace web UI for Oxidized: device management, sharing, git backup destinations" \
      org.opencontainers.image.licenses="Apache-2.0"

USER root
# git + openssh-client are used by backup destinations (git push over HTTPS / SSH)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates git openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/oxmgr
COPY requirements.txt .
RUN python3 -m venv /opt/oxmgr/venv \
 && /opt/oxmgr/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static
COPY docker-entrypoint.sh /usr/local/bin/oxmgr-entrypoint
RUN chmod 0755 /usr/local/bin/oxmgr-entrypoint && mkdir -p /data && chown oxidized:oxidized /data

ENV DATA_DIR=/data \
    HOME=/home/oxidized \
    LANG=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=5 \
  CMD /opt/oxmgr/venv/bin/python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/oxmgr-entrypoint"]
