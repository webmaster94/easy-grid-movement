const MODULE_ID = "easy-grid-movement";
const LAYER_ID = "easy-grid-movement";
const DEBUG_SETTING = "debug";

const COLORS = {
  speed: { fill: 0x2e86ff, alpha: 0.18, border: 0.25 },
  dash: { fill: 0xf7d046, alpha: 0.16, border: 0.2 }
};

const state = {
  visible: false,
  lastTokenId: null,
  neighborOffsets: null
};

function debugEnabled() {
  try {
    return Boolean(game?.settings?.get?.(MODULE_ID, DEBUG_SETTING));
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to read debug setting`, err);
    return false;
  }
}

function debugLog(message, ...args) {
  if (!debugEnabled()) return;
  console.debug(`[${MODULE_ID}] ${message}`, ...args);
}

function errorLog(message, ...args) {
  console.error(`[${MODULE_ID}] ${message}`, ...args);
}

class EasyGridMovement {
  static init() {
    game.settings?.register?.(MODULE_ID, DEBUG_SETTING, {
      name: game.i18n.localize("EGM.Settings.DebugName"),
      hint: game.i18n.localize("EGM.Settings.DebugHint"),
      scope: "client",
      config: true,
      type: Boolean,
      default: false
    });

    game.keybindings?.register?.(MODULE_ID, "toggleHighlight", {
      name: game.i18n.localize("EGM.Keybind.ToggleName"),
      hint: game.i18n.localize("EGM.Keybind.ToggleHint"),
      editable: [{ key: "KeyM" }],
      onDown: () => {
        console.log(`[${MODULE_ID}] M pressed`);
        EasyGridMovement.toggleForUser();
        return true;
      },
      precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
    });

    Hooks.on("controlToken", (token, controlled) => {
      if (!controlled) return;
      if (!state.visible) {
        state.lastTokenId = token?.id ?? null;
        return;
      }
      if (token) {
        EasyGridMovement.drawForToken(token).catch((err) => {
          errorLog("failed to redraw after control", err);
        });
      }
    });

    Hooks.on("updateToken", (doc) => {
      if (!state.visible) return;
      if (!doc || doc.id !== state.lastTokenId) return;
      const token = canvas.tokens?.get?.(doc.id);
      if (token)
        EasyGridMovement.drawForToken(token).catch((err) => {
          errorLog("failed to redraw after token update", err);
        });
    });

    Hooks.on("updateActor", (actor) => {
      if (!state.visible) return;
      if (!actor) return;
      const active = actor.getActiveTokens?.();
      if (!Array.isArray(active) || !active.length) return;
      const match = active.find((t) => t.id === state.lastTokenId);
      if (match)
        EasyGridMovement.drawForToken(match).catch((err) => {
          errorLog("failed to redraw after actor update", err);
        });
    });

    Hooks.on("canvasReady", () => {
      state.neighborOffsets = null;
      if (!state.visible) {
        EasyGridMovement.clear();
        return;
      }
      const token = EasyGridMovement._getActiveToken();
      if (token)
        EasyGridMovement.drawForToken(token).catch((err) => {
          errorLog("failed to redraw on canvasReady", err);
        });
    });
  }

  static toggleForUser() {
    const token = this._getActiveToken();
    if (!token) {
      ui.notifications?.info?.(game.i18n.localize("EGM.Notify.NoToken"));
      this.clear();
      return;
    }

    if (state.visible && state.lastTokenId === token.id) {
      this.clear();
      return;
    }

    state.visible = true;
    state.lastTokenId = token.id;
    this.drawForToken(token).catch((err) => {
      errorLog("failed to draw highlight", err);
      this.clear();
    });
  }

  static clear() {
    const layer = canvas.grid?.getHighlightLayer?.(LAYER_ID);
    if (layer) layer.clear();
    state.visible = false;
    state.lastTokenId = null;
    state.neighborOffsets = null;
  }

  static async drawForToken(token) {
    if (!token) return;
    const layer = this._prepareLayer();
    if (!layer) return;

    let spaces;
    try {
      spaces = this._getMovementSpaces(token);
    } catch (err) {
      ui.notifications?.info?.(game.i18n.localize("EGM.Notify.NoSpeed"));
      debugLog("no movement speed", err);
      this.clear();
      return;
    }

    const reachable = this._reachableCells(token, spaces.dashSpaces);
    debugLog("reachable cells", reachable.size);

    for (const [key, totalSpaces] of reachable) {
      const [gx, gy] = key.split(",").map((v) => Number(v));
      const band = totalSpaces <= spaces.speedSpaces ? "speed" : "dash";
      this._highlightCell(layer, gx, gy, band);
    }

    state.visible = true;
    state.lastTokenId = token.id;
  }

  static _prepareLayer() {
    let layer = canvas.grid?.getHighlightLayer?.(LAYER_ID);
    if (!layer && typeof canvas.grid?.addHighlightLayer === "function") {
      layer = canvas.grid.addHighlightLayer(LAYER_ID);
    }
    if (!layer) {
      errorLog("failed to acquire highlight layer");
      return null;
    }
    if (typeof layer.clear === "function") layer.clear();
    return layer;
  }

  static _getMovementSpaces(token) {
    const unit = Number(canvas.dimensions?.distance);
    const ft = Number(token?.actor?.system?.attributes?.movement?.walk ?? 0);
    if (!unit || !ft) throw new Error("Missing movement data");
    const speedSpaces = Math.max(0, Math.floor(ft / unit));
    return { speedSpaces, dashSpaces: speedSpaces * 2 };
  }

  static _reachableCells(token, maxSpaces) {
    const startCenter = token.center;
    const startGrid = this._gridPositionFromPixels(startCenter);
    if (!startGrid) return new Map();

    const offsets = this._getNeighborOffsets();
    const results = new Map();
    const queue = [{ grid: startGrid, spaces: 0 }];
    results.set(`${startGrid.x},${startGrid.y}`, 0);

    while (queue.length) {
      const current = queue.shift();
      for (const offset of offsets) {
        const neighbor = { x: current.grid.x + offset.x, y: current.grid.y + offset.y };
        const key = `${neighbor.x},${neighbor.y}`;

        const stepSpaces = this._measureStep(token, current.grid, neighbor);
        if (!Number.isFinite(stepSpaces) || stepSpaces <= 0) continue;

        const totalSpaces = current.spaces + stepSpaces;
        if (totalSpaces - 1e-4 > maxSpaces) continue;

        const best = results.get(key);
        if (best !== undefined && best <= totalSpaces) continue;

        results.set(key, totalSpaces);
        queue.push({ grid: neighbor, spaces: totalSpaces });
      }
    }

    return results;
  }

  static _measureStep(token, fromGrid, toGrid) {
    const from = this._centerFromGridPosition(fromGrid.x, fromGrid.y);
    const to = this._centerFromGridPosition(toGrid.x, toGrid.y);
    if (!from || !to) return Infinity;

    const ray = new Ray(from, to);
    if (canvas.walls?.checkCollision?.(ray)) {
      debugLog("collision blocked", { from: fromGrid, to: toGrid });
      return Infinity;
    }

    let path = [from, to];
    if (typeof token.constrainMovementPath === "function") {
      const constrained = token.constrainMovementPath(path);
      if (!Array.isArray(constrained) || constrained.length < 2) return Infinity;
      const last = constrained[constrained.length - 1];
      if (!last || Math.abs(last.x - to.x) > 0.5 || Math.abs(last.y - to.y) > 0.5) {
        debugLog("constrained path deviated", constrained);
        return Infinity;
      }
      path = constrained;
    }

    let measurement;
    if (typeof token.measureMovementPath === "function") {
      measurement = token.measureMovementPath(path);
    } else {
      measurement = canvas.grid?.measurePath?.(path);
    }

    const spaces = Number(measurement?.spaces);
    if (Number.isFinite(spaces) && spaces > 0) return spaces;

    const distance = Number(measurement?.distance);
    const unit = Number(canvas.dimensions?.distance) || 5;
    if (Number.isFinite(distance) && unit > 0) return distance / unit;

    return Infinity;
  }

  static _getNeighborOffsets() {
    if (state.neighborOffsets) return state.neighborOffsets;
    const grid = canvas.grid;
    const raw =
      grid?.getAdjacentOffsets?.({ origin: { x: 0, y: 0 } }) ??
      grid?.getAdjacentOffsets?.() ??
      [];
    const offsets = Array.isArray(raw)
      ? raw
          .map((o) => ({
            x: Number(o?.x ?? o?.i ?? o?.column ?? o?.[0] ?? 0),
            y: Number(o?.y ?? o?.j ?? o?.row ?? o?.[1] ?? 0)
          }))
          .filter((o) => Number.isFinite(o.x) && Number.isFinite(o.y))
      : [];
    if (offsets.length) {
      state.neighborOffsets = offsets;
      return offsets;
    }
    state.neighborOffsets = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: -1, y: 1 }
    ];
    return state.neighborOffsets;
  }

  static _gridPositionFromPixels(point) {
    const grid = canvas.grid;
    const gridClass = grid?.grid;
    if (gridClass?.getGridPositionFromPixels) {
      const pos = gridClass.getGridPositionFromPixels(point.x, point.y);
      if (Array.isArray(pos)) return { x: pos[0], y: pos[1] };
      if (pos && typeof pos.x === "number" && typeof pos.y === "number") return { x: pos.x, y: pos.y };
    }
    if (grid?.getGridPositionFromPixels) {
      const pos = grid.getGridPositionFromPixels(point.x, point.y);
      if (Array.isArray(pos)) return { x: pos[0], y: pos[1] };
      if (pos && typeof pos.x === "number" && typeof pos.y === "number") return { x: pos.x, y: pos.y };
    }
    const size = Number(canvas.dimensions?.size) || 100;
    return {
      x: Math.round(point.x / size),
      y: Math.round(point.y / size)
    };
  }

  static _centerFromGridPosition(x, y) {
    const grid = canvas.grid;
    if (!grid) return null;
    if (typeof grid.getCenterPoint === "function") {
      const center = grid.getCenterPoint({ x, y });
      if (center && typeof center.x === "number" && typeof center.y === "number") return center;
    }
    if (typeof grid.getCenter === "function") {
      const center = grid.getCenter(x, y);
      if (Array.isArray(center)) return { x: center[0], y: center[1] };
      if (center && typeof center.x === "number" && typeof center.y === "number") return center;
    }
    const size = Number(canvas.dimensions?.size) || 100;
    return { x: (x + 0.5) * size, y: (y + 0.5) * size };
  }

  static _topLeftFromGridPosition(x, y) {
    const grid = canvas.grid?.grid;
    if (grid?.getTopLeftPoint) {
      const point = grid.getTopLeftPoint({ x, y });
      if (point && typeof point.x === "number" && typeof point.y === "number") return point;
    }
    if (grid?.getTopLeft) {
      const tl = grid.getTopLeft(x, y);
      if (Array.isArray(tl)) return { x: tl[0], y: tl[1] };
      if (tl && typeof tl.x === "number" && typeof tl.y === "number") return tl;
    }
    const size = Number(canvas.dimensions?.size) || 100;
    return { x: x * size, y: y * size };
  }

  static _highlightCell(layer, gridX, gridY, band) {
    const style = band === "speed" ? COLORS.speed : COLORS.dash;
    const topLeft = this._topLeftFromGridPosition(gridX, gridY);
    if (!topLeft) return;

    if (typeof layer.highlight === "function") {
      layer.highlight(topLeft.x, topLeft.y, {
        color: style.fill,
        alpha: style.alpha,
        border: style.border
      });
      return;
    }

    if (typeof layer.beginFill === "function") {
      const size = Number(canvas.dimensions?.size) || 100;
      layer.lineStyle(2, style.fill, style.border);
      layer.beginFill(style.fill, style.alpha);
      layer.drawRect(topLeft.x, topLeft.y, size, size);
      layer.endFill();
    }
  }

  static _getActiveToken() {
    const controlled = canvas.tokens?.controlled ?? [];
    if (controlled.length) return controlled[0];
    const character = game.user?.character;
    if (!character) return null;
    const active = character.getActiveTokens?.();
    if (Array.isArray(active) && active.length) return active[0];
    return null;
  }
}

Hooks.once("init", () => EasyGridMovement.init());
