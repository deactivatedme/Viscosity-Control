import type { SandboxMode, ThreadOptions } from '@openai/codex-sdk';
import type { PermissionMode } from '@viscosity/protocol';
import { clip, type Adapter } from './types';

/** Codex exec is non-interactive: there is no per-action approval, so modes map onto its sandbox. */
const SANDBOX: Record<PermissionMode, SandboxMode> = {
  readonly: 'read-only',
  ask: 'workspace-write',
  acceptEdits: 'workspace-write',
  auto: 'danger-full-access',
};

export const runCodex: Adapter = async (ctx) => {
  const { Codex } = await import('@openai/codex-sdk');
  const { params } = ctx;
  const codex = new Codex({ env: ctx.env, apiKey: ctx.env.OPENAI_API_KEY ?? ctx.env.CODEX_API_KEY });
  const options: ThreadOptions = {
    model: params.model,
    workingDirectory: ctx.cwd,
    skipGitRepoCheck: true,
    sandboxMode: SANDBOX[params.permissionMode],
    approvalPolicy: 'never',
  };
  const thread = params.resume ? codex.resumeThread(params.resume, options) : codex.startThread(options);
  const { events } = await thread.runStreamed(params.prompt, { signal: ctx.signal });
  let summary = '';
  for await (const ev of events) {
    switch (ev.type) {
      case 'thread.started':
        ctx.setProviderSession(ev.thread_id);
        ctx.emit({ type: 'status', status: 'running' });
        break;
      case 'item.started': {
        const item = ev.item;
        if (item.type === 'command_execution') ctx.emit({ type: 'tool_use', id: item.id, name: 'shell', input: { command: item.command } });
        else if (item.type === 'mcp_tool_call') ctx.emit({ type: 'tool_use', id: item.id, name: `${item.server}.${item.tool}`, input: item.arguments });
        else if (item.type === 'web_search') ctx.emit({ type: 'tool_use', id: item.id, name: 'web_search', input: { query: item.query } });
        break;
      }
      case 'item.completed': {
        const item = ev.item;
        if (item.type === 'agent_message') {
          summary = item.text;
          ctx.emit({ type: 'text', text: item.text });
        } else if (item.type === 'reasoning') {
          ctx.emit({ type: 'thinking', text: item.text });
        } else if (item.type === 'command_execution') {
          ctx.emit({ type: 'tool_result', id: item.id, output: clip(item.aggregated_output), isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0 });
        } else if (item.type === 'file_change') {
          if (item.status === 'failed') ctx.emit({ type: 'error', message: `patch failed: ${item.changes.map((c) => c.path).join(', ')}` });
          else for (const change of item.changes) ctx.emit({ type: 'file_change', path: change.path, kind: change.kind });
        } else if (item.type === 'mcp_tool_call') {
          ctx.emit({ type: 'tool_result', id: item.id, output: clip(item.error?.message ?? JSON.stringify(item.result?.content ?? '')), isError: item.status === 'failed' });
        } else if (item.type === 'error') {
          ctx.emit({ type: 'error', message: item.message });
        }
        break;
      }
      case 'turn.completed':
        // Codex reports tokens only; cost is not exposed by the SDK.
        ctx.emit({ type: 'usage', inputTokens: ev.usage.input_tokens, outputTokens: ev.usage.output_tokens, costUsd: null });
        break;
      case 'turn.failed':
        throw new Error(ev.error.message);
      case 'error':
        throw new Error(ev.message);
    }
  }
  return { ok: true, summary };
};
