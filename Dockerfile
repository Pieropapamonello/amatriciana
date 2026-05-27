FROM node:20-alpine

WORKDIR /app

COPY server.js .
COPY index.html public/index.html
COPY manifest.json public/manifest.json
COPY sw.js public/sw.js

EXPOSE 7860

CMD ["node", "server.js"]
