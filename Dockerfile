# ════════════════════════════════════════════════════════════
# DompetKu — Dockerfile
# Base: Node 20 + Chromium untuk Puppeteer/whatsapp-web.js
# ════════════════════════════════════════════════════════════

FROM node:20-slim

# Install Chromium dan dependency sistem yang diperlukan Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxss1 \
    libgtk-3-0 \
    libxshmfence1 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    fonts-liberation \
    fonts-noto \
    wget \
    ca-certificates \
    --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set env Puppeteer agar tidak download Chromium sendiri
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXEC_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium

# Working directory
WORKDIR /app

# Copy package files dulu (layer cache)
COPY package*.json ./

# Install dependencies
RUN npm install --production --no-audit --no-fund

# Copy semua source code
COPY . .

# Buat folder yang diperlukan
RUN mkdir -p /tmp/wa-session /tmp/wa-version-cache

# Expose port
EXPOSE 3000

# Health check internal Docker
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://localhost:3000/ping || exit 1

# Start
CMD ["node", "index.js"]