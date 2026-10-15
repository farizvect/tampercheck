#!/usr/bin/env bash
# Start tampercheck.
#
# The API key is resolved from the first of these that yields one:
#   1. TC_API_KEY in the environment (explicit override, wins always)
#   2. the file named by TC_ENV_FILE
#   3. ./.env next to this script
#   4. ~/.config/tampercheck/.env
#
# The file is read as KEY=VALUE lines; OPENROUTER_API_KEY is what it looks for.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -z "${TC_API_KEY:-}" ]]; then
  for ENVF in "${TC_ENV_FILE:-}" "./.env" "$HOME/.config/tampercheck/.env"; do
    [[ -n "$ENVF" && -f "$ENVF" ]] || continue
    KEY="$(grep -m1 '^OPENROUTER_API_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
    if [[ -n "$KEY" ]]; then
      export TC_API_KEY="$KEY"
      export TC_KEY_SOURCE="$ENVF"
      break
    fi
  done
fi

: "${TC_API_KEY:?no API key found - set TC_API_KEY, or put OPENROUTER_API_KEY=... in ./.env}"

export TC_PORT="${TC_PORT:-8787}"
export TC_HOST="${TC_HOST:-127.0.0.1}"
export TC_MODEL="${TC_MODEL:-google/gemini-3.8-flash}"
export TC_BASE_URL="${TC_BASE_URL:-https://openrouter.ai/api/v1}"
echo "tampercheck: key from ${TC_KEY_SOURCE:-environment}, model ${TC_MODEL}, binding ${TC_HOST}:${TC_PORT}"
exec node server.js
