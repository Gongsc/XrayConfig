FROM node:24.8.0-alpine

WORKDIR /app
COPY --chown=node:node server.js ./server.js
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.js"]
