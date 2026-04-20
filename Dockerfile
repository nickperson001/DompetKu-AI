FROM node:20-slim

# Install Chromium dan semua dependency sistem
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libxss1 \
    libgtk-3-0 \
    libxshmfence1 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    fonts-liberation \
    wget \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXEC_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Copy package dulu — layer npm install ter-cache
COPY package.json ./

# Install dependencies
RUN npm install --production --no-audit --no-fund

# Copy SEMUA file project ke /app
COPY . .

# Debug: tampilkan isi saat build untuk konfirmasi
RUN echo "=== /app ===" && ls -la \
    && echo "=== /app/public ===" && ls -la public/ \
    && echo "=== /app/src ===" && ls -la src/

# Verifikasi setiap file kritis — build GAGAL jika ada yang kurang
RUN test -f index.js                     || (echo "MISSING: index.js"                     && exit 1)
RUN test -f public/index.html            || (echo "MISSING: public/index.html"            && exit 1)
RUN test -f public/login.html            || (echo "MISSING: public/login.html"            && exit 1)
RUN test -f src/config/supabase.js       || (echo "MISSING: src/config/supabase.js"       && exit 1)
RUN test -f src/handlers/message.js      || (echo "MISSING: src/handlers/message.js"      && exit 1)
RUN test -f src/jobs/scheduler.js        || (echo "MISSING: src/jobs/scheduler.js"        && exit 1)
RUN test -f src/utils/stockManager.js    || (echo "MISSING: src/utils/stockManager.js"    && exit 1)
RUN test -f src/utils/mediaProcessor.js  || (echo "MISSING: src/utils/mediaProcessor.js"  && exit 1)
RUN echo "=== Semua file OK ==="

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
    CMD wget -qO- http://localhost:3000/ping || exit 1

CMD ["node", "index.js"]
