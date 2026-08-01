"use client";

import { useEffect, useState } from "react";

/**
 * A timestamp in *your* timezone, not the server's.
 *
 * `toLocaleTimeString` reads the zone of whatever runs it, so rendering it on
 * the server produces UTC — both wrong for the reader and a hydration mismatch
 * the moment the browser re-renders it as local. Formatting after mount is what
 * makes the two agree: the first client render matches the server byte for
 * byte, and the real time replaces the placeholder immediately after.
 *
 * The placeholder is an em space rather than empty, so the line does not jump
 * when the time lands.
 */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    setText(new Date(iso).toLocaleTimeString("fr-FR"));
  }, [iso]);

  return <span suppressHydrationWarning>{text ?? " "}</span>;
}
