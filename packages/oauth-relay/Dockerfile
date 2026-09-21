# ---------- build stage ----------
FROM node:22-alpine AS builder
WORKDIR /build
COPY package.json tsconfig.json ./
COPY src ./src
# pouze nástroje pro překlad; běhová image je bez závislostí
RUN npm install --no-audit --no-fund --ignore-scripts typescript@^5 @types/node@^22 \
  && npx tsc -b \
  && npm cache clean --force

# ---------- runtime stage ----------
FROM node:22-alpine
RUN addgroup -S relay && adduser -S relay -G relay
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY package.json ./
# minimální oprávnění: non-root uživatel, jen čtení
RUN chown -R relay:relay /app
USER relay
ENV RELAY_PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8090/healthz | grep -q ok
CMD ["node", "dist/index.js"]
