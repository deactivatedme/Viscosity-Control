# VISCOSITY CONTROL

A self-hosted control plane for your servers and AI agents: enroll Linux machines with one command, then watch real metrics, open terminals, browse files, manage containers, and launch supervised **Claude Code**, **Codex** and browser agents — from one monochrome dashboard.

```
dashboard (Next.js) ──▶ API (Fastify + Postgres) ◀── worker (one per server, dials out over TLS)
                                                        ├─ metrics · PTY · files · docker · git
                                                        ├─ agents: Claude Agent SDK · Codex SDK · custom
                                                        └─ browser sessions: Playwright
```

* **Real, not simulated.** Every number and every line of output comes from an enrolled machine. Unconfigured integrations show empty states, never demo data.
* **Agents outlive the browser.** Sessions are supervised by the worker on the server; the dashboard only observes. Events are sequenced, persisted and replayed after any disconnect.
* **Security is structural.** Deny-by-default routes with server-side roles, Origin-checked mutations and WebSockets, single-use enrollment, hashed credentials, encrypted provider keys, approval gates, path and network guards, a full audit trail. See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Documentation

| | |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deploy (Compose + Caddy), enrolling servers, local development |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, the worker protocol, liveness and reconciliation |
| [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) | Trust boundaries, mitigations, and the gaps that are not closed yet |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is built, **what was actually verified and how**, and what is next |

## Quick start (development)

```bash
pnpm install
createuser -P viscosity && createdb -O viscosity viscosity     # password: viscosity
cp .env.example .env                                           # keep only the "Local development" block
pnpm dev                                                       # http://localhost:3000
```

Create the administrator, click **Add server**, and enroll your own machine with the token it shows:

```bash
pnpm --filter @viscosity/worker dev enroll --url http://localhost:4000 --token <token> \
  --config ./data/worker.json --root "$HOME/projects" --data-dir ./data/worker
pnpm --filter @viscosity/worker dev run --config ./data/worker.json
```

## Repository layout

```
packages/protocol   typed, versioned control-plane ⇄ worker contract (zod)
apps/api            control plane: auth, RBAC, worker hub, persistence, scheduler
apps/worker         remote worker: operations, agent + browser supervision
apps/web            dashboard
deploy/             Dockerfiles, docker-compose, Caddyfile, worker installer
docs/               architecture, threat model, deployment, roadmap
```

## Checks

```bash
pnpm typecheck      # strict TypeScript everywhere
pnpm test           # unit + integration: real Postgres, a real in-process worker, real Chromium
```

## Keyboard

`⌘K` command palette and global search · `⌘B` sidebar · `⌘.` inspector · `⌘\` split view · `Alt+1…9` jump to a section · drag any tab to an edge to split the workspace.
