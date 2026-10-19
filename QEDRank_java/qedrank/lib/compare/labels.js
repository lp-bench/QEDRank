// Greedy direct-label placement for a scatter plot, shared by the LaTeX figure and the web chart.
// Each label goes right, left, below or above its marker, whichever first overlaps no marker and
// no label placed before it (labels are placed top to bottom). Units are the caller's (cm or px).

const SIDES = ['right', 'left', 'below', 'above'];

function boxFor(p, side, gap) {
  const { x, y, w, h } = p;
  switch (side) {
    case 'left': return { x0: x - gap - w, x1: x - gap, y0: y - h / 2, y1: y + h / 2 };
    case 'below': return { x0: x - w / 2, x1: x + w / 2, y0: y - gap - h, y1: y - gap };
    case 'above': return { x0: x - w / 2, x1: x + w / 2, y0: y + gap, y1: y + gap + h };
    default: return { x0: x + gap, x1: x + gap + w, y0: y - h / 2, y1: y + h / 2 };
  }
}

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * @param {{id, x, y, w, h}[]} points  marker centres and label sizes; y grows upwards
 * @param {{gap?: number, r?: number, bounds?: {x0, x1, y0, y1}}} opts  marker radius, label gap, plot area
 * @returns {Map<id, side>}
 */
export function placeLabels(points, { gap = 0.15, r = 0.12, bounds = null } = {}) {
  const markers = points.map((p) => ({ x0: p.x - r, x1: p.x + r, y0: p.y - r, y1: p.y + r }));
  const placed = [];
  const out = new Map();
  for (const p of [...points].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let best = null;
    let bestScore = Infinity;
    for (const side of SIDES) {
      const box = boxFor(p, side, gap);
      let score = 0;
      for (const m of markers) if (overlaps(box, m)) score += 2;
      for (const q of placed) if (overlaps(box, q)) score += 3;
      if (bounds && (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1)) score += 1;
      if (score < bestScore) { best = { side, box }; bestScore = score; }
      if (score === 0) break;
    }
    placed.push(best.box);
    out.set(p.id, best.side);
  }
  return out;
}
