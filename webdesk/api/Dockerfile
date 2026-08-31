# WSK-29 — webdesk/api's own image. Follows platform-nest/Dockerfile's two-stage shape (the house
# pattern: build with devDependencies, ship without them) rather than inventing a new one.
#
# NOT wired into release.yml's build matrix yet — see this ticket's report for why (A-12: the Zone
# B box this would deploy to does not exist, and release.yml's matrix is a flat list shared with
# the deploy job's COMPONENTS var, so adding an entry there implies a deploy path this ticket did
# not build). This Dockerfile exists so that wiring is a one-line matrix addition once a Zone B
# target exists, not a from-scratch build definition written under deploy pressure.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
