#!/usr/bin/env bash
# VISCOSITY CONTROL — worker installer for Ubuntu / Debian.
#   curl -fsSL https://control.example.com/install.sh | sudo bash -s -- --url https://control.example.com --token <token>
# Options:
#   --root <dir>      directory agents/terminals/files may use (repeatable; default /var/lib/viscosity/workspaces)
#   --with-browser    install Playwright Chromium for browser sessions
#   --with-docker     add the worker account to the docker group (NOTE: docker access is root-equivalent)
#   --allow-reboot    let the dashboard reboot this machine
#   --service <unit>  let the dashboard start/stop/restart this systemd unit (repeatable), e.g. nginx.service
#   --ca-cert <file>  trust this CA certificate for the control plane (private / internal PKI)
#   --insecure        allow a plain http:// control URL (testing only)
set -euo pipefail

URL="" TOKEN="" ROOTS=() WITH_BROWSER=0 WITH_DOCKER=0 ALLOW_REBOOT=0 INSECURE="" CA_CERT="" SERVICES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --root) ROOTS+=("$2"); shift 2 ;;
    --with-browser) WITH_BROWSER=1; shift ;;
    --with-docker) WITH_DOCKER=1; shift ;;
    --allow-reboot) ALLOW_REBOOT=1; shift ;;
    --ca-cert) CA_CERT="$2"; shift 2 ;;
    --service) SERVICES+=("$2"); shift 2 ;;
    --insecure) INSECURE="--insecure"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] && [ -n "$TOKEN" ] || { echo "usage: install.sh --url <control-url> --token <token>" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run this installer as root (sudo)" >&2; exit 1; }
command -v apt-get >/dev/null || { echo "only Debian/Ubuntu are supported by this installer; see docs/DEPLOYMENT.md for manual steps" >&2; exit 1; }

SVC_USER=viscosity
APP=/opt/viscosity-worker
ETC=/etc/viscosity
VAR=/var/lib/viscosity
[ ${#ROOTS[@]} -gt 0 ] || ROOTS=("$VAR/workspaces")

echo "==> Installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git build-essential python3 >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> Creating the unprivileged '$SVC_USER' account"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$VAR" --shell /bin/bash "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$APP" "$ETC" "$VAR" "$VAR/data" "${ROOTS[@]}"
[ "$WITH_DOCKER" -eq 1 ] && getent group docker >/dev/null && usermod -aG docker "$SVC_USER"

# Optional private CA: used for the download, the enrollment call and the running service.
CURL_CA=() NODE_CA=()
if [ -n "$CA_CERT" ]; then
  install -o "$SVC_USER" -g "$SVC_USER" -m 0644 "$CA_CERT" "$ETC/ca.crt"
  CURL_CA=(--cacert "$ETC/ca.crt")
  NODE_CA=("NODE_EXTRA_CA_CERTS=$ETC/ca.crt")
fi

echo "==> Downloading the worker from $URL"
curl -fsSL "${CURL_CA[@]}" "$URL/api/worker/bundle.tgz" | tar -xz -C "$APP" --strip-components=1
chown -R "$SVC_USER:$SVC_USER" "$APP"
( cd "$APP" && sudo -u "$SVC_USER" -H npm install --omit=dev --no-audit --no-fund --loglevel=error )
if [ "$WITH_BROWSER" -eq 1 ]; then
  echo "==> Installing Chromium for browser sessions"
  ( cd "$APP" && npx --yes playwright install-deps chromium >/dev/null && sudo -u "$SVC_USER" -H npx --yes playwright install chromium )
fi

echo "==> Enrolling with the control plane"
ROOT_ARGS=(); for r in "${ROOTS[@]}"; do ROOT_ARGS+=(--root "$r"); done
sudo -u "$SVC_USER" -H env "${NODE_CA[@]}" node "$APP/worker.mjs" enroll --url "$URL" --token "$TOKEN" \
  --config "$ETC/worker.json" --data-dir "$VAR/data" "${ROOT_ARGS[@]}" $INSECURE

if [ "$ALLOW_REBOOT" -eq 1 ]; then
  sudo -u "$SVC_USER" node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f));c.allowReboot=true;fs.writeFileSync(f,JSON.stringify(c,null,2),{mode:0o600})' "$ETC/worker.json"
  cat > /etc/polkit-1/rules.d/50-viscosity-reboot.rules <<POLKIT
polkit.addRule(function(action, subject) {
  if (subject.user == "$SVC_USER" && action.id.indexOf("org.freedesktop.login1.reboot") == 0) return polkit.Result.YES;
});
POLKIT
fi

if [ ${#SERVICES[@]} -gt 0 ]; then
  # The allow-list lives in the worker's own config; polkit grants exactly those units and nothing else.
  sudo -u "$SVC_USER" node -e 'const [f,...u]=process.argv.slice(1),fs=require("fs");const c=JSON.parse(fs.readFileSync(f));c.services=u;fs.writeFileSync(f,JSON.stringify(c,null,2),{mode:0o600})' "$ETC/worker.json" "${SERVICES[@]}"
  UNITS_JS=$(printf '"%s",' "${SERVICES[@]}")
  cat > /etc/polkit-1/rules.d/50-viscosity-services.rules <<POLKIT
polkit.addRule(function(action, subject) {
  var units = [${UNITS_JS%,}];
  if (subject.user == "$SVC_USER" && action.id == "org.freedesktop.systemd1.manage-units" &&
      units.indexOf(action.lookup("unit")) >= 0 && ["start", "stop", "restart"].indexOf(action.lookup("verb")) >= 0) return polkit.Result.YES;
});
POLKIT
fi

RW_PATHS="$VAR $ETC ${ROOTS[*]}"
cat > /etc/systemd/system/viscosity-worker.service <<UNIT
[Unit]
Description=VISCOSITY CONTROL worker
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$VAR
ExecStart=/usr/bin/env node $APP/worker.mjs run --config $ETC/worker.json
${NODE_CA:+Environment=${NODE_CA[0]}}
Restart=always
RestartSec=3
# Agents and terminals are children of this service: keep them confined.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$RW_PATHS
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now viscosity-worker.service >/dev/null

sleep 2
if systemctl is-active --quiet viscosity-worker.service; then
  echo "==> Worker is running. It should appear online in the dashboard within a few seconds."
  echo "    Logs: journalctl -u viscosity-worker -f"
else
  echo "!! The worker service failed to start:" >&2
  journalctl -u viscosity-worker -n 30 --no-pager >&2
  exit 1
fi
