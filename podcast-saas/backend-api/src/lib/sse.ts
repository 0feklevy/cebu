import type { FastifyReply } from 'fastify';
import type { StreamEvent } from 'shared';

export class SSEEmitter {
  private closed = false;

  constructor(private readonly reply: FastifyReply) {}

  emit(event: StreamEvent): void {
    if (this.closed) return;
    const type = event.type;
    const data = JSON.stringify(event);
    this.reply.raw.write(`event: ${type}\ndata: ${data}\n\n`);
  }

  keepAlive(): NodeJS.Timeout {
    return setInterval(() => {
      if (!this.closed) {
        this.reply.raw.write(': keep-alive\n\n');
      }
    }, 15_000);
  }

  close(): void {
    this.closed = true;
    this.reply.raw.end();
  }
}

export function initSSE(reply: FastifyReply): SSEEmitter {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  return new SSEEmitter(reply);
}
