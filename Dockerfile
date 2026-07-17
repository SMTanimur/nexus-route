# ─── Stage 1: Build Backend (NestJS) ────────────────────────────
FROM node:22-slim AS api-builder
WORKDIR /app/nexus-api

COPY nexus-api/package.json nexus-api/bun.lock* ./
RUN npm install --legacy-peer-deps

COPY nexus-api/ .
RUN npm run build

# ─── Stage 2: Build Frontend (Next.js) ──────────────────────────
FROM node:22-slim AS web-builder
WORKDIR /app

COPY package.json bun.lock* ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build:web

# ─── Stage 3: Build CLI ─────────────────────────────────────────
FROM node:22-slim AS cli-builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN npm install esbuild --legacy-peer-deps
COPY cli/ ./cli/
COPY package.json ./
RUN npx esbuild cli/index.ts --bundle --minify --platform=node --format=cjs --outfile=dist/cli.js

# ─── Stage 4: Production Runtime ────────────────────────────────
FROM node:22-slim AS production
WORKDIR /app

# Install dumb-init for proper signal handling
RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

# Copy built frontend (standalone)
COPY --from=web-builder /app/.next/standalone ./
COPY --from=web-builder /app/.next/static ./.next/static
COPY --from=web-builder /app/public ./public

# Copy built backend
COPY --from=api-builder /app/nexus-api/dist ./nexus-api/dist
COPY --from=api-builder /app/nexus-api/node_modules ./nexus-api/node_modules
COPY --from=api-builder /app/nexus-api/package.json ./nexus-api/package.json

# Copy CLI
COPY --from=cli-builder /app/dist/cli.js ./dist/cli.js

# Copy package.json for version info
COPY package.json ./

ENV NODE_ENV=production
ENV API_PORT=4444
ENV WEB_PORT=4200
ENV HOST=0.0.0.0

EXPOSE 4200 4444

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/cli.js"]
