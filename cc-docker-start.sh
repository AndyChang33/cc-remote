#!/bin/bash
cd "$(dirname "$0")"
docker compose up --build -d
echo "[cc-docker] Server started at http://localhost:3456"
echo "[cc-docker] Starting host daemon..."
node ccrd.js
