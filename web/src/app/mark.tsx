/**
 * The mark: a five-by-five bitmap S with a body behind it.
 *
 * Inline rather than an `<img>` so it costs no request and takes its colours
 * from the design tokens directly — change `--color-lime-pulse` in
 * design/theme.css and the mark follows, which an external file could not do.
 *
 * The receding plane is the same letter three units down-right at just under
 * half strength. That is the whole trick: depth from a second copy, not from a
 * shadow, which is the rule the rest of the interface follows.
 */
const BACK = [
  [7, 7],
  [18, 7],
  [29, 7],
  [40, 7],
  [51, 7],
  [7, 18],
  [7, 29],
  [18, 29],
  [29, 29],
  [40, 29],
  [51, 29],
  [51, 40],
  [7, 51],
  [18, 51],
  [29, 51],
  [40, 51],
  [51, 51],
];

const INK = [
  [4, 4],
  [15, 4],
  [26, 4],
  [37, 4],
  [4, 15],
  [4, 26],
  [15, 26],
  [37, 26],
  [48, 26],
  [48, 37],
  [15, 48],
  [26, 48],
  [37, 48],
  [48, 48],
];

/** The three cells carrying the exponent, stepping down the diagonal. */
const LIT = [
  [48, 4],
  [26, 26],
  [4, 48],
];

function cells(coords: number[][], fill: string, opacity?: number) {
  return (
    <g fill={fill} opacity={opacity}>
      {coords.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="10" height="10" />
      ))}
    </g>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      className="block shrink-0"
    >
      {cells(BACK, "var(--color-lime-pulse)", 0.45)}
      {cells(INK, "var(--color-phosphor-white)")}
      {cells(LIT, "var(--color-lime-pulse)")}
    </svg>
  );
}
