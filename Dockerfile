# PhenixRouter — Copyright (c) 2026 Fido-labs —kcw—
FROM node:22-alpine
WORKDIR /app
COPY package.json brand.json LICENSE NOTICE ./
COPY bin ./bin
COPY src ./src
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=20128 PHENIX_DATA_DIR=/data PHENIX_NO_BROWSER=1
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 20128
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:20128/healthz || exit 1
CMD ["node", "bin/phenixrouter.js", "start"]
