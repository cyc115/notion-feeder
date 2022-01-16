# syntax=docker/dockerfile:1
FROM mhart/alpine-node:16 AS builder
WORKDIR  /app
COPY package* webpack.config.js /app
ADD src /app/src
RUN npm i; npm run build-prod

FROM mhart/alpine-node:slim-16
WORKDIR /app
COPY --from=0 app/dist/index.js /app/index.js
CMD ["node", "index.js"]
