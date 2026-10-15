#!/bin/bash
set -euo pipefail

CONFIG=/etc/acy-twitch-deploy.conf
if [[ ! -r "$CONFIG" ]]; then
  printf '%s\n' 'Deployment-Gateway ist nicht konfiguriert.' >&2
  exit 1
fi
# This file must be root-owned and not writable by the ubuntu service user.
if [[ ! -f "$CONFIG" || -L "$CONFIG" || "$(/usr/bin/stat -c '%u' "$CONFIG")" != "0" ]]; then
  printf '%s\n' 'Deployment-Konfiguration muss eine reguläre, root-eigene Datei sein.' >&2
  exit 1
fi
mode="$(/usr/bin/stat -c '%a' "$CONFIG")"
if (( (8#$mode & 022) != 0 )); then
  printf '%s\n' 'Deployment-Konfiguration darf nicht gruppen- oder weltbeschreibbar sein.' >&2
  exit 1
fi
source "$CONFIG"
: "${NODE_BIN:?NODE_BIN fehlt in /etc/acy-twitch-deploy.conf}"
: "${NPM_BIN:?NPM_BIN fehlt in /etc/acy-twitch-deploy.conf}"
: "${PM2_BIN:?PM2_BIN fehlt in /etc/acy-twitch-deploy.conf}"
: "${TAR_BIN:=/usr/bin/tar}"
: "${SHA256_BIN:=/usr/bin/sha256sum}"
export ACY_TWITCH_DEPLOY_NODE_BIN="$NODE_BIN"
export ACY_TWITCH_DEPLOY_NPM_BIN="$NPM_BIN"
export ACY_TWITCH_DEPLOY_PM2_BIN="$PM2_BIN"
export ACY_TWITCH_DEPLOY_TAR_BIN="$TAR_BIN"
export ACY_TWITCH_DEPLOY_SHA256_BIN="$SHA256_BIN"

exec "$NODE_BIN" /home/ubuntu/twitch-community-bot/deploy/twitch-deploy-gateway.mjs
