# The Autark meeting server as an image - provider-neutral (Render, Fly, Railway, an own server all run it).
# Build context is this folder:
#
#   docker build -t autark-meet services/remote-relay
#
# The host's TLS proxy gives the wss:// address and forwards to the container, so the server takes the client
# address from X-Forwarded-For (RELAY_TRUST_PROXY=1) and listens on every interface of the container.

FROM node:24-alpine

WORKDIR /app

# Manifests first, then the code: a code change keeps the installed layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Hosts set PORT; RELAY_PORT follows it (8787 when nobody says otherwise).
ENV PORT=8787 RELAY_HOST=0.0.0.0 RELAY_TRUST_PROXY=1
EXPOSE 8787

# Not as root: the image brings this user.
USER node

CMD ["sh", "-c", "RELAY_PORT=\"$PORT\" exec node src/main.ts"]
