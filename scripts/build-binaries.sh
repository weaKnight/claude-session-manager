#!/usr/bin/env bash
# Build cross-platform binaries with Bun / 使用 Bun 构建跨平台二进制
#
# Requirements / 依赖：
#   - Bun 1.1+   (curl -fsSL https://bun.sh/install | bash)
#   - Node + npm (for vite client build)
#
# Output / 输出：
#   release/csm-{os}-{arch}/
#     ├── csm[.exe]      single executable
#     └── dist/client/   bundled SPA assets
#   release/csm-{os}-{arch}.tar.gz   (or .zip on windows)

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/release"
APP_NAME="csm"
ENTRY="server/index.ts"

# Targets: bun-target,os,arch,binary-suffix,archive-format
TARGETS=(
  "bun-linux-x64,linux,x64,,tar.gz"
  "bun-linux-arm64,linux,arm64,,tar.gz"
  "bun-darwin-x64,darwin,x64,,tar.gz"
  "bun-darwin-arm64,darwin,arm64,,tar.gz"
  "bun-windows-x64,windows,x64,.exe,zip"
)

# Optional CLI filter: ./build-binaries.sh linux-x64
FILTER="${1:-}"

echo "==> Building frontend (vite)"
npm run build:client

echo "==> Cleaning $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

for target in "${TARGETS[@]}"; do
  IFS=',' read -r BUN_TARGET OS ARCH SUFFIX FORMAT <<<"$target"
  PLATFORM="${OS}-${ARCH}"

  if [[ -n "$FILTER" && "$FILTER" != "$PLATFORM" ]]; then
    continue
  fi

  STAGE="$OUT/${APP_NAME}-${PLATFORM}"
  BIN="$STAGE/${APP_NAME}${SUFFIX}"

  echo ""
  echo "==> Building $PLATFORM ($BUN_TARGET)"
  mkdir -p "$STAGE"

  bun build "$ENTRY" \
    --compile \
    --minify \
    --target="$BUN_TARGET" \
    --outfile "$BIN"

  # Drop sourcemap that bun emits next to the binary
  # 删除 bun 在二进制旁生成的 sourcemap
  rm -f "${BIN%.*}".js.map "$BIN".js.map "$STAGE"/*.js.map

  echo "==> Bundling client into $STAGE/dist/client"
  mkdir -p "$STAGE/dist"
  cp -R dist/client "$STAGE/dist/client"

  cat >"$STAGE/README.txt" <<EOF
Claude Session Manager — $PLATFORM

Run:
  ./${APP_NAME}${SUFFIX}

Optional flags:
  ./${APP_NAME}${SUFFIX} --port 8080
  ./${APP_NAME}${SUFFIX} --host 127.0.0.1
  ./${APP_NAME}${SUFFIX} --claude-dir /path/to/.claude
  ./${APP_NAME}${SUFFIX} --read-only true

Then open http://localhost:3727 in your browser.
First run will prompt you to set a password.
EOF

  echo "==> Packing $FORMAT"
  pushd "$OUT" >/dev/null
  if [[ "$FORMAT" == "tar.gz" ]]; then
    tar -czf "${APP_NAME}-${PLATFORM}.tar.gz" "${APP_NAME}-${PLATFORM}"
  else
    if command -v zip >/dev/null 2>&1; then
      zip -qr "${APP_NAME}-${PLATFORM}.zip" "${APP_NAME}-${PLATFORM}"
    else
      echo "    (zip not installed — leaving folder uncompressed)"
    fi
  fi
  popd >/dev/null

  SIZE=$(du -sh "$STAGE" | cut -f1)
  echo "==> Done $PLATFORM ($SIZE)"
done

echo ""
echo "All builds complete. Release artifacts in: $OUT"
ls -lh "$OUT"
