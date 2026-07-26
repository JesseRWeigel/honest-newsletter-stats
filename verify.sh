#!/usr/bin/env bash
# Verify command for honest-newsletter-stats. Exit 0 means the testable privacy claims in
# THREAT_MODEL.md were exercised and held on this machine.
#
# Three stages:
#   1. The full unit and integration suite, including the end-to-end leak scan and its
#      negative control.
#   2. A live server run: start it, click through it with canary-laden headers, then grep
#      the resulting database file from outside the test harness.
#   3. A structural grep over the shipped source for tracking primitives.

set -euo pipefail
cd "$(dirname "$0")"

NODE_FLAGS="--disable-warning=ExperimentalWarning"
PORT="${VERIFY_PORT:-8791}"

echo "== stage 1: test suite =="
node $NODE_FLAGS --test test/*.test.js

echo
echo "== stage 2: live server, external leak check =="
WORK="$(mktemp -d)"
export WORK PORT
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

node $NODE_FLAGS -e '
const run = async () => {
  const { Store } = await import("./src/store.js");
  const { createServer } = await import("./src/server.js");
  const store = new Store(process.env.WORK + "/stats.db", { policy: { k: 5 } });
  store.createIssue({ issueId: "i1", title: "Live check", sentDay: "2026-07-20", recipientCount: 9 });
  store.registerLink({ issueId: "i1", linkId: "a", targetUrl: "https://example.org/a", label: "A" });
  createServer(store).listen(Number(process.env.PORT), "127.0.0.1");
};
run();
' &
SERVER_PID=$!

ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then ready=1; break; fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then echo "FAIL: server did not come up on port $PORT"; exit 1; fi

CANARY="SUBSCRIBER-CANARY-LIVE-8842"
for _ in $(seq 1 7); do
  curl -fsS -o /dev/null \
    -H "User-Agent: CanaryUA/$CANARY" \
    -H "Cookie: sid=$CANARY" \
    -H "X-Forwarded-For: 203.0.113.99" \
    -H "X-Subscriber-Id: $CANARY" \
    "http://127.0.0.1:$PORT/c/i1/a"
done
curl -fsS "http://127.0.0.1:$PORT/i/i1"        > "$WORK/page.html"
curl -fsS "http://127.0.0.1:$PORT/api/stats/i1" > "$WORK/stats.json"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

fail=0
for f in "$WORK"/stats.db*; do
  [ -e "$f" ] || continue
  if grep -aq -e "$CANARY" -e "CanaryUA" -e "203.0.113.99" "$f"; then
    echo "FAIL: canary found in $(basename "$f")"; fail=1
  else
    echo "ok: no canary in $(basename "$f")"
  fi
done
if grep -aq -e "$CANARY" -e "203.0.113.99" "$WORK/page.html" "$WORK/stats.json"; then
  echo "FAIL: canary echoed in a published surface"; fail=1
else
  echo "ok: no canary in the dashboard or the JSON API"
fi
if grep -aq "Not recorded, and not recoverable" "$WORK/page.html"; then
  echo "ok: dashboard publishes what the publisher cannot see"
else
  echo "FAIL: dashboard is missing the cannot-see panel"; fail=1
fi
if grep -aq '"value": 7' "$WORK/stats.json"; then
  echo "ok: 7 clicks aggregated and published above k=5"
else
  echo "FAIL: aggregate count of 7 missing from the API"; fail=1
fi
if grep -aq '"suppressed": true' "$WORK/stats.json" && grep -aq "fewer than 5" "$WORK/page.html"; then
  echo "ok: sub-threshold cells are suppressed in both the API and the page"
else
  echo "FAIL: suppression not visible in the published output"; fail=1
fi

echo
echo "== stage 3: structural grep for tracking primitives in shipped source =="
# Match ACCESS shapes, not bare words. An earlier pattern matched the phrase anywhere,
# including the sentence on the feedback page that tells a subscriber their IP and user-agent
# are unavoidably visible to the server. That disclosure is the honest thing to print, and a
# guard that forces its deletion trades real documentation for the appearance of safety.
#
# grep's exit status is checked explicitly. A malformed pattern exits 2, writes to stderr, and
# produces no stdout, which the previous version reported as "no tracking primitive found".
# A guard that cannot run is not a guard that passed.
PATTERNS='verify-patterns.txt'
set +e
hits="$(grep -rn -i -E -f "$PATTERNS" src/ 2>/tmp/hns-grep-err | grep -vE '^[^:]+:[0-9]+: *//')"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" -gt 1 ]; then
  echo "FAIL: the tracking-primitive grep could not run (exit $rc):"
  cat /tmp/hns-grep-err
  fail=1
  hits=""
fi
if [ -n "$hits" ]; then
  echo "FAIL: a tracking primitive appears in src/ outside a comment:"
  echo "$hits"
  fail=1
else
  echo "ok: no tracking primitive in src/"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "VERIFY FAILED"
  exit 1
fi
echo "VERIFY PASSED"
