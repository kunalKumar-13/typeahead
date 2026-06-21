#!/bin/sh
# Start three local Redis instances for development / benchmarking WITHOUT Docker.
# In Docker (docker-compose.yml) the three nodes are separate containers and the
# app addresses them via REDIS_NODES; this script is the local equivalent.
#
# Usage:
#   scripts/run_local_redis.sh start   # launch redis on 6390/6391/6392
#   scripts/run_local_redis.sh stop    # shut them down
#   scripts/run_local_redis.sh ping    # health check
set -e
PORTS="6390 6391 6392"
DIR="$(cd "$(dirname "$0")/.." && pwd)/data/redis"
mkdir -p "$DIR"

case "${1:-start}" in
  start)
    for p in $PORTS; do
      redis-server --port "$p" --daemonize yes \
        --save "" --appendonly no \
        --pidfile "$DIR/redis-$p.pid" \
        --logfile "$DIR/redis-$p.log" \
        --dir "$DIR"
      echo "started redis on :$p"
    done
    ;;
  stop)
    for p in $PORTS; do
      redis-cli -p "$p" shutdown nosave 2>/dev/null && echo "stopped :$p" || echo ":$p not running"
    done
    ;;
  ping)
    for p in $PORTS; do
      printf ":%s -> " "$p"; redis-cli -p "$p" ping 2>/dev/null || echo "DOWN"
    done
    ;;
  *)
    echo "usage: $0 {start|stop|ping}"; exit 1;;
esac
