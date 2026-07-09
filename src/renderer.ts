import { STYLES } from "./constants";
import { parseOffsetKey } from "./grid";

type RegionStyle = (typeof STYLES)[keyof typeof STYLES];

export class MovementRenderer {
  #container: PIXI.Container | null = null;

  clear(): void {
    this.#container?.destroy({ children: true });
    this.#container = null;
  }

  draw(walkCells: ReadonlySet<string>, dashCells: ReadonlySet<string>): void {
    if (!canvas.interface?.grid || !canvas.grid) return;
    this.clear();
    this.#container = new PIXI.Container();
    canvas.interface.grid.addChild(this.#container);

    const graphics = new PIXI.Graphics();
    this.#container.addChild(graphics);
    this.#drawRegion(graphics, dashCells, STYLES.dash);
    this.#drawRegion(graphics, walkCells, STYLES.walk);
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
}
