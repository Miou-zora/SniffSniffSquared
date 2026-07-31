import { subscribe } from "@/lib/notify";

/**
 * Server-sent events, one per change to the breaker.
 *
 * Backed by Postgres LISTEN/NOTIFY rather than polling: the sniffer's inserts
 * fire a trigger calling `pg_notify('breaker', ...)`, so a placement reaches the
 * browser as fast as it reaches the database.
 *
 * The LISTEN connection is shared process-wide — see lib/notify.ts for why a
 * connection per client leaks.
 */
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = (event: string, data = "") => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // The client went away mid-write.
          cleanup();
        }
      };

      request.signal.addEventListener("abort", cleanup);
      if (request.signal.aborted) return cleanup();

      try {
        unsubscribe = await subscribe((payload) => send("change", payload));
      } catch {
        send("error", "database unavailable");
        return cleanup();
      }

      send("ready");
      // Keeps proxies from dropping an idle connection, and gives the browser
      // something to notice when the server has gone.
      heartbeat = setInterval(() => send("ping"), HEARTBEAT_MS);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx and friends buffer by default, which defeats the point.
      "X-Accel-Buffering": "no",
    },
  });
}
