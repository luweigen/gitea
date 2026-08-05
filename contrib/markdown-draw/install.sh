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

# Stamped into the asset URLs so that browsers pick up an updated
# gitea-draw.js immediately. Gitea's own AssetVersion cannot do this: it only
# changes when Gitea is upgraded, while /assets is cached for STATIC_CACHE_TIME.
version="$(date -u +%Y%m%d%H%M%S)"

if [ -f "$header" ] && grep -q 'gitea-draw' "$header" && ! grep -q 'markdown-draw:begin' "$header"; then
  # An older install.sh wrote an unmarked block. Editing it out by pattern could
  # cut a Go template comment in half and take the whole site down, so say so
  # rather than guess.
  echo "error: ${header} contains a markdown-draw block from an older install.sh" >&2
  echo "       delete those lines (the comment, the <link> and the two <script> tags)" >&2
  echo "       and run this script again" >&2
  exit 1
fi

tmp_header="${header}.markdown-draw.tmp"
: >"$tmp_header"
if [ -f "$header" ]; then
  # keep whatever else the admin put in there, drop our previous block
  sed '/markdown-draw:begin/,/markdown-draw:end/d' "$header" >"$tmp_header"
fi
sed "s/__MARKDOWN_DRAW_VERSION__/${version}/g" \
  "${script_dir}/custom/templates/custom/header.tmpl" >>"$tmp_header"
mv "$tmp_header" "$header"
cp "${script_dir}/custom/public/assets/js/gitea-draw.js" \
   "${script_dir}/custom/public/assets/js/gitea-draw-history.js" \
   "${script_dir}/custom/public/assets/js/gitea-draw-playback.js" \
   "${custom_path}/public/assets/js/"
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
    ${custom_path}/public/assets/js/gitea-draw-history.js
    ${custom_path}/public/assets/js/gitea-draw-playback.js
    ${custom_path}/public/assets/css/gitea-draw.css
    ${target}/{bundle.js,bundledStyles.js,LICENSE}

No app.ini change and no Gitea rebuild is needed.
EOF
