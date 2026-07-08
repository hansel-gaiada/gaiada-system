FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
EXPOSE 3005
CMD ["npx", "tsx", "src/knowledge/service.ts"]
