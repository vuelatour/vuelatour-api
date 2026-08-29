# --- build stage: instala TODAS las deps (incl. nest CLI) y compila ---
FROM node:22-slim AS build
WORKDIR /app
# tsc del proyecto necesita más heap que el default de Node (CLAUDE.md:
# NODE_OPTIONS=--max-old-space-size=4096); sin esto el build de Railway se
# queda sin memoria en silencio y producción sigue con la imagen anterior.
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

# --- run stage: solo deps de producción + dist compilado ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Railway inyecta $PORT; main.ts ya lee process.env.PORT.
CMD ["node", "dist/main.js"]
