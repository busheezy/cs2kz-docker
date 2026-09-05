#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 1 ]; then
    echo "Usage: /path/to/scripts/backup.sh /path/to/new-backup.tar.gz" >&2
    exit 1
fi
backup_file=$1
(set -C; : > "$backup_file") || exit 1
running_services=$(docker compose ps --services --status running)
resume() {
    if [ -n "$running_services" ]; then
        docker compose start $running_services >&2
    fi
}
trap resume EXIT
trap 'exit 1' HUP INT TERM
docker compose stop >&2
if ! docker compose run --rm --no-deps -T --entrypoint tar server -czf - -C / server state config > "$backup_file"; then
    rm -f -- "$backup_file"
    exit 1
fi
printf 'Backup saved to %s\n' "$backup_file"
