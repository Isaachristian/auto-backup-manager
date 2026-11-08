FROM node:26-alpine

WORKDIR /app

COPY package.json server.js auth.js index.html main.html login.js main.js style.css ./

RUN mkdir /data && chown node:node /data

ENV DB_PATH=/data/auth.sqlite

VOLUME ["/data"]

USER node

EXPOSE 3000

CMD ["node", "server.js"]
