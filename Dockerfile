FROM node:26-alpine

RUN apk add --no-cache postgresql-client gzip ca-certificates

WORKDIR /app

COPY package.json server.js auth.js database.js settings.js cron.js smtp.js connections.js backup.js dump.js storage.js index.html main.html settings.html login.js main.js settings-page.js style.css ./

RUN mkdir /data && chown node:node /data

ENV DB_PATH=/data/auth.sqlite

VOLUME ["/data"]

USER node

EXPOSE 3000

CMD ["node", "server.js"]
