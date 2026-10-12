FROM node:22-alpine
# git: the agent-runner's code.scaffold v2 job (src/code-scaffold/git-writer.ts) composes its dry-run tree with a local
# `git init`/`commit`. It never pushes (M6-P4b1) and never runs anything else (no-execute-guard.ts).
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
EXPOSE 3005
CMD ["npx", "tsx", "src/knowledge/service.ts"]
