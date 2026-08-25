# The Cyber lab's disposable target. Built and used ONLY inside a per-run internal network.
# See server.js — the vulnerability is deliberate and documented there.
FROM node:22-alpine
# `ping` is what the vulnerable endpoint shells out to.
RUN apk add --no-cache iputils
WORKDIR /opt
COPY server.js /opt/server.js
# The flag the learner has to make the application disclose. Readable on disk, never served.
ARG FLAG=FLAG{unset}
RUN printf '%s\n' "$FLAG" > /opt/flag.txt && chmod 0444 /opt/flag.txt
# Runs as nobody: the exercise is application-level, and the learner getting code execution here
# must not also get root inside the container.
USER 65534:65534
EXPOSE 8080
CMD ["node", "/opt/server.js"]
