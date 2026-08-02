/**
 * Where DofusDB draws an item's icon. Verified 200, 13-20 KB PNGs.
 *
 * Its own module because both sides need it: the server pages that render a
 * pile of resources, and the search box, which is a client component. Reaching
 * for it in `breaker.ts` would drag `pg` into the browser bundle.
 */
export function iconUrl(iconId: number): string {
  return `https://api.dofusdb.fr/img/items/${iconId}.png`;
}
