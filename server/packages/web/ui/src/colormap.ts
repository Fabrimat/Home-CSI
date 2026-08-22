/**
 * A compact viridis approximation (perceptually-uniform, colour-blind
 * safe), used for the CSI waterfall. Five anchor stops sampled from the
 * real matplotlib viridis LUT, linearly interpolated in RGB — dense enough
 * that the interpolation error versus the full 256-entry LUT is
 * imperceptible for a heatmap at typical waterfall resolutions.
 */
const VIRIDIS_STOPS: Array<[number, number, number]> = [
  [0x44, 0x01, 0x54], // 0.00
  [0x3b, 0x52, 0x8b], // 0.25
  [0x21, 0x90, 0x8d], // 0.50
  [0x5d, 0xc9, 0x63], // 0.75
  [0xfd, 0xe7, 0x25], // 1.00
];

/** Maps t in [0, 1] to an [r, g, b] triple (each 0-255). Values outside [0,1] are clamped. */
export function viridis(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (VIRIDIS_STOPS.length - 1);
  const i = Math.min(VIRIDIS_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - i;
  const a = VIRIDIS_STOPS[i] as [number, number, number];
  const b = VIRIDIS_STOPS[i + 1] as [number, number, number];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

export function viridisCss(t: number): string {
  const [r, g, b] = viridis(t);
  return `rgb(${r}, ${g}, ${b})`;
}
