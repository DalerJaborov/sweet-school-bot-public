FROM node:22-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true CHROMIUM_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
# WA Web 2.3000.105x: media sends crash inside whatsapp-web.js 1.34.7 until upstream ships the fix (see patch-wwebjs.cjs).
COPY patch-wwebjs.cjs ./
RUN node patch-wwebjs.cjs
COPY bridge.cjs server.cjs ./
RUN mkdir -p /data/auth /data/state && chown -R node:node /data /app
USER node
EXPOSE 4200
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.cjs"]
