#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ALPINE_VERSION="${ALPINE_VERSION:-3.21}"
PACKAGES="${PACKAGES:-nodejs python3}"
IMAGE_SIZE_MIB="${IMAGE_SIZE_MIB:-512}"
CHUNK_SIZE="${CHUNK_SIZE:-262144}"
OUT=image/out
DEST=poc/image

command -v docker >/dev/null 2>&1 || { echo "Docker が見つかりません。ルートFSのビルドには Docker が必要です。" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 22.18 以上が必要です。" >&2; exit 1; }

rm -rf "$OUT" "$DEST"
mkdir -p "$OUT"

echo "==> ルートFSをビルド（Alpine ${ALPINE_VERSION} / x86、パッケージ: ${PACKAGES}、${IMAGE_SIZE_MIB} MiB）"
DOCKER_BUILDKIT=1 docker build \
  --target image \
  --output "type=local,dest=${OUT}" \
  --build-arg "ALPINE_VERSION=${ALPINE_VERSION}" \
  --build-arg "PACKAGES=${PACKAGES}" \
  --build-arg "IMAGE_SIZE_MIB=${IMAGE_SIZE_MIB}" \
  image/

echo "==> チャンク分割（${CHUNK_SIZE} バイト）"
node tools/chunk-image.ts "${OUT}/rootfs.ext4" "$DEST" \
  --chunk-size="${CHUNK_SIZE}" --image-id="alpine-${ALPINE_VERSION}-x86"

printf '*\n' > "${OUT}/.gitignore"
printf '*\n' > "${DEST}/.gitignore"

echo "==> ext4 とチャンク復元を検査"
node tools/inspect-image.ts "$DEST" --fsck

echo "完了: ${DEST}/ に manifest.json と chunks/ ができました。"
echo "次: npm run poc を実行し、http://127.0.0.1:8080/alpine.html を開く"
