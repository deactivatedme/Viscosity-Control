import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import { clip, type Adapter, type RunContext } from './types';

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'WebSearch', 'WebFetch']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Decides each tool call the SDK's permission system escalates, per the session's permission mode. */
function permissionGate(ctx: RunContext): CanUseTool {
  const mode = ctx.params.permissionMode;
  return async (toolName, input) => {
    const allow = { behavior: 'allow', updatedInput: input } as const;
    if (mode === 'auto' || READ_ONLY.has(toolName)) return allow;
    if (mode === 'readonly') return { behavior: 'deny', message: 'This session is read-only; modifications are not permitted.' };
    if (mode === 'acceptEdits' && EDITS.has(toolName)) return allow;
    const { decision, reason } = await ctx.requestApproval(toolName, input);
    return decision === 'allow' ? allow : { behavior: 'deny', message: reason || 'Denied by the operator.' };
  };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`)).join('\n');
}

export const runClaude: Adapter = async (ctx) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { params } = ctx;
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  // Filesystem settings are not loaded: a repository's .claude/settings.json could otherwise
  // pre-approve its own commands and bypass the dashboard approval gate. CLAUDE.md is still
  // honoured by appending it to the system prompt.
  const claudeMd = join(ctx.cwd, 'CLAUDE.md');
  const append = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8').slice(0, 64_000) : undefined;
  let stderrTail = '';
  const options: Options = {
    cwd: ctx.cwd,
    env: ctx.env,
    abortController,
    model: params.model,
    resume: params.resume,
    settingSources: [],
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
    permissionMode: params.permissionMode === 'readonly' ? 'plan' : params.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default',
    canUseTool: permissionGate(ctx),
    stderr: (data) => (stderrTail = (stderrTail + data).slice(-2000)),
  };

  const pendingEdits = new Map<string, { path: string; kind: string }>();
  let outcome = { ok: false, summary: 'Claude ended without a result message' };
  try {
    for await (const msg of query({ prompt: params.prompt, options })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        ctx.setProviderSession(msg.session_id);
        ctx.emit({ type: 'status', status: 'running' });
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) ctx.emit({ type: 'text', text: block.text });
          else if (block.type === 'thinking' && block.thinking) ctx.emit({ type: 'thinking', text: block.thinking });
          else if (block.type === 'tool_use') {
            ctx.emit({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
            const path = (block.input as { file_path?: unknown } | null)?.file_path;
            if (EDITS.has(block.name) && typeof path === 'string') pendingEdits.set(block.id, { path, kind: block.name === 'Write' ? 'write' : 'edit' });
          }
        }
      } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            ctx.emit({ type: 'tool_result', id: block.tool_use_id, output: clip(resultText(block.content)), isError: block.is_error === true });
            // Report a file change only once the edit actually succeeded (not when it was merely requested or denied).
            const edit = pendingEdits.get(block.tool_use_id);
            pendingEdits.delete(block.tool_use_id);
            if (edit && block.is_error !== true) ctx.emit({ type: 'file_change', ...edit });
          }
        }
      } else if (msg.type === 'result') {
        ctx.setProviderSession(msg.session_id);
        const u = msg.usage;
        ctx.emit({
          type: 'usage',
          inputTokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
          outputTokens: u.output_tokens,
          costUsd: msg.total_cost_usd,
        });
        outcome =
          msg.subtype === 'success'
            ? { ok: !msg.is_error, summary: msg.result }
            : { ok: false, summary: msg.errors.join('; ') || msg.subtype };
      }
    }
  } catch (err) {
    // Claude Code's own stderr usually explains a startup failure (bad credential, missing binary).
    if (!ctx.signal.aborted && stderrTail.trim()) throw new Error(`${(err as Error).message}\n${stderrTail.trim()}`, { cause: err });
    throw err;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
  return outcome;
};
