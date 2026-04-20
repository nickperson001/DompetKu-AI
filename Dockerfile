# ════════════════════════════════════════════════════════════
# DompetKu — Dockerfile
# Node 20 Slim + Chromium untuk whatsapp-web.js / Puppeteer
# ════════════════════════════════════════════════════════════
FROM node:20-slim

# Install Chromium + semua dependency sistem yang diperlukan
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
    fonts-noto-color-emoji \
    wget \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Beritahu Puppeteer untuk tidak download Chromium sendiri,
# gunakan Chromium sistem yang sudah diinstall di atas
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXEC_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Copy package files dulu agar layer npm install ter-cache
COPY package*.json ./

# Install dependencies production only
RUN npm install --production --no-audit --no-fund

# Copy seluruh source code (termasuk public/)
COPY public/ ./public
COPY src/ ./src


# Verifikasi file-file kritis ada — build GAGAL jika tidak ada
# Ini mencegah deploy dengan file yang kurang
RUN echo "=== Verifikasi file ===" \
    && test -f public/index.html          || (echo "MISSING: public/index.html"          && exit 1) \
    && test -f public/login.html          || (echo "MISSING: public/login.html"          && exit 1) \
    && test -f src/config/supabase.js     || (echo "MISSING: src/config/supabase.js"     && exit 1) \
    && test -f src/handlers/message.js    || (echo "MISSING: src/handlers/message.js"    && exit 1) \
    && test -f src/jobs/scheduler.js      || (echo "MISSING: src/jobs/scheduler.js"      && exit 1) \
    && test -f src/utils/stockManager.js  || (echo "MISSING: src/utils/stockManager.js"  && exit 1) \
    && test -f src/utils/mediaProcessor.js|| (echo "MISSING: src/utils/mediaProcessor.js"&& exit 1) \
    && echo "=== Semua file OK ==="

# Tampilkan isi public/ untuk konfirmasi saat build
RUN echo "=== Isi public/ ===" && ls -la public/

# Buat folder tmp yang diperlukan runtime
RUN mkdir -p /tmp/wa-session /tmp/wa-version-cache \
    && chmod 777 /tmp/wa-session /tmp/wa-version-cache

EXPOSE 3000

# Docker healthcheck — cek setiap 30 detik
# start-period 90 detik: beri waktu Chromium startup
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
    CMD wget -qO- http://localhost:3000/ping || exit 1

CMD ["node", "index.js"]