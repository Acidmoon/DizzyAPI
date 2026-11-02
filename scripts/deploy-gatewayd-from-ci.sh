#!/usr/bin/env bash
# 从 GitHub CI 的 ci/bin 分支部署 gatewayd / dizzy。
#
# 不在服务器上 go build。CI 的 Bin job 在 GitHub runner 上静态编译
# （CGO_ENABLED=0 -trimpath），把二进制推到 ci/bin 分支；这里只取产物。
#
# 用法：
#   sudo scripts/deploy-gatewayd-from-ci.sh
#   sudo DIZZYAPI_REPO=https://github.com/Acidmoon/DizzyAPI.git scripts/deploy-gatewayd-from-ci.sh
set -euo pipefail

REPO="${DIZZYAPI_REPO:-https://github.com/Acidmoon/DizzyAPI.git}"
BRANCH="${DIZZYAPI_BIN_BRANCH:-ci/bin}"
TARGET="${DIZZYAPI_HOME:-/opt/dizzyapi}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fetch $REPO ($BRANCH) ..."
git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP" >/dev/null

test -x "$TMP/gatewayd"
test -x "$TMP/dizzy"

stamp="$(date +%Y%m%d-%H%M%S)"
if [ -x "$TARGET/bin/gatewayd" ]; then
  cp -a "$TARGET/bin/gatewayd" "$TARGET/bin/gatewayd.prev-$stamp"
fi

install -m 755 "$TMP/gatewayd" "$TARGET/bin/gatewayd"
install -m 755 "$TMP/dizzy" "$TARGET/bin/dizzy"

systemctl restart dizzyapi
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:18080/healthz >/dev/null 2>&1; then
    echo "deployed $(cat "$TMP/build-info.json" 2>/dev/null || echo "(no build-info)")"
    echo "healthz OK"
    exit 0
  fi
  sleep 1
done

echo "ERROR: dizzyapi did not become healthy; previous gatewayd is at $TARGET/bin/gatewayd.prev-$stamp" >&2
exit 1
