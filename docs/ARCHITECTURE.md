# Architecture

```
            Browser (dashboard)
                 │  HTTPS + WSS (session cookie, Origin-checked)
                 ▼
   ┌──────── Caddy (TLS) ────────┐
   │  /            → web  :3000  │   Next.js UI (no secrets, no background work)
   │  /api /ws     → api  :4000  │
   └─────────────────────────────┘
                 │
        ┌────────┴─────────┐
        │   API (Fastify)  │── PostgreSQL (metadata, events, audit)
        │  auth · RBAC     │── DATA_DIR (browser screenshots)
        │  WorkerHub       │
        │  DashboardHub    │
        └────────▲─────────┘
                 │  WSS, worker-initiated, per-server credential
   ┌─────────────┴──────────────┐      ┌─────────────────────────┐
   │ Worker on VPS A (systemd)  │ ...  │ Worker on VPS N         │
   │  metrics · PTY · files     │      │                         │
   │  docker · git              │      │                         │
   │  agent supervisor ─ Claude Agent SDK / Codex SDK / custom   │
   │  browser supervisor ─ Playwright (isolated context + guard) │
   │  JSONL event log (survives disconnects)                     │
   └────────────────────────────┘      └─────────────────────────┘
```

## Packages

| Path | Role |
| --- | --- |
| `packages/protocol` | The typed, versioned contract (`PROTOCOL_VERSION`): zod schemas for every RPC method, event and domain object. Imported by all three apps. |
| `apps/api` | Control plane: authentication, authorization, persistence, the worker hub (RPC + events) and the dashboard hub (pub/sub). |
| `apps/worker` | Remote worker: executes operations on the machine it runs on and supervises agents and browsers. |
| `apps/web` | Dashboard. Talks only to the API. Holds no credentials and runs nothing in the background. |

## Control plane ⇄ worker protocol

* The **worker dials out** (`wss://…/ws/worker`) with `Authorization: Bearer <serverId>.<secret>`. No inbound port, SSH key or VPN is required on the server; Tailscale is optional (point `WORKER_URL` at a tailnet name).
* Frames are JSON: `hello` (system info + sessions the worker knows), `req`/`res` (control → worker RPC, correlated by id, with timeouts), `evt` (worker → control streams such as `metrics`, `pty.data`, `agent.event`; control → worker fire-and-forget such as `pty.input`).
* **Both sides validate.** The worker validates params before acting; the API validates every result and event a worker sends, and drops events for sessions that server does not own.
* The protocol version is checked at enrollment and at connect; a mismatch is refused with a clear message.

## Liveness and reconciliation

* A server is **online iff it has a live, ping-responsive socket** in `WorkerHub`. The stored status is never trusted on its own; on API start every server is reset to offline.
* Agent and browser events carry a per-session monotonically increasing `seq`, assigned by the worker and appended to a local JSONL log *before* being sent. The API stores them with primary key `(session_id, seq)` (idempotent).
* On every (re)connect the worker's `hello` lists its sessions and last seq. The API then: (1) asks for a **replay** of anything newer than what it has, (2) marks sessions it believes are running but the worker no longer has as **`lost`**, (3) **starts sessions that were queued** while the server was offline.
* The dashboard treats live events as hints. Its event socket reconnects with backoff; each reconnect refetches REST state, and the agent/browser views refetch events after their last contiguous `seq`. A dashboard outage cannot corrupt a session because the dashboard never owns one.
* **Backpressure:** metrics are droppable for slow dashboards; a dashboard that falls far behind on any topic is disconnected and resyncs. A worker pauses a PTY when its socket buffer grows and resumes when drained; a terminal client that cannot keep up is dropped and replays scrollback from the worker.

## Where things run

| Concern | Lives in | Why |
| --- | --- | --- |
| Agent / browser processes | worker | They must survive dashboard and control-plane restarts. |
| PTY + scrollback | worker (256 KB ring) | Terminal bytes never touch Postgres. |
| Structured agent/browser events | Postgres | Queryable history that survives refresh. |
| Screenshots | API `DATA_DIR` | Bulk binary; rows only reference them. |
| Provider keys | Postgres, AES-256-GCM | Decrypted only to hand to a worker at run start. |
| Queue / scheduling / workflow engine | Postgres | Cron slots are claimed with `FOR UPDATE SKIP LOCKED`; each workflow run's per-step state is its checkpoint, and step sessions get pre-assigned ids so a step can never start twice. Redis/BullMQ deliberately not added. |
| Metrics history | Postgres, one sample/min, 14 days | Live charts use the in-memory ring; longer ranges are bucketed in SQL. |
| Command runs (builds, deploys) | worker, as supervised sessions | Same event log, stop and history as agents; argv is executed exactly, never through a shell. |

## Adding a provider

Implement `Adapter` in `apps/worker/src/agents/` (one function: run a prompt, emit normalised `AgentEvent`s, honour the abort signal, optionally request approvals), register it in the manager, add its capabilities to `PROVIDER_CAPS` in `apps/api/src/routes/agents.ts`, and add the name to `AgentProvider` in the protocol.
