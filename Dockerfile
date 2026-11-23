FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Pin yt-dlp to a specific release to avoid unexpected breakage on redeploy
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/2025.06.09/yt-dlp \
      -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp

RUN pip3 install --no-cache-dir --break-system-packages \
      yt-dlp-get-pot bgutil-ytdlp-pot-provider

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p work clips uploads && chown -R node:node /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
