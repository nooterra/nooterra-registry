FROM node:20-slim
WORKDIR /app

# Install all deps for build, then prune to production set
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --production

EXPOSE 3001
CMD ["node", "dist/server.js"]
