import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface Envelope<E> {
  sessionId: string;
  seq: number;
  ts: number;
  event: E;
}

/**
 * Append-only JSONL log per session, one envelope per line, seq = line number.
 * It is the source of truth for replay after a control-plane disconnect, so events are
 * written (synchronously, which also fixes their order) before they are sent.
 */
export class EventLog<E> {
  private seqs = new Map<string, number>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  lastSeq(sessionId: string): number {
    let seq = this.seqs.get(sessionId);
    if (seq === undefined) {
      const file = this.file(sessionId);
      seq = 0;
      if (existsSync(file)) for (const byte of readFileSync(file)) if (byte === 10) seq++;
      this.seqs.set(sessionId, seq);
    }
    return seq;
  }

  append(sessionId: string, event: E): Envelope<E> {
    const envelope = { sessionId, seq: this.lastSeq(sessionId) + 1, ts: Date.now(), event };
    appendFileSync(this.file(sessionId), `${JSON.stringify(envelope)}\n`);
    this.seqs.set(sessionId, envelope.seq);
    return envelope;
  }

  async replay(sessionId: string, afterSeq: number, emit: (envelope: Envelope<E>) => void): Promise<number> {
    const file = this.file(sessionId);
    if (!existsSync(file)) return 0;
    let count = 0;
    for await (const line of createInterface({ input: createReadStream(file) })) {
      if (!line) continue;
      const envelope = JSON.parse(line) as Envelope<E>;
      if (envelope.seq > afterSeq) {
        emit(envelope);
        count++;
      }
    }
    return count;
  }

  /** Sessions touched within `maxAgeMs`, for the hello frame. */
  known(maxAgeMs: number): { id: string; lastSeq: number }[] {
    const cutoff = Date.now() - maxAgeMs;
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.jsonl') && statSync(join(this.dir, name)).mtimeMs >= cutoff)
      .map((name) => name.slice(0, -'.jsonl'.length))
      .map((id) => ({ id, lastSeq: this.lastSeq(id) }));
  }
}
