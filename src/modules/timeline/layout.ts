// Mise en page des paroles, déterministe et indépendante du navigateur.
// Les retours à la ligne sont décidés ici : le rendu les applique tels quels (white-space: pre).

/** Largeur moyenne d'un caractère en fraction de la taille de police (sérif, estimation prudente). */
export const CHAR_WIDTH = 0.52;

export function textWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) w += /[mwMW@]/.test(ch) ? 0.85 : /[ilj.,;:'’!|]/.test(ch) ? 0.3 : ch === ' ' ? 0.28 : /[A-ZÉÈÀ]/.test(ch) ? 0.68 : CHAR_WIDTH;
  return w * fontSize;
}

/** Retour à la ligne glouton par mots. Les « \n » explicites (display par format) sont respectés. */
export function wrap(text: string, fontSize: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (cur && textWidth(cand, fontSize) > maxWidth) {
        out.push(cur);
        cur = word;
      } else cur = cand;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Choisit la plus grande taille de police (entre min et max, en px) pour laquelle le texte tient
 * en `maxLines` lignes dans `maxWidth`. Si impossible, taille min et `overflow = true`.
 */
export function fitLines(text: string, minPx: number, maxPx: number, maxWidth: number, maxLines: number): { fontSize: number; lines: string[]; overflow: boolean } {
  for (let fs = Math.floor(maxPx); fs >= Math.ceil(minPx); fs -= Math.max(1, Math.round(maxPx / 60))) {
    const lines = wrap(text, fs, maxWidth);
    if (lines.length <= maxLines && lines.every((l) => textWidth(l, fs) <= maxWidth)) return { fontSize: fs, lines, overflow: false };
  }
  const fs = Math.ceil(minPx);
  const lines = wrap(text, fs, maxWidth);
  return { fontSize: fs, lines, overflow: lines.length > maxLines || lines.some((l) => textWidth(l, fs) > maxWidth) };
}
