"use client";

import { useSyncExternalStore } from "react";

/** Nothing ever changes, so nothing ever needs to notify. */
const subscribe = () => () => {};

/**
 * A timestamp in *your* timezone, not the server's.
 *
 * `toLocaleTimeString` reads the zone of whatever runs it, so rendering it on
 * the server produces UTC — both wrong for the reader and a hydration mismatch
 * the moment the browser re-renders it as local.
 *
 * `useSyncExternalStore` is the way to say "the server and the client disagree,
 * and that is fine": its server snapshot is what gets rendered into the HTML
 * and matched during hydration, and the client snapshot takes over immediately
 * after. Doing the same with an effect works but sets state during hydration,
 * which is a cascading render for something that could be decided up front.
 *
 * The placeholder is a space rather than nothing, so the line does not jump
 * when the time lands.
 */
export function LocalTime({ iso }: { iso: string }) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return <span>{hydrated ? new Date(iso).toLocaleTimeString("fr-FR") : " "}</span>;
}
