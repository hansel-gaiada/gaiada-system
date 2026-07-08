FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN mkdir -p data
EXPOSE 3002
CMD ["npx", "tsx", "src/server.ts"]
