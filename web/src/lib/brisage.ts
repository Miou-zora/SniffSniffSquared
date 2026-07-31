/**
 * The brisage (item crushing) profitability model.
 *
 * Transcribed from Book 3.xlsx and verified against real captured crushes; see
 * ../../../docs/brisage-model.md for the measurements. Pure functions, no I/O,
 * so it can be unit-checked against that document without a database.
 */

/** A single stat line on an item, joined to the rune it produces. */
export interface StatLine {
  effectId: number;
  /** Short rune name, e.g. "Vi". Null when the effect maps to no rune. */
  rune: string | null;
  runeWeight: number;
  statPerRune: number;
  value: number;
  /** DofusDB item id of the rune, for pricing. */
  runeItemId: number | null;
}

export interface WeightedLine extends StatLine {
  /** `line_weight` — the weight this stat contributes. */
  weight: number;
}

/**
 * The weight one stat line carries.
 *
 * The trailing `+ 1` is part of the sheet (`Value!H2`) and is load-bearing:
 * without it the focus branch comes out low by `(lines + 1) / 2`. It is flat,
 * independent of the stat, and applies to every line that yields a rune.
 */
export function lineWeight(
  value: number,
  runeWeight: number,
  statPerRune: number,
  level: number,
): number {
  return (((3 * value * runeWeight) / statPerRune) * level) / 200 + 1;
}

/**
 * Lines that map to a rune, with their weights. Lines that map to nothing —
 * weapon damage lines, maluses — are dropped: they yield no rune and do not
 * contribute to the pool a focus harvests from.
 */
export function weighLines(lines: StatLine[], level: number): WeightedLine[] {
  return lines
    .filter((l) => l.rune !== null)
    .map((l) => ({
      ...l,
      weight: lineWeight(l.value, l.runeWeight, l.statPerRune, level),
    }));
}

/**
 * The weight harvested into one rune when that stat is focused: half its own
 * line plus half of every line on the item, its own included.
 *
 * Written `H + SUM(H)/2 - H/2` in the sheet, which is the same thing.
 */
export function focusWeight(own: number, total: number): number {
  return own / 2 + total / 2;
}

/** How many runes a weight yields at a given coefficient (a percentage). */
export function runeCount(
  weight: number,
  runeWeight: number,
  coefficient: number,
): number {
  return (weight / runeWeight) * (coefficient / 100);
}

/**
 * The coefficient after producing one more rune. It decays slowly and
 * non-linearly — about -0.005 per rune around n = 14.
 */
export function decayOnce(n: number): number {
  return -(2.63e-5 - 5.958e-10 * n) * n * n + n;
}

/** The coefficient after `steps` runes. */
export function decay(n: number, steps: number): number {
  let c = n;
  for (let i = 0; i < steps; i++) c = decayOnce(c);
  return c;
}

/** The columns the spreadsheet projects a crafting run across. */
export const COEFFICIENT_STEPS = [0, 1, 2, 3, 10, 100, 1000] as const;

export interface CoefficientColumn {
  label: string;
  coefficient: number;
}

/**
 * `100%` first as a ceiling, then the current coefficient and its decay after
 * n+1, n+2, n+3, n+10, n+100, n+1000 runes.
 */
export function coefficientColumns(current: number): CoefficientColumn[] {
  return [
    { label: "100%", coefficient: 100 },
    ...COEFFICIENT_STEPS.map((s) => ({
      label: s === 0 ? "n" : `n+${s}`,
      coefficient: decay(current, s),
    })),
  ];
}

export interface FocusOutcome {
  rune: string;
  runeItemId: number | null;
  effectId: number;
  runeWeight: number;
  /** This stat's own line weight. */
  own: number;
  /** Weight harvested when focusing it. */
  focusWeight: number;
  /** Runes produced, per coefficient column. */
  runes: number[];
  /** Kamas, per column. Null when the rune has no captured price. */
  value: (number | null)[];
  /** Unit price used, or null when none is known. */
  unitPrice: number | null;
}

/**
 * What each possible focus yields, across every coefficient column.
 *
 * One entry per stat line that produces a rune — focusing a stat you do not
 * have is not a choice the game offers.
 */
export function focusOutcomes(
  lines: WeightedLine[],
  columns: CoefficientColumn[],
  priceByRuneItemId: Map<number, number>,
): FocusOutcome[] {
  const total = lines.reduce((sum, l) => sum + l.weight, 0);
  return lines.map((l) => {
    const fw = focusWeight(l.weight, total);
    const runes = columns.map((c) => runeCount(fw, l.runeWeight, c.coefficient));
    const unitPrice =
      l.runeItemId !== null ? (priceByRuneItemId.get(l.runeItemId) ?? null) : null;
    return {
      rune: l.rune as string,
      runeItemId: l.runeItemId,
      effectId: l.effectId,
      runeWeight: l.runeWeight,
      own: l.weight,
      focusWeight: fw,
      runes,
      value: runes.map((r) => (unitPrice === null ? null : r * unitPrice)),
      unitPrice,
    };
  });
}

/**
 * Crushing with no focus: every line yields its own rune independently, so the
 * total is worth summing separately rather than being one of the focus options.
 */
export function noFocusOutcome(
  lines: WeightedLine[],
  columns: CoefficientColumn[],
  priceByRuneItemId: Map<number, number>,
): { runes: number[]; value: (number | null)[]; anyPriced: boolean } {
  const runes = columns.map((c) =>
    lines.reduce((sum, l) => sum + runeCount(l.weight, l.runeWeight, c.coefficient), 0),
  );
  let anyPriced = false;
  const value = columns.map((c) => {
    let kamas = 0;
    for (const l of lines) {
      const price =
        l.runeItemId !== null ? priceByRuneItemId.get(l.runeItemId) : undefined;
      if (price === undefined) continue;
      anyPriced = true;
      kamas += runeCount(l.weight, l.runeWeight, c.coefficient) * price;
    }
    return kamas;
  });
  return { runes, value: anyPriced ? value : columns.map(() => null), anyPriced };
}

/**
 * Profit against what the item cost, as a percentage. `+50` means the runes are
 * worth half again what the item did.
 */
export function profitPercent(value: number, itemCost: number): number | null {
  if (!itemCost) return null;
  return (value * 100) / itemCost - 100;
}
