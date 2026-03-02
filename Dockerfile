# Build stage: compile node-pty native module
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server.js ./

# Runtime stage
FROM node:20-alpine
RUN apk add --no-cache bash
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./
COPY --from=builder /app/package.json ./

ENV SHELL=/bin/bash
EXPOSE 3456
CMD ["node", "server.js"]
