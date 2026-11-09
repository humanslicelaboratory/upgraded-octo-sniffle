export function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}
export function halton(index, base) {
  let fraction = 1, result = 0, value = index;
  while (value > 0) { fraction /= base; result += fraction * (value % base); value = Math.floor(value / base); }
  return result;
}
export function polygonArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}
export function polygonCentroid(polygon) {
  let area = 0, x = 0, y = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross; x += (a.x + b.x) * cross; y += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-6) return polygon.reduce((p, q) => ({ x: p.x + q.x / polygon.length, y: p.y + q.y / polygon.length }), { x: 0, y: 0 });
  return { x: x / (3 * area), y: y / (3 * area) };
}
export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const cross = ((a.y > point.y) !== (b.y > point.y)) && (point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-9) + a.x);
    if (cross) inside = !inside;
  }
  return inside;
}
export function clipHalfPlane(polygon, a, b, c) {
  const result = [];
  if (!polygon.length) return result;
  const inside = p => a * p.x + b * p.y <= c + 1e-7;
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i], previous = polygon[(i + polygon.length - 1) % polygon.length];
    const currentInside = inside(current), previousInside = inside(previous);
    if (currentInside !== previousInside) {
      const dx = current.x - previous.x, dy = current.y - previous.y;
      const denominator = a * dx + b * dy;
      const t = Math.abs(denominator) < 1e-9 ? 0 : (c - a * previous.x - b * previous.y) / denominator;
      result.push({ x: previous.x + t * dx, y: previous.y + t * dy });
    }
    if (currentInside) result.push(current);
  }
  return result;
}
export function makeSites(polygon, count, seed) {
  const xs = polygon.map(point => point.x), ys = polygon.map(point => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const sites = [], offset = seed % 997 + 1;
  for (let i = 0, attempt = 1; i < count && attempt < count * 120; attempt += 1) {
    const point = { x: minX + halton(offset + attempt * 17, 2) * (maxX - minX), y: minY + halton(offset + attempt * 31, 3) * (maxY - minY) };
    if (pointInPolygon(point, polygon)) { sites.push(point); i += 1; }
  }
  const center = polygonCentroid(polygon);
  while (sites.length < count) {
    const angle = sites.length * 2.399963;
    sites.push({ x: center.x + Math.cos(angle) * (maxX - minX) * .08, y: center.y + Math.sin(angle) * (maxY - minY) * .08 });
  }
  return sites;
}
export function computePowerCells(polygon, sites, weights) {
  return sites.map((site, index) => {
    let cell = polygon.slice();
    for (let other = 0; other < sites.length && cell.length >= 3; other += 1) {
      if (other === index) continue;
      const target = sites[other];
      const a = 2 * (target.x - site.x), b = 2 * (target.y - site.y);
      const c = target.x * target.x + target.y * target.y - site.x * site.x - site.y * site.y + weights[index] - weights[other];
      cell = clipHalfPlane(cell, a, b, c);
    }
    return cell;
  });
}
export function layoutPowerCells(polygon, items, parentId) {
  if (items.length === 1) return [polygon];
  const area = polygonArea(polygon);
  const xs = polygon.map(point => point.x), ys = polygon.map(point => point.y);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const total = items.reduce((sum, item) => sum + Math.max(1, item.size || 0), 0);
  const targets = items.map(item => Math.max(1, item.size || 0) / total);
  const sites = makeSites(polygon, items.length, hashString(parentId));
  const weights = new Array(items.length).fill(0);
  let cells = computePowerCells(polygon, sites, weights);
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const current = cells.map(cell => polygonArea(cell));
    for (let i = 0; i < weights.length; i += 1) {
      const currentRatio = current[i] / (area || 1);
      const error = targets[i] - currentRatio;
      weights[i] = Math.max(-diagonal * diagonal * .8, Math.min(diagonal * diagonal * .8, weights[i] + error * diagonal * diagonal * .12));
    }
    cells = computePowerCells(polygon, sites, weights);
  }
  return cells;
}
