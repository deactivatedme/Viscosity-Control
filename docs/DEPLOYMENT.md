# Deployment

Two things get deployed: the **control plane** (once, e.g. on the host behind `control.viscosity.one`) and a **worker** on every server you want to manage.

## 1. Control plane (Docker Compose + Caddy)

Requirements: a Linux host with Docker Engine ≥ 24 and the compose plugin, ports 80/443 open, and a DNS A/AAAA record for your domain pointing at it.

```bash
git clone <this repository> viscosity-control && cd viscosity-control
cp .env.example .env
```

Edit `.env`:

```bash
DOMAIN=control.viscosity.one
POSTGRES_PASSWORD=$(openssl rand -base64 24)
VISCOSITY_SECRET_KEY=$(openssl rand -base64 48)   # back this up — it encrypts stored provider keys
```

Start it:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

Caddy obtains a certificate automatically. Open `https://<DOMAIN>` — the first visit creates the administrator account, then the Overview walks through enrolling a server, adding a provider key and launching an agent.

Operations:

```bash
docker compose -f deploy/docker-compose.yml logs -f api        # structured JSON logs
docker compose -f deploy/docker-compose.yml exec postgres pg_dump -U viscosity viscosity > backup.sql
git pull && docker compose -f deploy/docker-compose.yml --env-file .env up -d --build   # upgrade; migrations run at API start
```

Persistent state: the `pgdata` volume (everything relational), `apidata` (browser screenshots) and your `.env`.

### Private connectivity with Tailscale (optional)

Workers only make an outbound TLS connection, so nothing has to be exposed on the servers. If you also want the control plane off the public internet, put the host on your tailnet, serve it with a tailnet name that has a certificate (`tailscale cert`), and set `WORKER_URL` (and `DOMAIN`) to that name. Workers then dial the tailnet address.

## 2. Enroll a server (Ubuntu / Debian)

In the dashboard: **Servers → Add server**, name it, and run the command it shows on the target machine:

```bash
curl -fsSL https://control.viscosity.one/install.sh | sudo bash -s -- --url https://control.viscosity.one --token <single-use token>
```

Installer options (append after the token):

| Option | Effect |
| --- | --- |
| `--root <dir>` | Directory agents, terminals and the file manager may use. Repeatable. Default `/var/lib/viscosity/workspaces`. |
| `--with-browser` | Installs Playwright Chromium so the server can run browser sessions. |
| `--with-docker` | Adds the worker account to the `docker` group. **Docker access is root-equivalent** — see the threat model. |
| `--allow-reboot` | Lets admins reboot the machine from the dashboard (adds a polkit rule). |

What it does: installs Node.js 22 and build tools if needed, creates the unprivileged `viscosity` account, downloads the worker bundle from your control plane into `/opt/viscosity-worker`, enrolls (writing `/etc/viscosity/worker.json`, mode 0600) and starts the hardened `viscosity-worker` systemd unit. The dashboard's enrollment dialog flips to *Connected* when the worker's first heartbeat arrives.

```bash
systemctl status viscosity-worker
journalctl -u viscosity-worker -f
```

To let agents use Claude Code or Codex, either store an API key in **Settings → AI providers** (sent to the worker only when a run starts) or log the `viscosity` user in to the provider CLI on the server itself.

Rotate a server's credential: **Servers → ··· → Rotate credential**, then run the new command on the server. Remove access immediately: **Revoke credential**.

Other distributions: the worker is plain Node.js. Install Node 22, build tools for `node-pty`, unpack `GET /api/worker/bundle.tgz`, run `npm install --omit=dev`, then `node worker.mjs enroll …` and `node worker.mjs run` under any service manager.

## 3. Local development

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
createuser -P viscosity && createdb -O viscosity viscosity        # password: viscosity
cp .env.example .env                                              # use the "Local development" block
pnpm dev                                                          # API on :4000, dashboard on :3000
```

Enroll your own machine as the first server (the dashboard shows the token; in development enroll against the API port):

```bash
pnpm --filter @viscosity/worker dev enroll --url http://localhost:4000 --token <token> \
  --config ./data/worker.json --root "$HOME/projects" --data-dir ./data/worker
pnpm --filter @viscosity/worker dev run --config ./data/worker.json
```

Checks:

```bash
pnpm typecheck                # strict TypeScript across all packages
pnpm test                     # unit + integration (needs local Postgres; drives a real worker and Chromium)
pnpm test:e2e                 # UI acceptance flow: fresh DB, production build, real worker (ports 3100/4100)
VISCOSITY_LIVE_CLAUDE=1 pnpm exec vitest run apps/api/test/live-claude.test.ts   # real Claude agent; spends tokens
```
