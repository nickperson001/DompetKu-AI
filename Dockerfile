# Gunakan versi Node.js yang sesuai dengan engines (>=18.0.0)
FROM node:18-bullseye-slim

# Instal Chromium dan semua dependensi sistem yang dibutuhkan
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set environment agar Puppeteer tidak mendownload Chromium versi bawaan
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Tentukan direktori kerja
WORKDIR /app

# Salin file package untuk instalasi
COPY package*.json ./

# Instal dependensi Node.js
RUN npm install

# Salin sisa kode aplikasi
COPY . .

# Ekspos port default
EXPOSE 3000

# Jalankan aplikasi
CMD ["node", "index.js"]