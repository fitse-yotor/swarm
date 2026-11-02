// Node glyphs rendered as SVG textures for @sigma/node-image. Shape encodes entity type
// (accessible without color); outline encodes review status, mirroring the prototype.
import type { ClaimStatus } from "../api";
import type { Shape } from "../vocab";

const R = 40; // radius in a 128 viewBox, leaving room for status rings
function path(shape: Shape, r = R): string {
  const c = 64;
  const poly = (k: number, rot: number) => Array.from({ length: k }, (_, i) => {
    const a = rot + (i * Math.PI * 2) / k;
    return `${(c + Math.cos(a) * r).toFixed(1)},${(c + Math.sin(a) * r).toFixed(1)}`;
  }).join(" ");
  switch (shape) {
    case "square": case "doc": return `<rect x="${c - r * 0.85}" y="${c - r * 0.85}" width="${r * 1.7}" height="${r * 1.7}" rx="${r * 0.25}"/>`;
    case "diamond": return `<polygon points="${poly(4, -Math.PI / 2)}"/>`;
    case "triangle": return `<polygon points="${c},${c - r} ${c + r * 0.95},${c + r * 0.7} ${c - r * 0.95},${c + r * 0.7}"/>`;
    case "hexagon": return `<polygon points="${poly(6, 0)}"/>`;
    case "pentagon": return `<polygon points="${poly(5, -Math.PI / 2)}"/>`;
    case "octagon": return `<polygon points="${poly(8, Math.PI / 8)}"/>`;
    case "star": return `<polygon points="${Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? r * 0.5 : r * 1.12;
      return `${(c + Math.cos(a) * k).toFixed(1)},${(c + Math.sin(a) * k).toFixed(1)}`; }).join(" ")}"/>`;
    case "cross": { const w = r * 0.42; return `<polygon points="${c - w},${c - r} ${c + w},${c - r} ${c + w},${c - w} ${c + r},${c - w} ${c + r},${c + w} ${c + w},${c + w} ${c + w},${c + r} ${c - w},${c + r} ${c - w},${c + w} ${c - r},${c + w} ${c - r},${c - w} ${c - w},${c - w}"/>`; }
    default: return `<circle cx="${c}" cy="${c}" r="${r}"/>`;
  }
}

export interface GlyphPalette { bg: string; acc: string; warn: string; err: string; tx2: string }

const cache = new Map<string, string>();
export function glyph(shape: Shape, fill: string, status: ClaimStatus, opts: { dim: boolean; selected: boolean; pal: GlyphPalette }): string {
  const key = `${shape}|${fill}|${status}|${opts.dim}|${opts.selected}|${opts.pal.bg}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { pal } = opts;
  const hollow = shape === "ring" || shape === "doc" || shape === "octagon" || status === "rejected" || status === "excluded";
  const stroke = status === "rejected" ? pal.err : status === "excluded" ? pal.tx2 : fill;
  const body = hollow
    ? `<g fill="${pal.bg}" stroke="${stroke}" stroke-width="12">${path(shape, R - 6)}</g>`
    : `<g fill="${fill}" stroke="${pal.bg}" stroke-width="4">${path(shape)}</g>`;
  let ring = "";
  if (status === "hypothesis")  // generated hypotheses: a dashed ring, like unreviewed claims, plus the star shape
    ring = `<g fill="none" stroke="${pal.warn}" stroke-width="5" stroke-dasharray="10 7">${path(shape, R + 11)}</g>`;
  if (status === "simulated")
    ring = `<g fill="none" stroke="${pal.acc}" stroke-width="4" stroke-dasharray="2 8" stroke-linecap="round">${path(shape, R + 11)}</g>`;
  if (status === "pending" || status === "conflict")
    ring = `<g fill="none" stroke="${status === "conflict" ? pal.warn : pal.tx2}" stroke-width="5" stroke-dasharray="10 7">${path(shape, R + 11)}</g>`;
  if (status === "manual" || status === "selected") ring = `<g fill="none" stroke="${pal.acc}" stroke-width="5">${path(shape, R + 11)}</g>`;
  const sel = opts.selected ? `<g fill="none" stroke="${pal.acc}" stroke-width="6">${path(shape, R + 17)}</g>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><g opacity="${opts.dim ? 0.16 : 1}">${body}${ring}${sel}</g></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(key, url);
  return url;
}

export function withAlpha(color: string, a: number): string {
  const m = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
