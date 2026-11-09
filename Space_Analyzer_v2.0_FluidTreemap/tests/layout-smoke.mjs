import assert from 'node:assert/strict';
import { layoutPowerCells, polygonArea } from '../src/fluid-layout.mjs';

const rect = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 600 }, { x: 0, y: 600 }];
const targetArea = polygonArea(rect);

for (const count of [4, 12, 18]) {
  const entries = Array.from({ length: count }, (_, index) => ({ id: `equal-${count}-${index}`, size: 100 }));
  const cells = layoutPowerCells(rect, entries, `equal-${count}`);
  const areas = cells.map(polygonArea);
  const sum = areas.reduce((total, area) => total + area, 0);
  assert.equal(cells.length, count);
  assert.ok(Math.abs(sum - targetArea) < 1, `cells should cover parent polygon (${count})`);
  const maximumDeviation = Math.max(...areas.map(area => Math.abs(area / sum - 1 / count)));
  assert.ok(maximumDeviation < 0.001, `equal-size area deviation too high (${count}): ${maximumDeviation}`);
}

const weighted = [500, 250, 150, 100].map((size, index) => ({ id: `weighted-${index}`, size }));
const weightedAreas = layoutPowerCells(rect, weighted, 'weighted-root').map(polygonArea);
const weightedTotal = weightedAreas.reduce((total, area) => total + area, 0);
const expected = [0.5, 0.25, 0.15, 0.1];
weightedAreas.forEach((area, index) => assert.ok(Math.abs(area / weightedTotal - expected[index]) < 0.002));

const nested = [{ x: 100, y: 100 }, { x: 620, y: 120 }, { x: 580, y: 470 }, { x: 130, y: 450 }];
const nestedEntries = [50, 30, 20].map((size, index) => ({ id: `nested-${index}`, size }));
const nestedCells = layoutPowerCells(nested, nestedEntries, 'nested-root');
const nestedTotal = nestedCells.reduce((total, cell) => total + polygonArea(cell), 0);
assert.ok(Math.abs(nestedTotal - polygonArea(nested)) < 1, 'nested cells should cover parent polygon');

console.log('Fluid layout smoke tests passed: weighted areas, equal areas, and nested polygon coverage.');
