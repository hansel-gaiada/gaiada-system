# The lab runner. Runs on the host's Docker daemon as a SIBLING-container spawner.
#
# ⚠ THE TRAP THIS IMAGE IS SHAPED AROUND. The runner writes a submission to a temp directory and
#   bind-mounts it into the lab container. The daemon resolves that path on the HOST, not inside
#   this container — so a path that exists only in here would silently mount as an EMPTY directory
#   and every submission would run against nothing. Docker creates the missing path rather than
#   erroring, so it fails as "your code did nothing" with no message anywhere.
#
#   The fix is that TMPDIR points at a path bind-mounted from the host at the SAME location, so
#   "/var/lib/gaiada-lab/tmp/lab-src-xxx" means the same directory to both. See the deploy command
#   in README.md; the compose/run line and this ENV must agree or labs break silently.
FROM node:22-alpine

# The docker CLI only — this image talks to the host daemon over the mounted socket and must never
# contain a daemon of its own.
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist

ENV NODE_ENV=production
ENV TMPDIR=/var/lib/gaiada-lab/tmp
ENV LAB_RUNNER_HOST=0.0.0.0

# NOTE on LAB_RUNNER_HOST=0.0.0.0: inside a container that is the ONLY way to be reachable from the
# published port, and the publish itself is pinned to 127.0.0.1 on the host — which is where the
# real boundary is. Docker's DNAT is evaluated before ufw's, so publishing 0.0.0.0 on THIS host
# would be internet-reachable regardless of the firewall. The run command must say
# `-p 127.0.0.1:4310:4310`, never `-p 4310:4310`.

EXPOSE 4310
CMD ["node", "dist/server.js"]
