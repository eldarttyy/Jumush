FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/usta.db UPLOAD_DIR=/data/uploads
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/catalog >/dev/null || exit 1
CMD ["node", "--no-warnings", "server.js"]
