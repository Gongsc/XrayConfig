FROM node:24.8.0-alpine

WORKDIR /app
RUN apk add --no-cache bash curl jq bc coreutils grep sed gawk bind-tools
COPY --chown=node:node . ./
RUN tar -czf /tmp/ip-quality-source.tar.gz . \
    && mv /tmp/ip-quality-source.tar.gz /app/ip-quality-source.tar.gz
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.js"]
