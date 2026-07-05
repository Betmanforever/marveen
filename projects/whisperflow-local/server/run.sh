#!/usr/bin/env bash
# Launch the whisperflow STT server with the project venv.
# Usage: server/run.sh [--model small|base|tiny] [--port 8765] [--language auto]
set -euo pipefail
cd "$(dirname "$0")/.."
exec .venv/bin/python server/stt_server.py "$@"
