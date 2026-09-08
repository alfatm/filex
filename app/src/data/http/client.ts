/**
 * The one place that talks to filex over HTTP. Everything goes through `request`, so the session cookie, the error
 * shape and the "you are signed out" path are decided once.
 *
 * Paths are relative to the origin: the dev server proxies `/api` to the backend (vite.config.ts), and in production
 * the SPA is served by filex itself.
 */

/** Thrown for every non-2xx answer; the repository turns the interesting ones into its own errors. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Raised once per session when the server says the caller is not signed in. */
export const UNAUTHORIZED_EVENT = 'filex:unauthorized';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as a JSON body. */
  body?: unknown;
  /** Appended as a query string; `undefined` and `null` values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** The server's own message when it sends one, so a user-facing error is not just "500". */
function messageOf(status: number, body: unknown): string {
  const detail = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : '';
  return detail ? `${status}: ${detail}` : `HTTP ${status}`;
}

/** The shared tail of every call: read the body, raise the interesting statuses, hand back the payload. */
async function settle<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload: unknown = text ? safeParse(text) : null;
  if (!response.ok) {
    // Whoever is listening (the shell) sends the user to the login page; the caller still gets its rejection.
    if (response.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new HttpError(response.status, payload, messageOf(response.status, payload));
  }
  return payload as T;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = options;
  const response = await fetch(withQuery(path, query), {
    method,
    signal,
    // The session is a cookie; nothing here carries a bearer token.
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return settle<T>(response);
}

/**
 * One chunk of a staged upload. It bypasses `request` too: the body is bytes rather than JSON, and `Content-Range`
 * is what tells the server where they belong — the offset is not in the URL.
 */
export async function putChunk<T>(path: string, range: string, chunk: Blob, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-range': range },
    body: chunk,
    signal,
  });
  return settle<T>(response);
}

/**
 * A POST whose answer arrives in pieces: filex writes server-sent events, this yields each event's JSON payload as it
 * lands. Used by the assistant, where the answer is produced at reading speed and stopping half-way has to mean
 * something — aborting `signal` closes the connection, which is what the server reads as "stop".
 *
 * Only the `data:` lines are read. filex puts the event's kind inside the payload rather than on an `event:` line, so
 * there is one parser and one switch on the other side.
 */
export async function* streamJSON<T>(path: string, body: unknown, signal?: AbortSignal): AsyncIterable<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  // A refusal (429 for a turn already running, 503 for an unconfigured assistant) arrives as JSON, not as a stream.
  if (!response.ok) await settle(response);
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(response.status, null, 'the server did not send a stream');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // An event ends at a blank line; anything after the last one is a partial frame that waits for more bytes.
      let end = buffer.indexOf('\n\n');
      for (; end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of frame.split('\n')) {
          const data = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (data) yield JSON.parse(data) as T;
        }
      }
    }
  } finally {
    // Whether the reader stopped, threw, or the caller broke out of the loop, the connection is released — on the
    // server that cancellation is the difference between a stopped answer and one that keeps being generated.
    await reader.cancel().catch(() => {});
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A handler that answers with plain text (or nothing) is not an error by itself.
    return text;
  }
}
