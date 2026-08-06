# FreeGLMKimiAPI — https://github.com/ForgetMeAI/FreeGLMKimiAPI
FROM node:22-bookworm-slim

# The proxy drives a real browser for the Z.ai/GLM browser-fallback login flow
# and anti-bot handling (playwright-core, puppeteer-core, puppeteer-extra +
# stealth plugin, cloakbrowser). None of these packages bundle their own
# Chromium build ("-core" packages never auto-download), so we install one
# system-wide and point every relevant env var at it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    tini \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium \
    ZAI_BROWSER_ENGINE=cloak

WORKDIR /app

# Install deps once at build time so the image works standalone even if you
# don't mount a persistent node_modules volume. NOT using --omit=dev here:
# this repo's browser-fallback packages (puppeteer-extra, stealth plugin,
# cloakbrowser) are needed at runtime for the Z.ai/Kimi fallback path even
# though some are listed under devDependencies upstream.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Now bring in the rest of the source
COPY . .

# auth.json, .env overrides, and the persistent Z.ai browser profile all live
# under /app/data so they survive image rebuilds via a bind/volume mount.
RUN mkdir -p /app/data

# If /app/node_modules is bind-mounted from the host (recommended — see
# docker-compose.yml), this entrypoint skips `npm ci` on every container
# restart/NAS reboot and only reinstalls when package.json/lock/Node/arch
# actually changed. First boot after mounting an empty volume still installs
# once and writes the sentinel.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3364 \
    HOST=0.0.0.0 \
    AUTH_PATH=/app/data/auth.json \
    ZAI_BROWSER_PROFILE_DIR=/app/data/zai-browser-profile

EXPOSE 3364

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3364) +'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
