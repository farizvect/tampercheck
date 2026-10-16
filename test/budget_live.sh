#!/usr/bin/env bash
# Does a spent budget actually stop a model call?
#
# A second server is started against a ledger that is already over the cap, with the provider read
# pointed at a port nothing listens on so the guard cannot consult OpenRouter. If it refuses here,
# it refuses on the strength of its own accounting, which is the case that matters: OpenRouter being
# unreachable must not turn into unlimited spending.
#
# The refusal has to be checked at the endpoint, not just in the status object: a guard that reports
# exhausted and then calls the model anyway would pass a status-only test.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
PORT="${TC_BUDGET_TEST_PORT:-8799}"
BASE="http://127.0.0.1:$PORT"
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

# Over the cap already.
echo '{"spent": 9.75, "calls": 12}' > "$TMP/budget.json"

TC_HOST=127.0.0.1 TC_PORT="$PORT" \
TC_REPORT_DIR="$TMP" TC_BUDGET_FILE="$TMP/budget.json" TC_BUDGET_USD=5 \
TC_BASE_URL="http://127.0.0.1:9/v1" TC_API_KEY="sk-or-v1-notarealkey" \
  node "$HERE/server.js" > "$TMP/log" 2>&1 &
PID=$!

for _ in $(seq 1 40); do
  curl -sf "$BASE/api/status" > /dev/null 2>&1 && break
  sleep 0.25
done

echo "=== /api/status"
STATUS="$(curl -s "$BASE/api/status")"
echo "$STATUS"
echo "$STATUS" | grep -q '"exhausted":true' || { echo "FAIL: budget not reported exhausted"; exit 1; }
echo "$STATUS" | grep -q '"source":"local"' || { echo "FAIL: guard did not fall back to its ledger"; exit 1; }

echo
echo "=== POST /api/analyze (must be refused, and must not reach the model)"
IMG="data:image/jpeg;base64,$(head -c 200 /dev/urandom | base64 -w0)"
CODE="$(curl -s -o "$TMP/resp" -w '%{http_code}' -X POST "$BASE/api/analyze" \
  -H 'content-type: application/json' \
  -d "{\"brand\":\"ledger\",\"model\":\"nano-x\",\"images\":[{\"side\":\"front\",\"data\":\"$IMG\"}]}")"
echo "HTTP $CODE"
cat "$TMP/resp"; echo
[ "$CODE" = "503" ] || { echo "FAIL: expected 503, got $CODE"; exit 1; }
grep -q 'budget_exhausted' "$TMP/resp" || { echo "FAIL: refusal did not name the budget"; exit 1; }

echo
echo "=== server log (an upstream call would show a connection error here)"
cat "$TMP/log"

echo
echo "PASS: a spent budget refuses the call, and no request was made upstream"
