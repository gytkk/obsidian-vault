#!/usr/bin/env bash
set -euo pipefail

VAULT_PLUGINS="$HOME/obsidian/personal/.obsidian/plugins"
REPO_PLUGINS="$(cd "$(dirname "$0")/plugins" && pwd)"

# Files to deploy (build artifacts only — no source, no node_modules)
DEPLOY_FILES=(main.js manifest.json styles.css)

deploy_plugin() {
  local plugin="$1"
  local src="$REPO_PLUGINS/$plugin"
  local dest="$VAULT_PLUGINS/$plugin"

  if [[ ! -d "$src" ]]; then
    echo "ERROR: Plugin '$plugin' not found in $REPO_PLUGINS" >&2
    return 1
  fi

  # Install dependencies & build
  echo "Building $plugin..."
  (cd "$src" && bun install --frozen-lockfile && bun run build)

  # Copy artifacts
  mkdir -p "$dest"
  for f in "${DEPLOY_FILES[@]}"; do
    if [[ -f "$src/$f" ]]; then
      cp "$src/$f" "$dest/$f"
    fi
  done

  echo "Deployed $plugin → $dest"
}

if [[ $# -gt 0 ]]; then
  # Deploy specific plugin(s)
  for plugin in "$@"; do
    deploy_plugin "$plugin"
  done
else
  # Deploy all plugins
  for dir in "$REPO_PLUGINS"/*/; do
    plugin="$(basename "$dir")"
    deploy_plugin "$plugin"
  done
fi
