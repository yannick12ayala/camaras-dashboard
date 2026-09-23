FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js index.html login.html cuenta.html admin.html isp.html sw.js manifest.json assetlinks.json icon.png icon-192.png icon-192-maskable.png icon-512-maskable.png ./
EXPOSE 8080
CMD ["node", "server.js"]
