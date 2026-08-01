#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Installs the markdown-draw customization into a Gitea CUSTOM_PATH.
#
# Usage: ./install.sh [custom-path]
#
# "custom-path" defaults to $GITEA_CUSTOM, then to ./custom -- run
# "gitea help" or check the admin panel if you are unsure where yours is.

set -euo pipefail

JS_DRAW_VERSION="${JS_DRAW_VERSION:-1.33.0}"
# npm registry "dist.integrity" of the pinned version, see
# https://registry.npmjs.org/js-draw/${JS_DRAW_VERSION}
JS_DRAW_SHA512="${JS_DRAW_SHA512:-sha512-wz+ZiWq3Tc577dEdeXGDWxpdHYWuFLTYY8qg5xv5WpfC/xVu8n0q0OL/yA/pqA/3ToIsPbrbkUeOEgCsjAx0Yw==}"
JS_DRAW_URL="https://registry.npmjs.org/js-draw/-/js-draw-${JS_DRAW_VERSION}.tgz"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
custom_path="${1:-${GITEA_CUSTOM:-./custom}}"

for tool in curl tar openssl; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

mkdir -p "$custom_path"
custom_path="$(cd "$custom_path" && pwd)"
echo "installing into ${custom_path}"

# 1. the customization itself
mkdir -p "${custom_path}/templates/custom" "${custom_path}/public/assets/js" "${custom_path}/public/assets/css"
header="${custom_path}/templates/custom/header.tmpl"
if [ -s "$header" ] && ! grep -q 'gitea-draw.js' "$header"; then
  echo "note: ${header} already exists, appending to it"
  cat "${script_dir}/custom/templates/custom/header.tmpl" >>"$header"
elif ! grep -qs 'gitea-draw.js' "$header"; then
  cp "${script_dir}/custom/templates/custom/header.tmpl" "$header"
fi
cp "${script_dir}/custom/public/assets/js/gitea-draw.js" "${custom_path}/public/assets/js/"
cp "${script_dir}/custom/public/assets/css/gitea-draw.css" "${custom_path}/public/assets/css/"

# 2. js-draw's prebuilt bundle
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "downloading js-draw ${JS_DRAW_VERSION}"
curl -fsSL -o "${work_dir}/js-draw.tgz" "$JS_DRAW_URL"

actual="$(openssl dgst -sha512 -binary "${work_dir}/js-draw.tgz" | openssl base64 -A)"
if [ "sha512-${actual}" != "$JS_DRAW_SHA512" ]; then
  echo "error: checksum mismatch for ${JS_DRAW_URL}" >&2
  echo "  expected: ${JS_DRAW_SHA512}" >&2
  echo "  actual:   sha512-${actual}" >&2
  exit 1
fi

target="${custom_path}/public/assets/js-draw"
mkdir -p "$target"
tar -xzf "${work_dir}/js-draw.tgz" -C "$work_dir" \
  package/dist/bundle.js package/dist/bundledStyles.js package/LICENSE
cp "${work_dir}/package/dist/bundle.js" "${work_dir}/package/dist/bundledStyles.js" "$target/"
cp "${work_dir}/package/LICENSE" "${target}/LICENSE"

cat <<EOF

done. now restart Gitea, then hard-reload a page in your browser.

  installed:
    ${custom_path}/templates/custom/header.tmpl
    ${custom_path}/public/assets/js/gitea-draw.js
    ${custom_path}/public/assets/css/gitea-draw.css
    ${target}/{bundle.js,bundledStyles.js,LICENSE}

No app.ini change and no Gitea rebuild is needed.
EOF
