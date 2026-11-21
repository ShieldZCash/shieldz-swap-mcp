FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
LABEL org.opencontainers.image.source="https://github.com/ShieldZCash/shieldz-swap-mcp"
LABEL org.opencontainers.image.description="MCP server for Shieldz Swap, non-custodial cross-chain swaps"
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# stdio by default; for the HTTP endpoint run: docker run -p 8787:8787 -e HOST=0.0.0.0 <image> node dist/remote.js
CMD ["node", "dist/stdio.js"]
