"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the page when the breaker changes.
 *
 * Subscribes to /api/breaker/stream and calls `router.refresh()`, which re-runs
 * the Server Component and swaps the result in without losing scroll position.
 * `EventSource` reconnects on its own, so there is no retry logic here.
 */
export function Live() {
  const router = useRouter();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/breaker/stream");
    // One item's stat lines arrive as several inserts, so several notifications
    // describe one change. Coalesce them into a single refresh.
    let pending: ReturnType<typeof setTimeout> | undefined;

    const onChange = () => {
      clearTimeout(pending);
      pending = setTimeout(() => router.refresh(), 200);
    };

    source.addEventListener("ready", () => setConnected(true));
    source.addEventListener("change", onChange);
    source.addEventListener("error", () => setConnected(false));

    return () => {
      clearTimeout(pending);
      source.close();
    };
  }, [router]);

  return (
    <span className="text-caption tracking-caption text-deep-fern inline-flex items-center gap-8 uppercase">
      <span
        aria-hidden
        className={`inline-block size-8 rounded-full ${
          connected ? "bg-lime-pulse" : "bg-circuit-border"
        }`}
      />
      {connected ? "live" : "reconnecting"}
    </span>
  );
}
