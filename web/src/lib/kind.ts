/**
 * Is this the kind of item you put in the crusher?
 *
 * Carrying rune-mapped stat lines is not the test, and that mistake is easy to
 * make twice: a rune *is* a stat line, so Rune Vi passes it and got a full
 * breaking projection — a page telling you what a rune is worth to turn into
 * runes. Percepteur gear is the same shape of wrong.
 *
 * The type name is what separates them, matched here rather than by `type_id`
 * because that column is only filled by the offline importer; everything the
 * read-side cache resolved has it NULL. `broken.ts` makes the same exclusion in
 * SQL for the catalogue — the two are one rule in two languages, so change
 * them together.
 */
export function isBreakableKind(type: string | null): boolean {
  if (type === null) return true;
  return !type.startsWith("Rune") && type !== "Fers de Percepteur";
}
