FROM node:20-alpine

WORKDIR /app

COPY package.json server.mjs ./

RUN mkdir -p /app/data

EXPOSE 6789

CMD ["node", "server.mjs"]
