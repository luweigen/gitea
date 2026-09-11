#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Installs the flir-seq customization into a Gitea CUSTOM_PATH.
#
# Usage: ./install.sh [custom-path]
#
# "custom-path" defaults to $GITEA_CUSTOM, then to ./custom -- run
# "gitea help" or check the admin panel if you are unsure where yours is.
#
# No app.ini change, no Gitea rebuild and no network access are needed: the
# viewer is a single dependency-free script.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
custom_path="${1:-${GITEA_CUSTOM:-./custom}}"

mkdir -p "$custom_path"
custom_path="$(cd "$custom_path" && pwd)"
echo "installing into ${custom_path}"

mkdir -p "${custom_path}/templates/custom" "${custom_path}/public/assets/js" "${custom_path}/public/assets/css"
tmpl="${custom_path}/templates/custom/body_inner_post.tmpl"

# Stamped into the asset URLs so that browsers pick up an updated
# gitea-flir-seq.js immediately. Gitea's own AssetVersion cannot do this: it
# only changes when Gitea is upgraded, while /assets is cached for
# STATIC_CACHE_TIME.
version="$(date -u +%Y%m%d%H%M%S)"

if [ -f "$tmpl" ] && grep -q 'gitea-flir-seq' "$tmpl" && ! grep -q 'flir-seq:begin' "$tmpl"; then
  # An older install.sh, or a hand-written block, is in there. Editing it out by
  # pattern could cut a Go template comment in half and take the whole site
  # down, so say so rather than guess.
  echo "error: ${tmpl} contains an unmarked flir-seq block" >&2
  echo "       delete those lines (the comment, the <link> and the two <script> tags)" >&2
  echo "       and run this script again" >&2
  exit 1
fi

tmp_tmpl="${tmpl}.flir-seq.tmp"
: >"$tmp_tmpl"
if [ -f "$tmpl" ]; then
  # keep whatever else is in there -- another contrib/ customization, or the
  # admin's own markup -- and drop only our previous block
  sed '/flir-seq:begin/,/flir-seq:end/d' "$tmpl" >"$tmp_tmpl"
fi
sed "s/__FLIR_SEQ_VERSION__/${version}/g" \
  "${script_dir}/custom/templates/custom/body_inner_post.tmpl" >>"$tmp_tmpl"
mv "$tmp_tmpl" "$tmpl"

cp "${script_dir}/custom/public/assets/js/gitea-flir-seq.js" "${custom_path}/public/assets/js/"
cp "${script_dir}/custom/public/assets/css/gitea-flir-seq.css" "${custom_path}/public/assets/css/"

cat <<MSG

done. now reload the templates, then hard-reload a page in your browser.

  gitea manager reload-templates    # or restart Gitea

  installed:
    ${tmpl}
    ${custom_path}/public/assets/js/gitea-flir-seq.js
    ${custom_path}/public/assets/css/gitea-flir-seq.css

Open any *.seq or *.fff file in a repository to see the viewer.
MSG
