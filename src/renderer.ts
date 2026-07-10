import { STYLES } from "./constants";
import { parseOffsetKey, type GridOffset } from "./grid";

type MovementBand = "walk" | "dash" | "over";
type RegionStyle = (typeof STYLES)[MovementBand];

export interface MovementRendererHandlers {
  onHover(key: string): void;
  onLeave(): void;
  onElevation(key: string, wheelDelta: number, precise: boolean): void;
  onSelect(key: string): void;
}

export interface MovementPreview {
  path: readonly Point[];
  segmentBands: readonly MovementBand[];
  difficultSegments: readonly boolean[];
  cost: number;
  destination: GridOffset;
  footprint: { width: number; height: number };
  elevation: number;
  elevationDelta: number;
}

export class MovementRenderer {
  #container: PIXI.Container | null = null;
  #previewGraphics: PIXI.Graphics | null = null;
  #distanceLabel: PIXI.Text | null = null;
  #previousGridInteraction: boolean | null = null;

  clear(): void {
    this.#container?.destroy({ children: true });
    if (this.#previousGridInteraction !== null && canvas.interface?.grid) {
      canvas.interface.grid.interactiveChildren = this.#previousGridInteraction;
    }
    this.#container = null;
    this.#previewGraphics = null;
    this.#distanceLabel = null;
    this.#previousGridInteraction = null;
  }

  draw(
    walkCells: ReadonlySet<string>,
    dashCells: ReadonlySet<string>,
    overCells: ReadonlySet<string>,
    difficultCells: ReadonlySet<string>,
    handlers: MovementRendererHandlers,
  ): void {
    if (!canvas.interface?.grid || !canvas.grid) return;
    this.clear();
    this.#previousGridInteraction = canvas.interface.grid.interactiveChildren;
    canvas.interface.grid.interactiveChildren = true;
    this.#container = new PIXI.Container();
    this.#container.sortableChildren = true;
    canvas.interface.grid.addChild(this.#container);

    const ranges = new PIXI.Graphics();
    ranges.eventMode = "none";
    ranges.zIndex = 0;
    this.#container.addChild(ranges);
    this.#drawRegion(ranges, overCells, STYLES.over);
    this.#drawRegion(ranges, dashCells, STYLES.dash);
    this.#drawRegion(ranges, walkCells, STYLES.walk);
    this.#drawDifficultTerrain(ranges, difficultCells);

    this.#previewGraphics = new PIXI.Graphics();
    this.#previewGraphics.eventMode = "none";
    this.#previewGraphics.zIndex = 10;
    this.#container.addChild(this.#previewGraphics);

    this.#distanceLabel = new PIXI.Text("", {
      align: "center",
      fill: 0xffffff,
      fontFamily: "Signika, sans-serif",
      fontSize: 24,
      fontWeight: "bold",
      stroke: 0x000000,
      strokeThickness: 5,
    });
    this.#distanceLabel.anchor.set(0.5, 1);
    this.#distanceLabel.eventMode = "none";
    this.#distanceLabel.visible = false;
    this.#distanceLabel.zIndex = 11;
    this.#container.addChild(this.#distanceLabel);

