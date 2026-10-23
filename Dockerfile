FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/belote.db
COPY package.json server.js planner.js ./
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# node:sqlite est stable dans les faits mais encore marqué expérimental : on masque l'avertissement
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
