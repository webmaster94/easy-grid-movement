export interface GridOffset {
  i: number;
  j: number;
}

export interface ReachabilityAdapter {
  getNeighbors(offset: GridOffset): GridOffset[];
  getStepCost(from: GridOffset, to: GridOffset): number;
  canOccupy(offset: GridOffset): boolean;
  canTraverse(from: GridOffset, to: GridOffset): boolean;
}

interface QueueEntry {
  offset: GridOffset;
  cost: number;
}

class MinQueue {
  readonly #entries: QueueEntry[] = [];

  get size(): number {
    return this.#entries.length;
  }

  push(entry: QueueEntry): void {
    this.#entries.push(entry);
    let index = this.#entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentEntry = this.#entries[parent];
      if (!parentEntry || parentEntry.cost <= entry.cost) break;
      this.#entries[index] = parentEntry;
      index = parent;
    }
    this.#entries[index] = entry;
  }

  pop(): QueueEntry | undefined {
    const first = this.#entries[0];
    const last = this.#entries.pop();
    if (!first || !last || this.#entries.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let child = left;
      if (
        right < this.#entries.length &&
        (this.#entries[right]?.cost ?? Infinity) < (this.#entries[left]?.cost ?? Infinity)
      ) {
        child = right;
      }
      const childEntry = this.#entries[child];
      if (!childEntry || childEntry.cost >= last.cost) break;
      this.#entries[index] = childEntry;
      index = child;
    }
    this.#entries[index] = last;
    return first;
  }
}

export function offsetKey(offset: GridOffset): string {
  return `${offset.i},${offset.j}`;
}

export function parseOffsetKey(key: string): GridOffset {
  const [i, j] = key.split(",").map(Number);
  if (i === undefined || j === undefined || !Number.isFinite(i) || !Number.isFinite(j)) {
    throw new Error(`Invalid grid offset key: ${key}`);
  }
  return { i, j };
}

export function findReachableCosts(
  start: GridOffset,
  maximumCost: number,
  adapter: ReachabilityAdapter,
): Map<string, number> {
  const costs = new Map<string, number>();
  if (maximumCost < 0 || !adapter.canOccupy(start)) return costs;

  const queue = new MinQueue();
  costs.set(offsetKey(start), 0);
  queue.push({ offset: start, cost: 0 });

  while (queue.size > 0) {
    const current = queue.pop();
    if (!current) break;
    const currentKey = offsetKey(current.offset);
    if (current.cost > (costs.get(currentKey) ?? Infinity)) continue;

    for (const neighbor of adapter.getNeighbors(current.offset)) {
      if (!adapter.canOccupy(neighbor) || !adapter.canTraverse(current.offset, neighbor)) continue;
      const stepCost = adapter.getStepCost(current.offset, neighbor);
      if (!Number.isFinite(stepCost) || stepCost <= 0) continue;

      const cost = Math.round((current.cost + stepCost) * 100) / 100;
      if (cost > maximumCost + 0.01) continue;
      const key = offsetKey(neighbor);
      if ((costs.get(key) ?? Infinity) <= cost) continue;
      costs.set(key, cost);
      queue.push({ offset: neighbor, cost });
    }
  }

  return costs;
}

export function cellsWithin(costs: ReadonlyMap<string, number>, distance: number): Set<string> {
  return new Set([...costs].filter(([, cost]) => cost <= distance + 0.01).map(([key]) => key));
}

export function expandToFootprint(
  anchors: ReadonlySet<string>,
  width: number,
  height: number,
): Set<string> {
  const cells = new Set<string>();
  for (const key of anchors) {
    const anchor = parseOffsetKey(key);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        cells.add(offsetKey({ i: anchor.i + row, j: anchor.j + column }));
      }
    }
  }
  return cells;
}
