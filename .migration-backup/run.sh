#!/usr/bin/env bash
set -euo pipefail

# DeepKrak3n launcher for bash/Codespaces
# Starts backend (FastAPI) then frontend (Next.js)

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
VENV_DIR="$ROOT_DIR/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"
API_URL="http://127.0.0.1:8000"
export NEXT_PUBLIC_API_BASE="$API_URL"

if [ ! -x "$PYTHON_BIN" ]; then
  echo "[backend] Creating venv at $VENV_DIR" >&2
  python3 -m venv "$VENV_DIR"
fi

echo "[backend] Installing requirements" >&2
"$PYTHON_BIN" -m pip install --upgrade pip > /dev/null
"$PYTHON_BIN" -m pip install -r "$BACKEND_DIR/requirements.txt"

cd "$BACKEND_DIR"
UVICORN_CMD=("$PYTHON_BIN" -m uvicorn app.main:app --host 0.0.0.0 --port 8000)

# Start backend in background
"${UVICORN_CMD[@]}" >/tmp/deepkrak3n-backend.log 2>&1 &
BACKEND_PID=$!
echo "[backend] Started uvicorn (pid $BACKEND_PID) -> $API_URL" >&2

# Small wait to let backend come up
sleep 2

cd "$ROOT_DIR"
if [ ! -d node_modules ]; then
  echo "[frontend] Installing npm dependencies" >&2
  npm install
fi

echo "[frontend] Starting Next.js dev server on http://localhost:3000" >&2
npm run dev -- --hostname 0.0.0.0 --port 3000
