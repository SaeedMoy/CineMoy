# Server for web/TV use (PC, NAS, Raspberry Pi). Includes ffmpeg for compatibility mode.
FROM node:22-alpine
# Optional mirrors for networks where the default ones are filtered or flaky, e.g.
#   --build-arg APK_MIRROR=https://mirror.arvancloud.ir/alpine   (NPM_REGISTRY works the same way for npm)
ARG APK_MIRROR=
ARG NPM_REGISTRY=
RUN if [ -n "$APK_MIRROR" ]; then sed -i -E "s#https?://dl-cdn.alpinelinux.org/alpine#${APK_MIRROR%/}#" /etc/apk/repositories; fi; \
    for i in 1 2 3; do apk add --no-cache ffmpeg && exit 0; echo "apk failed, retrying ($i)"; sleep $((i * 5)); done; exit 1
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
    npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY web ./web
ENV PORT=7070 HOST=0.0.0.0 CINEMOY_TORRENT_PORT=6881 CINEMOY_CACHE=/cache/torrents
EXPOSE 7070 6881/tcp 6881/udp
# Linux: `docker run --network host` is best. Elsewhere (Docker Desktop on macOS/Windows) publish
# the torrent port too, or peers can't connect in: see docker-compose.yml.
CMD ["node", "server/index.js"]
