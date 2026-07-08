FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
# tsx runs TS directly — matches how the project runs locally (npm start)
RUN mkdir -p data
EXPOSE 3001
CMD ["npx", "tsx", "src/server.ts"]
