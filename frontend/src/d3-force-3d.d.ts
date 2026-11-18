declare module "d3-force-3d" {
  // Minimal typings for the forces used by LiveGraph (d3-force-3d ships without types).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Acc<T> = number | ((d: T) => number);
  interface Force<T> { (alpha: number): void; strength(s: Acc<T>): Force<T>; radius?(r: Acc<T>): Force<T> }
  export function forceCollide<T>(radius?: Acc<T>): Force<T>;
  export function forceX<T>(x?: Acc<T>): Force<T>;
  export function forceY<T>(y?: Acc<T>): Force<T>;
}
