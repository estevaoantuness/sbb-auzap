# Dev — Node 20 Alpine com hot reload via ts-node-dev.
# Produção usa Dockerfile.prod (multi-stage, <300MB).

FROM node:20-alpine

# openssl é necessário para Prisma (binary target) no Alpine.
RUN apk add --no-cache openssl libc6-compat curl

WORKDIR /app

# Install deps primeiro (cache layer).
COPY package*.json ./
RUN npm install

# Prisma schema é necessário pro generate. Fica montado via volume em dev também,
# mas copiamos aqui pra primeiro `npx prisma generate` não falhar no build.
COPY prisma ./prisma

# Gera client Prisma com base no schema.
RUN npx prisma generate || echo "prisma generate will re-run on first start"

# Código: em dev, src/ vem via bind mount do compose. Copiamos pra fallback.
COPY . .

EXPOSE 3000

# Regenera Prisma client na subida (caso schema tenha mudado via volume) e roda com hot reload.
CMD ["sh", "-c", "npx prisma generate && npm run dev"]