    for (const key of overCells) {
      const offset = parseOffsetKey(key);
      const point = canvas.grid.getTopLeftPoint(offset);
      const inMovementRange = dashCells.has(key);
      const target = new PIXI.Graphics();
      target.beginFill(0xffffff, 0.001);
      target.drawRect(point.x, point.y, canvas.grid.size, canvas.grid.size);
      target.endFill();
      target.eventMode = "static";
      target.cursor = inMovementRange ? "pointer" : "not-allowed";
      target.zIndex = 20;
      target.on("pointerover", () => handlers.onHover(key));
      target.on("pointerout", () => handlers.onLeave());
      target.on("wheel", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const delta = event.deltaY || event.delta || 0;
        if (delta !== 0) handlers.onElevation(key, delta, event.shiftKey);
      });
      target.on("pointertap", (event) => {
        if (event.button !== 0 || !inMovementRange) return;
        event.stopPropagation();
        handlers.onSelect(key);
      });
      this.#container.addChild(target);
    }
  }

  showPreview(preview: MovementPreview): void {
    if (!this.#previewGraphics || !this.#distanceLabel || preview.path.length === 0) return;
    const graphics = this.#previewGraphics;
    graphics.clear();
    graphics.lineStyle(7, 0x000000, 0.8, 0.5);
    this.#drawPath(graphics, preview.path, preview.difficultSegments);
    for (let index = 1; index < preview.path.length; index += 1) {
      const from = preview.path[index - 1];
      const to = preview.path[index];
      if (!from || !to) continue;
      const band = preview.segmentBands[index - 1] ?? "over";
      graphics.lineStyle(4, STYLES[band].borderColor, 1, 0.5);
      this.#drawSegment(graphics, from, to, preview.difficultSegments[index - 1] === true);
    }

    const destinationPoint = canvas.grid.getTopLeftPoint(preview.destination);
    graphics.lineStyle(5, 0xffffff, 1, 0.5);
    graphics.drawRect(
      destinationPoint.x,
      destinationPoint.y,
      canvas.grid.size * preview.footprint.width,
      canvas.grid.size * preview.footprint.height,
    );

    const finalPoint = preview.path.at(-1);
    if (!finalPoint) return;
    const units = canvas.scene.grid.units;
    const distanceLabel = `${this.#formatDistance(preview.cost)} ${units}`.trim();
    const elevationLabel = preview.elevationDelta === 0
      ? ""
      : `\n↕ ${this.#formatSigned(preview.elevationDelta)} ${units} (${this.#formatDistance(preview.elevation)} ${units})`;
    this.#distanceLabel.text = `${distanceLabel}${elevationLabel}`;
    this.#distanceLabel.position.set(finalPoint.x, finalPoint.y - canvas.grid.size * 0.15);
    this.#distanceLabel.visible = true;
  }

  clearPreview(): void {
    this.#previewGraphics?.clear();
    if (this.#distanceLabel) this.#distanceLabel.visible = false;
  }

  #drawPath(
    graphics: PIXI.Graphics,
    path: readonly Point[],
    difficultSegments: readonly boolean[],
  ): void {
    const first = path[0];
    if (!first) return;
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1];
      const to = path[index];
      if (!from || !to) continue;
      this.#drawSegment(graphics, from, to, difficultSegments[index - 1] === true);
    }
  }

  #drawSegment(graphics: PIXI.Graphics, from: Point, to: Point, difficult: boolean): void {
    graphics.moveTo(from.x, from.y);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (!difficult || length < canvas.grid.size * 0.3) {
      graphics.lineTo(to.x, to.y);
      return;
    }

    const steps = Math.max(2, Math.ceil(length / (canvas.grid.size * 0.24)));
    const perpendicularX = -dy / length;
    const perpendicularY = dx / length;
    const amplitude = canvas.grid.size * 0.075;
    for (let step = 1; step < steps; step += 1) {
      const progress = step / steps;
      const direction = step % 2 === 0 ? -1 : 1;
      graphics.lineTo(
        from.x + dx * progress + perpendicularX * amplitude * direction,
        from.y + dy * progress + perpendicularY * amplitude * direction,
      );
    }
    graphics.lineTo(to.x, to.y);
  }

  #formatDistance(distance: number): string {
    return Number.isInteger(distance) ? String(distance) : distance.toFixed(1);
  }

  #formatSigned(distance: number): string {
    const formatted = this.#formatDistance(distance);
    return distance > 0 ? `+${formatted}` : formatted;
  }

  #drawRegion(graphics: PIXI.Graphics, cells: ReadonlySet<string>, style: RegionStyle): void {
    const size = canvas.grid.size;
    graphics.beginFill(style.fillColor, style.fillAlpha);
    graphics.lineStyle(0);
    for (const key of cells) {
      const point = canvas.grid.getTopLeftPoint(parseOffsetKey(key));
      graphics.drawRect(point.x, point.y, size, size);
    }
    graphics.endFill();

    graphics.lineStyle(style.borderWidth, style.borderColor, style.borderAlpha, 0.5);
    for (const key of cells) {
      const { i, j } = parseOffsetKey(key);
      const point = canvas.grid.getTopLeftPoint({ i, j });
      if (!cells.has(`${i - 1},${j}`)) graphics.moveTo(point.x, point.y).lineTo(point.x + size, point.y);
      if (!cells.has(`${i + 1},${j}`)) {
        graphics.moveTo(point.x, point.y + size).lineTo(point.x + size, point.y + size);
      }
      if (!cells.has(`${i},${j - 1}`)) graphics.moveTo(point.x, point.y).lineTo(point.x, point.y + size);
      if (!cells.has(`${i},${j + 1}`)) {
        graphics.moveTo(point.x + size, point.y).lineTo(point.x + size, point.y + size);
      }
    }
  }

  #drawDifficultTerrain(graphics: PIXI.Graphics, cells: ReadonlySet<string>): void {
    const size = canvas.grid.size;
    const spacing = size / 3;
    graphics.lineStyle(
      STYLES.difficult.width,
      STYLES.difficult.color,
      STYLES.difficult.alpha,
      0.5,
    );
    for (const key of cells) {
      const point = canvas.grid.getTopLeftPoint(parseOffsetKey(key));
      for (let row = spacing * 0.65; row < size; row += spacing) {
        const peak = Math.max(0, row - spacing * 0.45);
        graphics
          .moveTo(point.x, point.y + row)
          .lineTo(point.x + size / 2, point.y + peak)
          .lineTo(point.x + size, point.y + row);
      }
    }
  }
}
