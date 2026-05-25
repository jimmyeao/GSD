# LÖVE runner with KasmVNC (video + audio over WebSocket).
#
# KasmVNC is a fork of TigerVNC with a built-in websockified web client
# that handles BOTH video and PulseAudio audio on the same WS connection.
# It replaces the x11vnc + novnc + websockify trio from v1.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Pre-create the manpage path so Ubuntu 24.04's broken `love` postinst
# doesn't abort the build (see docs/gotchas.md).
RUN mkdir -p /usr/share/man/man6 \
 && touch /usr/share/man/man6/love-11.5.6.gz

# Base runtime: game engine, virtual display deps, audio stack, fonts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      love \
      xvfb \
      x11-utils \
      xauth \
      pulseaudio pulseaudio-utils \
      fonts-dejavu-core fonts-liberation \
      ca-certificates curl wget \
      procps \
      ssl-cert openssl \
 && rm -rf /var/lib/apt/lists/*

# KasmVNC expects /etc/ssl/private/ssl-cert-snakeoil.key to exist even when
# SSL is disabled. The ssl-cert package's postinst normally creates it via
# make-ssl-cert, but the hook is skipped in minimal Docker builds. Generate
# one explicitly so kasmvncserver doesn't bail on startup.
RUN install -d -m 0750 -o root -g ssl-cert /etc/ssl/private \
 && [ -f /etc/ssl/private/ssl-cert-snakeoil.key ] || \
      openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
        -keyout /etc/ssl/private/ssl-cert-snakeoil.key \
        -out    /etc/ssl/certs/ssl-cert-snakeoil.pem \
        -subj "/CN=alice-love-runner" \
 && chmod 0640 /etc/ssl/private/ssl-cert-snakeoil.key \
 && chgrp ssl-cert /etc/ssl/private/ssl-cert-snakeoil.key

# Install KasmVNC. Version pinned so the build stays reproducible; bump when
# you want a newer KasmVNC (release list: github.com/kasmtech/KasmVNC/releases).
ARG KASM_VERSION=1.4.0
# Release asset naming is kasmvncserver_<distro>_<version>_<arch>.deb —
# NOT <version>_<distro>_<arch>. Getting this order wrong is a 404.
RUN wget -q -O /tmp/kasmvnc.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASM_VERSION}/kasmvncserver_noble_${KASM_VERSION}_arm64.deb" \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
 && rm /tmp/kasmvnc.deb \
 && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user — KasmVNC refuses to start as root.
# Ubuntu 24.04's base image ships a default `ubuntu` user at UID 1000, so
# we delete it first to keep `kasm` at UID 1000 (matches host UID for
# workspace bind-mount file permissions).
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd -m -s /bin/bash -u 1000 -G ssl-cert kasm \
 && mkdir -p /home/kasm/.vnc \
 && chown -R kasm:kasm /home/kasm

ENV LOVE_DIR=/workspace
ENV KASMVNC_PORT=6080
ENV SCREEN_SIZE=1024x768
# Tell SDL (LÖVE's audio backend) to use PulseAudio running inside the container.
ENV SDL_AUDIODRIVER=pulseaudio
ENV SDL_VIDEODRIVER=x11

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

USER kasm
WORKDIR /home/kasm
EXPOSE 6080

CMD ["/usr/local/bin/start.sh"]
