# Roadmap and validation status

Legend: **Verified** = exercised for real in this repository's test runs (how is stated) · **Built, unverified** = implemented against the documented interface but not run against the real dependency here · **Not built**.

## Milestone 1 — acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Authenticated dashboard | Verified | Integration tests (setup-once, login, MFA, CSRF/Origin, roles) + browser runs of the UI |
| One real machine enrolled through a secure worker | Verified* | Real worker process enrolled with a single-use token and connected over the real protocol. *The machine was the development container, not a separate VPS; `deploy/install-worker.sh` (systemd, apt) has only been syntax-checked. |
| Genuine machine metrics updating live | Verified | `/proc`-sourced metrics pushed every 2 s and rendered (CPU/memory/disk/network, processes) |
| Functional remote terminal | Verified | Integration test (PTY echo, exit code, foreign-Origin refused) + UI run (type, resize, reload → scrollback replay, exit) |
| Real Claude or Codex agent on the server | Verified (Claude) | `apps/api/test/live-claude.test.ts`: real Claude Agent SDK run — approval requested → approved → file written → completed → conversation resumed |
| Agent output streaming into the dashboard | Verified | Live event topic → agent workspace (custom-process agents in the UI; Claude via the API test) |
| Agent history persists after refresh | Verified | Events stored by `(session, seq)`; UI reload shows identical history |
| Controlled Playwright browser task on a worker | Verified | Scripted session: goto → fill (read-back verified) → click → extract → screenshot |
| Browser progress visible in the dashboard | Verified | Timeline + live screenshot frame, approvals allowed/denied from the UI |
| Correct handling of worker disconnection | Verified | Offline within one heartbeat; RPCs fail with `offline`; events produced during an outage are replayed with no gaps; vanished sessions are marked `lost`; queued sessions start on reconnect |
| Enforced authorization | Verified | Deny-by-default hook; viewer/operator/admin matrix in the integration suite |
| Repeatable deployment instructions | Built, unverified | `docs/DEPLOYMENT.md`, Compose/Caddy/Dockerfiles. The API and worker production bundles build; **the Docker images were not built or run** (no Docker daemon in the build environment). |

## By phase

| Phase | Built | Not yet |
| --- | --- | --- |
| 1 Foundation | Monorepo, schema + migrations, auth (scrypt, sessions, TOTP MFA, roles), design system, three-panel workspace with draggable/splittable tabs, command palette, notifications | User-management UI (single administrator ships) |
| 2 Server connectivity | Single-use enrollment, worker service, real metrics, live status, reconnect + reconciliation, credential rotation/revocation | Long-range metrics storage (in-memory ~10 min ring today) |
| 3 Remote operations | Terminals (xterm.js, PTY on the worker, scrollback replay), file manager (browse, edit in Monaco, upload/download, rename, delete, search), processes (list, signal), journald logs, reboot | Managed systemd service start/stop UI |
| 3 Docker | List, inspect, logs, start/stop/restart, stats, compose grouping — **built, unverified** (only the "Docker unavailable" path could be run) | Compose project management |
| 4 Coding agents | Adapter interface; Claude Agent SDK (verified live); Codex SDK (**built, unverified** — needs an OpenAI key); custom process; queue/start/stop/resume/restart/archive; approvals; git worktree isolation; changes/diff view; usage and cost | Pause (no provider supports it); mid-run messages; container sandbox per agent |
| 5 Browser agents | Isolated Playwright sessions, network guard (SSRF), scripted steps with verification, screenshots, approvals; autonomous mode on the Anthropic Messages API (**built, unverified** — needs an API key) | File upload action; live video stream; stored site logins |
| 6 Projects & deployments | — | **Not built**: GitHub connection, clone/branches/PRs, project workspaces, Docker/Compose deployments, health checks, rollback. The sidebar entries say so and contain no controls. |
| 7 Automation | Durable scheduled workflows (cron in Postgres, at-most-once firing across replicas, catch-up after downtime, overlap skip, run history), queued sessions, alerts/notifications | Multi-step workflows with dependencies, retries with limits, checkpoints; BullMQ/Redis (deliberately not added — Postgres covers today's needs) |
| 8 Hardening | Threat model, integration + unit suites, security review of the trust boundaries listed in the threat model | End-to-end UI suite in CI, load/performance testing, the gaps listed in `THREAT-MODEL.md` |

## To finish verification on your infrastructure

1. **Deploy the control plane** with `deploy/docker-compose.yml` on a host with Docker and confirm the images build and Caddy issues a certificate.
2. **Enroll a real Ubuntu/Debian VPS** with the dashboard's command and confirm the systemd unit, the unprivileged account, and (if used) `--with-docker`, `--with-browser`, `--allow-reboot`.
3. **Docker management**: on a server with Docker, check list/stats/logs/start/stop against real containers.
4. **Codex**: add an OpenAI key in Settings and run a Codex agent.
5. **Autonomous browser**: add an Anthropic key and run an autonomous browser session, including an approval.
