'use client';

import type { StreamEvent } from 'shared';

export async function connectSSEStream(
  projectId: string,
  getToken: () => Promise<string | null>,
  onEvent: (event: StreamEvent) => void,
  onClose?: () => void,
): Promise<() => void> {
  const token = await getToken();
  const baseURL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

  const response = await fetch(
    `${baseURL}/api/v1/projects/${projectId}/stream`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(`SSE connection failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aborted = false;

  const abort = () => {
    aborted = true;
    reader.cancel();
    onClose?.();
  };

  (async () => {
    try {
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE format: "event: <type>\ndata: <json>\n\n"
        const messages = buffer.split('\n\n');
        buffer = messages.pop() ?? '';

        for (const msg of messages) {
          const lines = msg.split('\n');
          let eventType = '';
          let dataLine = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            if (line.startsWith('data: ')) dataLine = line.slice(6).trim();
          }

          if (dataLine) {
            try {
              const parsed = JSON.parse(dataLine) as StreamEvent;
              onEvent(parsed);
            } catch {
              // ignore malformed events
            }
          }
        }
      }
    } catch (err) {
      if (!aborted) {
        onEvent({
          type: 'error',
          error_type: 'connection_error' as never,
          message: err instanceof Error ? err.message : 'Stream connection lost',
        });
      }
    } finally {
      onClose?.();
    }
  })();

  return abort;
}
