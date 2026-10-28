// The viewer's fixed shuffle of field lines (js/main.js lineOrder): its
// first N entries are the lines drawn. Copied here because main.js needs a DOM.
export function lineOrder(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx;
}
