FROM node:20-alpine

WORKDIR /app

COPY package.json server.mjs ./
COPY config.example.json ./config.example.json

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 6789

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
