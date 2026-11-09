/** Couleurs proposées pour distinguer les connexions (rouge = production, vert = développement…). */
export const COLORS = {
  blue: '#3b82f6',
  green: '#22c55e',
  red: '#ef4444',
  orange: '#f97316',
  purple: '#a855f7',
  teal: '#14b8a6',
  pink: '#ec4899',
  yellow: '#eab308',
  gray: '#9ca3af',
} as const;

export type ColorKey = keyof typeof COLORS;

export const COLOR_KEYS = Object.keys(COLORS) as ColorKey[];

export function colorHex(key?: string): string | undefined {
  return key && key in COLORS ? COLORS[key as ColorKey] : undefined;
}

/** Première couleur pas encore utilisée par une autre connexion. */
export function nextColor(used: (string | undefined)[]): ColorKey {
  const free = COLOR_KEYS.find((k) => !used.includes(k));
  return free ?? COLOR_KEYS[used.length % COLOR_KEYS.length];
}

/** Icône « base de données » colorée (SVG en data: URI) pour l'arborescence. */
export function dbIconSvg(hex: string, opacity = 1): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="${hex}" fill-opacity="${opacity}">` +
    '<ellipse cx="12" cy="5" rx="8" ry="3"/>' +
    '<path d="M4 6.4a8 3 0 0 0 16 0v2.6a8 3 0 0 1-16 0z"/>' +
    '<path d="M4 10.6a8 3 0 0 0 16 0v2.6a8 3 0 0 1-16 0z"/>' +
    '<path d="M4 14.8a8 3 0 0 0 16 0v2.6a8 3 0 0 1-16 0z"/></svg>'
  );
}
