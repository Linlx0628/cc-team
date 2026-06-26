FROM node:20-alpine

# better-sqlite3 ships a native addon; these tools build it when no prebuilt binary matches.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
COPY config.example.json ./config.example.json

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 6789

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
