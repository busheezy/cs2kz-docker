#!/bin/sh
set -eu
if [ ! -t 0 ] || [ ! -t 1 ]; then
    echo "Open this console from an interactive terminal." >&2
    exit 1
fi
docker compose exec -T server cs2kz status >/dev/null
docker compose logs --follow --tail 20 --no-log-prefix server &
console_logs_pid=$!
cleanup() {
    kill "$console_logs_pid" 2>/dev/null || true
    wait "$console_logs_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
docker compose exec server cs2kz console
