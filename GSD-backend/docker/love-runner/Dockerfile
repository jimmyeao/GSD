# LÖVE game runner with noVNC access.
#
# Starts an Xvfb virtual display, runs the LÖVE game from /workspace,
# exposes the display via x11vnc, and serves noVNC+websockify on port 6080.
#
# Usage: the GSD backend builds this image on demand and launches a
# container per LÖVE run, bind-mounting the project at /workspace.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Ubuntu 24.04's `love` package has a broken postinst that references a
# manpage (love-11.5.6.gz) the deb doesn't actually ship. Pre-create it so
# update-alternatives doesn't fail and block the whole image build.
RUN mkdir -p /usr/share/man/man6 \
 && touch /usr/share/man/man6/love-11.5.6.gz

# Core set: love + virtual display + VNC server + noVNC bridge.
# A minimal window manager (fluxbox) so LÖVE's window gets a frame/focus.
# Audio packages deliberately skipped — v1 is video-only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      love \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      fluxbox \
      x11-utils \
      python3 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Fonts so LÖVE's default text isn't blank squares.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:99
ENV LOVE_DIR=/workspace
ENV NOVNC_PORT=6080
ENV VNC_PORT=5900
ENV SCREEN_SIZE=1024x768x24
# Force SDL (used by LÖVE) to a dummy audio driver — no ALSA/PulseAudio in
# the container, and LÖVE bails out if it tries to open a real device.
ENV SDL_AUDIODRIVER=dummy
ENV SDL_VIDEODRIVER=x11

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 6080

CMD ["/usr/local/bin/start.sh"]
