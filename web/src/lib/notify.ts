import { Client } from "pg";

/**
 * One Postgres LISTEN connection for the whole process, fanned out to every
 * subscriber.
 *
 * The obvious implementation — a `LISTEN` connection per SSE client — leaks.
 * `LISTEN` is connection state so it cannot come from the pool, and a client
 * that vanishes without a clean close (browser killed, laptop slept, network
 * dropped) does not reliably fire the request's abort signal. The connection
 * then sits idle forever; measured, one survived five minutes with no client
 * behind it. Enough page reloads and Postgres runs out of connections.
 *
 * One connection regardless of how many tabs are open removes the failure mode
 * rather than racing it: a leaked subscriber costs a closure, not a connection.
 */

type Listener = (payload: string) => void;

interface Hub {
  client: Client | null;
  listeners: Set<Listener>;
  connecting: Promise<void> | null;
}

const globalForNotify = globalThis as unknown as { breakerHub?: Hub };

const hub: Hub = (globalForNotify.breakerHub ??= {
  client: null,
  listeners: new Set(),
  connecting: null,
});

const RETRY_MS = 2_000;

async function ensureConnected(): Promise<void> {
  if (hub.client) return;
  if (hub.connecting) return hub.connecting;

  hub.connecting = (async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    // A dropped connection stops delivering silently, which looks exactly like
    // "nothing is happening". Reconnect instead, as long as anyone is listening.
    const onGone = () => {
      if (hub.client === client) hub.client = null;
      if (hub.listeners.size > 0) {
        setTimeout(() => {
          void ensureConnected().catch(() => {});
        }, RETRY_MS);
      }
    };
    client.on("error", onGone);
    client.on("end", onGone);
    client.on("notification", (msg) => {
      for (const listener of hub.listeners) listener(msg.payload ?? "");
    });

    await client.connect();
    await client.query("LISTEN breaker");
    hub.client = client;
  })();

  try {
    await hub.connecting;
  } finally {
    hub.connecting = null;
  }
}

/** Subscribe to breaker changes. Returns an unsubscribe function. */
export async function subscribe(listener: Listener): Promise<() => void> {
  hub.listeners.add(listener);
  try {
    await ensureConnected();
  } catch (err) {
    hub.listeners.delete(listener);
    throw err;
  }
  return () => {
    hub.listeners.delete(listener);
  };
}
