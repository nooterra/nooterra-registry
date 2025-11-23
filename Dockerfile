FROM node:20-slim
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --production

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 3001
CMD ["npm", "start"]
