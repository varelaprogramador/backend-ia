# =========================
# Stage 1: Build
# =========================
FROM node:20-alpine AS builder

# Instalar dependências do sistema
RUN apk add --no-cache libc6-compat

# Definir diretório de trabalho
WORKDIR /usr/src/app

# Copiar arquivos de dependência e gerar Prisma Client
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --frozen-lockfile \
  && npx prisma generate \
  && npm cache clean --force

# Copiar o restante da aplicação e construir
COPY . .
RUN npm run build

# =========================
# Stage 2: Production
# =========================
FROM node:20-alpine AS production

# Instalar dependências do sistema
RUN apk add --no-cache libc6-compat dumb-init

# Definir diretório de trabalho
WORKDIR /usr/src/app

# Criar usuário não-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copiar arquivos de dependências e instalar apenas em produção
COPY package*.json ./
RUN npm ci --frozen-lockfile --omit=dev \
  && npm cache clean --force \
  && rm -rf /tmp/* /root/.npm /root/.cache

# Copiar build, arquivos estáticos e Prisma Client gerado
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/build ./build
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/src/generated ./src/generated

# Verificar se o server.js existe
RUN test -f ./build/server.js || (echo "server.js não encontrado em ./build/" && exit 1)

# Variáveis de ambiente
ENV NODE_ENV=production \
    PORT=80 \
    NODE_OPTIONS="--max-old-space-size=1024"

# Alterar para usuário não-root
USER nodejs

# Expor a porta
EXPOSE 80

# Healthcheck para Docker validar a saúde da aplicação
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:80/health || exit 1

# Entrypoint e comando padrão
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "build/server.js"]
