# --- build stage: instala TODAS las deps (incl. nest CLI) y compila ---
FROM node:22-slim AS build
WORKDIR /app
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
