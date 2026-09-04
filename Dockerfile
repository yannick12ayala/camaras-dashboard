FROM node:20-alpine
WORKDIR /app
COPY server.js index.html login.html cuenta.html admin.html isp.html icon.png manifest.json ./
EXPOSE 8080
CMD ["node", "server.js"]
