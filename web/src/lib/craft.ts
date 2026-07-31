/**
 * What a craft actually costs to buy, off the marketplace ladder.
 *
 * The HDV sells the same resource in batches of 1, 10, 100 and 1000 at four
 * independent prices, so "13 woods" is a shopping decision rather than a
 * multiplication: 13 singles, or one ten plus three singles, or two tens and
 * eat the overbuy. Pure functions, no I/O, same reason as brisage.ts.
 */

/** Batch sizes the marketplace sells, largest first. */
const SIZES = [1000, 100, 10, 1] as const;

/** One captured price ladder. A 0 means that batch size was not on sale. */
export interface Ladder {
  b1: number;
  b10: number;
  b100: number;
  b1000: number;
}

export interface Pick {
  size: number;
  count: number;
  /** Price of one batch of this size. */
  price: number;
}

export interface BuyPlan {
  picks: Pick[];
  /** Units bought, which is >= the quantity needed when a batch overshoots. */
  units: number;
  cost: number;
  /**
   * `mixed` filled greedily from the largest batch down, `cheapest` bought one
   * batch size for the lot because the per-unit spread made mixing wasteful.
   */
  rule: "mixed" | "cheapest";
}

/** The sizes this ladder actually quotes, largest first. */
function offered(ladder: Ladder): { size: number; price: number }[] {
  const bySize: Record<number, number> = {
    1: ladder.b1,
    10: ladder.b10,
    100: ladder.b100,
    1000: ladder.b1000,
  };
  return SIZES.map((size) => ({ size, price: bySize[size] ?? 0 })).filter(
    (o) => o.price > 0,
  );
}

function priceOf(picks: Pick[]): number {
  return picks.reduce((sum, p) => sum + p.count * p.price, 0);
}

function unitsOf(picks: Pick[]): number {
  return picks.reduce((sum, p) => sum + p.count * p.size, 0);
}

/**
 * Fill the order from the largest batch down, rounding up only when no batch is
 * small enough to finish it — 13 with tens and singles is 1x10 + 3x1, but 13
 * with tens alone is 2x10 rather than an order that comes up short.
 */
function mixedFill(quantity: number, sizes: { size: number; price: number }[]): Pick[] {
  const picks: Pick[] = [];
  let rest = quantity;
  for (const { size, price } of sizes) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      picks.push({ size, count, price });
      rest -= count * size;
    }
  }
  if (rest > 0) {
    // Nothing left small enough to fill the remainder, so overshoot by one of
    // the smallest batch on offer.
    const smallest = sizes[sizes.length - 1];
    if (!smallest) return picks;
    const existing = picks.find((p) => p.size === smallest.size);
    if (existing) existing.count += 1;
    else picks.push({ size: smallest.size, count: 1, price: smallest.price });
  }
  return picks;
}

/** One batch size for the whole order, rounded up, at the best total price. */
function singleSizeBest(
  quantity: number,
  sizes: { size: number; price: number }[],
): Pick[] {
  let best: Pick[] = [];
  let bestCost = Infinity;
  for (const { size, price } of sizes) {
    const count = Math.ceil(quantity / size);
    const cost = count * price;
    if (cost < bestCost) {
      bestCost = cost;
      best = [{ size, count, price }];
    }
  }
  return best;
}

/**
 * How much of a batch size's price advantage is worth mixing for.
 *
 * Below it the mixed fill wins on principle — it buys what the recipe asks for
 * and nothing more, which is what you would do at the counter. Above it one
 * batch size is so much better per unit that buying only that size, overbuy
 * included, is the real answer.
 */
export const SPREAD_TOLERANCE = 0.3;

/**
 * The cheapest sensible way to buy `quantity` units, or null when the ladder
 * quotes no price at all — which is absence of a price, not a price of nothing.
 */
export function planBuy(quantity: number, ladder: Ladder): BuyPlan | null {
  if (quantity <= 0) return null;
  const sizes = offered(ladder);
  if (sizes.length === 0) return null;

  const mixed = mixedFill(quantity, sizes);
  const cheapest = singleSizeBest(quantity, sizes);

  const used = mixed.map((p) => p.price / p.size);
  const spread = used.length > 1 ? Math.max(...used) / Math.min(...used) - 1 : 0;

  const takeMixed = used.length > 1 && spread <= SPREAD_TOLERANCE;
  const picks = takeMixed
    ? mixed
    : priceOf(cheapest) <= priceOf(mixed)
      ? cheapest
      : mixed;

  return {
    picks,
    units: unitsOf(picks),
    cost: priceOf(picks),
    rule: picks === mixed ? "mixed" : "cheapest",
  };
}

/** `2x10 + 3x1`, for showing what the plan actually buys. */
export function describePlan(plan: BuyPlan): string {
  return plan.picks.map((p) => `${p.count}x${p.size}`).join(" + ");
}
