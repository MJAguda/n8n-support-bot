FROM node:22.21-alpine3.22
WORKDIR /app
COPY package.json server.js seed.json ./
RUN mkdir /data && chown node /data
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "server.js"]
