/**
 * Core entry point for the Easy Grid Movement module.
 *
 * Highlights grid squares reachable by controlled tokens while respecting
 * movement budgets and scene collision data. Comments throughout the file
 * provide additional context on the heuristics used to interact with Foundry's
 * grid API.
 */
const MODULE_ID = "easy-grid-movement";
const SETTINGS = {
  debugEnabled: "debugEnabled"
};

const formatMessage = (message) => `${MODULE_ID} | ${message}`;

const callConsole = (fn, ...args) => {
  if (typeof fn === "function") {
    fn.call(console, ...args);
  }
};

const isDebugEnabled = () => {
  try {
    return Boolean(game?.settings?.get?.(MODULE_ID, SETTINGS.debugEnabled));
  } catch (err) {
    warnLog("Unable to read debug setting", err);
    return false;
  }
};

const debugLog = (message, ...args) => {
  if (!isDebugEnabled()) return;
  callConsole(console.debug ?? console.log, formatMessage(message), ...args);
};

const infoLog = (message, ...args) => callConsole(console.info ?? console.log, formatMessage(message), ...args);
const warnLog = (message, ...args) => callConsole(console.warn ?? console.log, formatMessage(message), ...args);
const errorLog = (message, ...args) => callConsole(console.error ?? console.log, formatMessage(message), ...args);

const LAYER_NAMES = {
  normal: `${MODULE_ID}-normal`,
  dash: `${MODULE_ID}-dash`
};

const DEFAULTS = {
  normalColor: "#4aa3ff",
  dashColor: "#ffd24a",
  highlightAlpha: 0.25,
  multiMode: "first",
  cellLimit: 5000
};

// Keep helpers dependency-free so the module remains portable.
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// The location of the highlight interface moved between Foundry versions.
// Checking both locations avoids runtime errors when running on older builds.
const getGridInterface = () => canvas?.interface?.grid ?? canvas?.grid ?? null;

/**
 * Lightweight priority queue tailored for Dijkstra exploration.
 *
 * Implemented locally so we don't rely on external utilities or Foundry
 * internals. Only the operations we need (push/pop) are implemented.
 */
class PriorityQueue {
  constructor(comparator) {
    this._data = [];
    this._comparator = comparator;
  }

  push(item) {
    this._data.push(item);
    this._bubbleUp(this._data.length - 1);
  }

  pop() {
    if (this._data.length === 0) return undefined;
    const top = this._data[0];
    const last = this._data.pop();
    if (this._data.length > 0 && last) {
      this._data[0] = last;
      this._bubbleDown(0);
    }
    return top;
  }

  get length() {
    return this._data.length;
  }

  _bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this._comparator(this._data[index], this._data[parent]) >= 0) break;
      [this._data[index], this._data[parent]] = [this._data[parent], this._data[index]];
      index = parent;
    }
  }

  _bubbleDown(index) {
    const length = this._data.length;
    while (true) {
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      let smallest = index;
      if (left < length && this._comparator(this._data[left], this._data[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && this._comparator(this._data[right], this._data[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) break;
      [this._data[index], this._data[smallest]] = [this._data[smallest], this._data[index]];
      index = smallest;
    }
  }
}

/**
 * Coordinates the highlight workflow and reacts to Foundry events.
 */
class MovementHighlighter {
  constructor() {
    this.active = false;
    this._cache = new Map();
    this._refreshTimeout = null;
    this._neighborOffsets = null;
    this._notified = {
      noToken: false,
      gridless: false,
      limitHit: false,
      zeroSpeed: new Set()
    };
    this._registerHooks();
  }

  toggle(force) {
    const shouldActivate = force !== undefined ? force : !this.active;
    if (shouldActivate) {
      return this.activate();
    }
    return this.deactivate();
  }

  /** Activate highlighting or refresh if already active. */
  activate() {
    if (this.active) {
      this.scheduleRefresh("reactivate");
      return true;
    }
    this.active = true;
    this._resetNotifications();
    this._cache.clear();
    this.scheduleRefresh("activate");
    return true;
  }

  /** Tear down highlight layers and cancel pending work. */
  deactivate() {
    if (!this.active) return false;
    this.active = false;
    this._clearLayers();
    this._resetNotifications();
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }
    return true;
  }

  /** Recompute highlights when the configuration changes. */
  onSettingsChanged() {
    this._cache.clear();
    this._neighborOffsets = null;
    if (this.active) {
      this.scheduleRefresh("settingsChanged");
    } else {
      this._clearLayers();
    }
  }

  /** Debounce refresh requests to avoid thrashing Foundry's grid API. */
  scheduleRefresh(reason = "manual") {
    if (!this.active) return;
    if (this._refreshTimeout) clearTimeout(this._refreshTimeout);
    this._refreshTimeout = window.setTimeout(() => {
      this._refreshTimeout = null;
      try {
        this.refresh();
      } catch (err) {
        errorLog(`Failed to refresh highlights (${reason})`, err);
      }
    }, 150);
  }

  /**
   * Entry point for highlight calculation. Validates preconditions and
   * dispatches to the search helper for each controlled token.
   */
  refresh() {
    if (!this.active) return;
    if (!canvas?.ready) return;

    const scene = canvas.scene;
    if (!scene) return;

    const gridConfig = scene.grid;
    if (!gridConfig || gridConfig.type === CONST.GRID_TYPES.GRIDLESS) {
      this._clearLayers();
      if (!this._notified.gridless) {
        ui.notifications?.info(game.i18n.localize("EGM.Notifications.Gridless"));
        this._notified.gridless = true;
      }
      return;
    }

    const tokens = this._getTokensToHighlight();
    if (!tokens.length) {
      this._clearLayers();
      if (!this._notified.noToken) {
        ui.notifications?.info(game.i18n.localize("EGM.Notifications.NoToken"));
        this._notified.noToken = true;
      }
      return;
    }

    this._notified.noToken = false;
    this._notified.gridless = false;

    const normalAggregate = new Map();
    const dashAggregate = new Map();
    let limitHit = false;
    let hadSpeed = false;

    // Hard cap exploration to avoid pathological cases on enormous maps.
    const cellLimit = Number(game.settings.get(MODULE_ID, "cellLimit")) || DEFAULTS.cellLimit;

    for (const token of tokens) {
      const speed = this._getTokenSpeed(token);
      if (!speed) {
        if (!this._notified.zeroSpeed.has(token.id)) {
          ui.notifications?.warn(game.i18n.localize("EGM.Notifications.NoSpeed"));
          this._notified.zeroSpeed.add(token.id);
        }
        continue;
      }

      hadSpeed = true;
      this._notified.zeroSpeed.delete(token.id);
      const normalBudget = speed;
      // Dash follows the default Foundry behaviour of doubling movement.
      const dashBudget = speed * 2;
      const cacheKey = this._buildCacheKey(token, normalBudget, dashBudget, cellLimit);
      let result = this._getCachedResult(token, cacheKey);
      if (!result) {
        result = this._performSearch(token, normalBudget, dashBudget, cellLimit);
        this._setCachedResult(token, cacheKey, result);
      }

      if (result.limitHit) limitHit = true;

      for (const [key, cell] of result.normal.entries()) {
        // Later tokens overwrite earlier ones ensuring the latest data wins.
        normalAggregate.set(key, cell);
      }
      for (const [key, cell] of result.dash.entries()) {
        if (!normalAggregate.has(key)) {
          dashAggregate.set(key, cell);
        }
      }
    }

    if (!hadSpeed) {
      this._clearLayers();
      return;
    }

    this._renderHighlights(normalAggregate, dashAggregate);

    if (limitHit && !this._notified.limitHit) {
      ui.notifications?.warn(game.i18n.localize("EGM.Notifications.LimitReached"));
      this._notified.limitHit = true;
    } else if (!limitHit) {
      this._notified.limitHit = false;
    }
  }

  /** Reset per-refresh notification guards. */
  _resetNotifications() {
    this._notified = {
      noToken: false,
      gridless: false,
      limitHit: false,
      zeroSpeed: new Set()
    };
  }

  /**
   * Determine which tokens should be processed based on the multi select mode.
   */
  _getTokensToHighlight() {
    const controlled = canvas.tokens?.controlled ?? [];
    if (!controlled.length) return [];
    const mode = game.settings.get(MODULE_ID, "multiMode") ?? DEFAULTS.multiMode;
    if (mode === "all") return controlled;
    return [controlled[0]];
  }

  /**
   * Attempt to resolve a usable speed value from a token's data.
   */
  _getTokenSpeed(token) {
    const actor = token.actor;
    const movement = actor?.system?.attributes?.movement;
    if (!movement) return 0;

    const priority = ["walk", "fly", "swim", "climb", "burrow"];
    for (const type of priority) {
      const value = Number(movement[type]);
      if (Number.isFinite(value) && value > 0) return value;
    }

    const generic = Number(movement.value ?? movement.speed ?? movement.base);
    if (Number.isFinite(generic) && generic > 0) return generic;
    return 0;
  }

  /**
   * Explore the grid around the token while respecting collision and costs.
   */
  _performSearch(token, normalBudget, dashBudget, cellLimit) {
    const grid = canvas.grid;
    const scene = canvas.scene;
    const normal = new Map();
    const dash = new Map();

    if (!grid || !scene) return { normal, dash, limitHit: false };

    let startOffset;
    const centerPoint = token.center;
    if (typeof grid.getOffset === "function") {
      try {
        startOffset = grid.getOffset(centerPoint, { round: true });
      } catch (err) {
        debugLog("getOffset failed", err);
      }
    } else if (typeof grid.grid?.getOffset === "function") {
      try {
        startOffset = grid.grid.getOffset(centerPoint, { round: true });
      } catch (err) {
        debugLog("inner getOffset failed", err);
      }
    }

    const size = canvas.dimensions?.size ?? 100;
    const [startXRaw, startYRaw] = Array.isArray(startOffset)
      ? startOffset
      : [
          startOffset?.x ?? startOffset?.i ?? startOffset?.column ?? centerPoint.x / size,
          startOffset?.y ?? startOffset?.j ?? startOffset?.row ?? centerPoint.y / size
        ];

    const start = {
      x: Math.round(startXRaw),
      y: Math.round(startYRaw)
    };

    // Translate speed budgets from scene units into grid step counts.
    const distPerCell = Number(canvas.dimensions?.distance ?? scene.grid?.distance) || 5;
    // Provide a safety margin so diagonal moves beyond the budget are evaluated.
    const maxSteps = Math.ceil((dashBudget / Math.max(distPerCell, 0.0001)) + 2);
    // Bounding box prevents runaway exploration while still capturing relevant cells.
    const bounds = {
      minX: start.x - maxSteps - Math.ceil((token.document.width ?? 1) / 2),
      maxX: start.x + maxSteps + Math.ceil((token.document.width ?? 1) / 2),
      minY: start.y - maxSteps - Math.ceil((token.document.height ?? 1) / 2),
      maxY: start.y + maxSteps + Math.ceil((token.document.height ?? 1) / 2)
    };

    // Grid specific neighbour data (including diagonals) drives the search fan-out.
    const offsets = this._getNeighborOffsets(start);
    if (!offsets.length) return { normal, dash, limitHit: false };

    const frontier = new PriorityQueue((a, b) => a.cost - b.cost);
    const visited = new Map();

    // Seed the search from the token's current grid position.
    frontier.push({ x: start.x, y: start.y, cost: 0 });

    let limitHit = false;

    while (frontier.length > 0) {
      const current = frontier.pop();
      if (!current) break;
      const key = this._cellKey(current.x, current.y);
      const prev = visited.get(key);
      // Found a cheaper path to this cell before, skip inferior entry.
      if (prev !== undefined && prev <= current.cost) continue;
      visited.set(key, current.cost);

      if (visited.size > cellLimit) {
        limitHit = true;
        break;
      }

      if (current.cost <= normalBudget) {
        normal.set(key, { x: current.x, y: current.y });
      } else if (current.cost <= dashBudget) {
        dash.set(key, { x: current.x, y: current.y });
      } else {
        continue;
      }

      for (const offset of offsets) {
        const nx = current.x + offset.x;
        const ny = current.y + offset.y;
        if (nx < bounds.minX || nx > bounds.maxX || ny < bounds.minY || ny > bounds.maxY) continue;

        const neighborKey = this._cellKey(nx, ny);
        const best = visited.get(neighborKey);
        if (best !== undefined && best <= current.cost) continue;

        const fromPixels = this._cellToCenterPixels(current.x, current.y);
        const toPixels = this._cellToCenterPixels(nx, ny);

        if (!fromPixels || !toPixels) continue;

        const segmentCost = this._measureSegment(token, fromPixels, toPixels);
        if (!Number.isFinite(segmentCost)) continue;
        const totalCost = current.cost + segmentCost;
        if (totalCost > dashBudget + 0.001) continue;

        // The queue stores the accumulated cost so the cheapest cell is popped next.
        frontier.push({ x: nx, y: ny, cost: totalCost });
      }
    }

    return { normal, dash, limitHit };
  }

  /**
   * Leverage Foundry's measurement APIs to calculate the cost between cells.
   */
  _measureSegment(_token, from, to) {
    const grid = canvas?.grid;
    const dimensions = canvas?.dimensions;
    if (!grid || !dimensions) return Infinity;

    const RayClass = foundry?.canvas?.geometry?.Ray ?? foundry?.utils?.Ray ?? globalThis.Ray;
    if (!RayClass) return Infinity;

    const ray = new RayClass(from, to);
    if (!ray) return Infinity;

    try {
      const collision = canvas.walls?.checkCollision?.(ray, { type: "move", mode: "any" });
      if (collision) {
        debugLog("Movement blocked by collision", { from, to });
        return Infinity;
      }
    } catch (err) {
      debugLog("Collision check failed", err);
      return Infinity;
    }

    try {
      const measurement = grid.measurePath([ray.A, ray.B]);
      if (!measurement || typeof measurement !== "object") {
        debugLog("measurePath returned invalid result", measurement);
        return Infinity;
      }

      const unitDistance = Number(dimensions.distance) || 5;
      if (Number.isFinite(measurement.spaces) && measurement.spaces > 0) {
        return measurement.spaces * unitDistance;
      }

      if (Number.isFinite(measurement.distance)) {
        return measurement.distance;
      }

      debugLog("measurePath result missing distance", measurement);
      return Infinity;
    } catch (err) {
      errorLog("Failed to measure segment", err);
      return Infinity;
    }
  }

  /**
   * Draw the computed normal and dash ranges on their respective layers.
   */
  _renderHighlights(normalCells, dashCells) {
    const grid = canvas.grid;
    if (!grid) return;
    const gridInterface = getGridInterface();
    if (!gridInterface) return;

    const highlightAlpha = Number(game.settings.get(MODULE_ID, "highlightAlpha"));
    const alpha = Number.isFinite(highlightAlpha) ? clamp(highlightAlpha, 0, 1) : DEFAULTS.highlightAlpha;
    gridInterface.clearHighlightLayer(LAYER_NAMES.normal);
    gridInterface.clearHighlightLayer(LAYER_NAMES.dash);

    const normalLayer = this._ensureLayer(LAYER_NAMES.normal, alpha);
    const dashLayer = this._ensureLayer(LAYER_NAMES.dash, alpha);

    const normalColor = game.settings.get(MODULE_ID, "normalColor") || DEFAULTS.normalColor;
    const dashColor = game.settings.get(MODULE_ID, "dashColor") || DEFAULTS.dashColor;

    for (const cell of normalCells.values()) {
      this._highlightCell(normalLayer, LAYER_NAMES.normal, cell, normalColor, alpha);
    }

    for (const cell of dashCells.values()) {
      this._highlightCell(dashLayer, LAYER_NAMES.dash, cell, dashColor, alpha);
    }
  }

  /** Ensure a highlight layer exists and uses the provided opacity. */
  _ensureLayer(name, alpha) {
    const gridInterface = getGridInterface();
    if (!gridInterface) return null;
    let layer = gridInterface.highlightLayers?.[name];
    if (!layer && typeof gridInterface.addHighlightLayer === "function") {
      try {
        layer = gridInterface.addHighlightLayer(name);
      } catch (err) {
        errorLog(`Failed to add highlight layer ${name}`, err);
      }
    }
    if (layer) layer.alpha = alpha;
    return layer;
  }

  /**
   * Highlight a single cell using whichever API the grid exposes.
   */
  _highlightCell(layer, layerName, cell, color, alpha) {
    const grid = canvas.grid;
    if (!grid) return;
    const gridInterface = getGridInterface();
    try {
      if (typeof gridInterface?.highlightPosition === "function") {
        gridInterface.highlightPosition(layerName, { x: cell.x, y: cell.y, color });
        if (layer) layer.alpha = alpha;
        return;
      }
      grid.highlightGridPosition?.(layerName, { x: cell.x, y: cell.y, color });
      if (layer) layer.alpha = alpha;
      return;
    } catch (err) {
      if (!layer) return;
      try {
        const hex = this._colorToNumber(color);
        const shape = this._getCellShape(cell.x, cell.y);
        if (!shape) return;
        layer.beginFill(hex, alpha);
        layer.drawPolygon(shape);
        layer.endFill();
      } catch (drawErr) {
        errorLog("Failed to draw highlight", drawErr);
      }
    }
  }

  /**
   * Construct a polygon describing the highlighted cell for manual drawing.
   */
  _getCellShape(x, y) {
    const grid = canvas.grid;
    if (!grid) return null;
    if (typeof grid.getHighlightPositions === "function") {
      const positions = grid.getHighlightPositions({ x, y });
      if (positions?.shape) return positions.shape;
    } else if (typeof grid.getGridHighlightPositions === "function") {
      const positions = grid.getGridHighlightPositions({ x, y });
      if (positions?.shape) return positions.shape;
    }
    if (typeof grid.getRect === "function") {
      const rect = grid.getRect({ x, y });
      if (rect) {
        return [
          rect.x,
          rect.y,
          rect.x + rect.width,
          rect.y,
          rect.x + rect.width,
          rect.y + rect.height,
          rect.x,
          rect.y + rect.height
        ];
      }
    } else if (typeof grid.getGridBounds === "function") {
      const bounds = grid.getGridBounds(x, y);
      if (bounds) {
        return [
          bounds.x,
          bounds.y,
          bounds.x + bounds.width,
          bounds.y,
          bounds.x + bounds.width,
          bounds.y + bounds.height,
          bounds.x,
          bounds.y + bounds.height
        ];
      }
    }
    const size = canvas.dimensions?.size ?? 100;
    let topLeft;
    if (typeof grid.getTopLeftPoint === "function") {
      const point = grid.getTopLeftPoint({ x, y });
      if (point) topLeft = [point.x, point.y];
    }
    if (!topLeft && typeof grid.getTopLeft === "function") {
      topLeft = grid.getTopLeft(x, y);
    }
    if (!topLeft) {
      topLeft = [x * size, y * size];
    }

    return [
      topLeft[0],
      topLeft[1],
      topLeft[0] + size,
      topLeft[1],
      topLeft[0] + size,
      topLeft[1] + size,
      topLeft[0],
      topLeft[1] + size
    ];
  }

  /** Convert CSS color strings to the numeric form expected by PIXI. */
  _colorToNumber(color) {
    if (typeof foundry?.utils?.colorStringToHex === "function") {
      return foundry.utils.colorStringToHex(color);
    }
    return Number(`0x${color.replace("#", "")}`);
  }

  /**
   * Convert grid coordinates to pixel center points with graceful fallbacks.
   */
  _cellToCenterPixels(x, y) {
    const grid = canvas.grid;
    if (!grid) return null;
    if (typeof grid.getCenterPoint === "function") {
      const center = grid.getCenterPoint({ x, y });
      if (center && typeof center.x === "number" && typeof center.y === "number") {
        return center;
      }
    } else if (typeof grid.getCenter === "function") {
      const center = grid.getCenter(x, y);
      if (Array.isArray(center)) {
        return { x: center[0], y: center[1] };
      }
      if (center && typeof center.x === "number" && typeof center.y === "number") {
        return center;
      }
    }
    const size = canvas.dimensions?.size ?? 100;
    return { x: (x + 0.5) * size, y: (y + 0.5) * size };
  }

  /**
   * Build a string key that captures the parameters affecting search results.
   */
  _buildCacheKey(token, normalBudget, dashBudget, cellLimit) {
    const scene = canvas.scene;
    const grid = canvas.scene?.grid || {};
    const parts = [
      token.id,
      token.document.x,
      token.document.y,
      token.document.width,
      token.document.height,
      token.document.elevation ?? 0,
      normalBudget,
      dashBudget,
      cellLimit,
      scene?.id,
      grid.type,
      grid.size,
      grid.distance,
      grid.diagonalRule,
      token.document.parent?.id
    ];
    return parts.join("|");
  }

  /** Fetch cached results when the token has not changed. */
  _getCachedResult(token, key) {
    const cached = this._cache.get(token.id);
    if (cached?.key === key) return cached.result;
    return null;
  }

  /** Cache newly computed search results for reuse. */
  _setCachedResult(token, key, result) {
    this._cache.set(token.id, { key, result });
  }

  /**
   * Retrieve the neighbour offsets used to explore adjacent cells.
   */
  _getNeighborOffsets(origin) {
    if (this._neighborOffsets && this._neighborOffsets.length) return this._neighborOffsets;
    const grid = canvas.grid;
    let offsets = [];
    if (typeof grid?.getAdjacentOffsets === "function") {
      const originData = origin ?? { x: 0, y: 0 };
      const normalizedOrigin = originData
        ? {
            i: originData.i ?? originData.x ?? originData.column ?? 0,
            j: originData.j ?? originData.y ?? originData.row ?? 0,
            x: originData.x ?? originData.i ?? originData.column ?? 0,
            y: originData.y ?? originData.j ?? originData.row ?? 0,
            column: originData.column ?? originData.x ?? originData.i ?? 0,
            row: originData.row ?? originData.y ?? originData.j ?? 0
          }
        : undefined;

      if (normalizedOrigin) {
        try {
          offsets = grid.getAdjacentOffsets({ origin: normalizedOrigin });
        } catch (err) {
          debugLog("getAdjacentOffsets with origin failed", err);
        }
      }

      if (!Array.isArray(offsets) || !offsets.length) {
        try {
          offsets = grid.getAdjacentOffsets();
        } catch (err) {
          debugLog("getAdjacentOffsets failed", err);
        }
      }
    }
    if (!Array.isArray(offsets) || !offsets.length) {
      offsets = [
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 },
        { x: 1, y: 1 },
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: -1, y: 1 }
      ];
    }
    this._neighborOffsets = offsets.map((o) => ({ x: o.x ?? o[0] ?? 0, y: o.y ?? o[1] ?? 0 }));
    return this._neighborOffsets;
  }

  /** Create a stable key for storing cell data in maps. */
  _cellKey(x, y) {
    return `${x},${y}`;
  }

  /** Clear all highlight layers created by this module. */
  _clearLayers() {
    const gridInterface = getGridInterface();
    if (!gridInterface) return;
    for (const name of Object.values(LAYER_NAMES)) {
      try {
        gridInterface.clearHighlightLayer(name);
      } catch (err) {
        debugLog(`Failed to clear highlight layer ${name}`, err);
      }
    }
  }

  /** Wire up all hook listeners that should trigger highlight refreshes. */
  _registerHooks() {
    Hooks.on("controlToken", () => this._handleControlChange());
    Hooks.on("updateToken", (doc) => this._handleTokenDocumentChange(doc));
    Hooks.on("deleteToken", (doc) => this._handleTokenDocumentChange(doc));
    Hooks.on("createToken", (doc) => this._handleTokenDocumentChange(doc));
    Hooks.on("refreshToken", (token) => this._handleTokenRefresh(token));
    Hooks.on("canvasReady", () => this._handleCanvasReady());
    Hooks.on("updateScene", (scene) => this._handleSceneUpdate(scene));
    Hooks.on("createWall", (doc) => this._handleSceneObstacleChange(doc));
    Hooks.on("updateWall", (doc) => this._handleSceneObstacleChange(doc));
    Hooks.on("deleteWall", (doc) => this._handleSceneObstacleChange(doc));
    Hooks.on("createRegion", (doc) => this._handleSceneObstacleChange(doc));
    Hooks.on("updateRegion", (doc) => this._handleSceneObstacleChange(doc));
    Hooks.on("deleteRegion", (doc) => this._handleSceneObstacleChange(doc));
    Hooks.on("updateCombat", () => this._handleCombatChange());
  }

  /** Refresh when token selection changes. */
  _handleControlChange() {
    this._cache.clear();
    this._notified.zeroSpeed.clear();
    this.scheduleRefresh("controlChange");
  }

  /** React to document-level token changes that may affect position or speed. */
  _handleTokenDocumentChange(doc) {
    if (doc?.parent?.id !== canvas.scene?.id) return;
    this._cache.delete(doc.id);
    this.scheduleRefresh("tokenDocumentChange");
  }

  /** Handle redraws of controlled tokens which may change collision results. */
  _handleTokenRefresh(token) {
    if (!token?.controlled) return;
    this._cache.delete(token.id);
    this.scheduleRefresh("tokenRefresh");
  }

  /** Reset caches when the canvas is fully initialised. */
  _handleCanvasReady() {
    this._cache.clear();
    this._neighborOffsets = null;
    if (this.active) this.scheduleRefresh("canvasReady");
  }

  /** Re-evaluate highlights after scene configuration updates. */
  _handleSceneUpdate(scene) {
    if (scene?.id !== canvas.scene?.id) return;
    this._cache.clear();
    this._neighborOffsets = null;
    if (this.active) this.scheduleRefresh("sceneUpdate");
  }

  /** React to obstacle changes such as walls or regions. */
  _handleSceneObstacleChange(doc) {
    if (doc?.parent?.id !== canvas.scene?.id) return;
    this._cache.clear();
    if (this.active) this.scheduleRefresh("sceneObstacleChange");
  }

  /** Re-check movement ranges when combat state changes. */
  _handleCombatChange() {
    if (!this.active) return;
    this.scheduleRefresh("combatChange");
  }
}

let highlighter;

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();
});

Hooks.once("ready", () => {
  highlighter = new MovementHighlighter();
});

/** Register all user-configurable settings exposed in the module manifest. */
function registerSettings() {
  game.settings.register(MODULE_ID, "normalColor", {
    name: game.i18n.localize("EGM.Settings.normalColor.Name"),
    hint: game.i18n.localize("EGM.Settings.normalColor.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: DEFAULTS.normalColor,
    onChange: () => highlighter?.onSettingsChanged()
  });

  game.settings.register(MODULE_ID, "dashColor", {
    name: game.i18n.localize("EGM.Settings.dashColor.Name"),
    hint: game.i18n.localize("EGM.Settings.dashColor.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: DEFAULTS.dashColor,
    onChange: () => highlighter?.onSettingsChanged()
  });

  game.settings.register(MODULE_ID, "highlightAlpha", {
    name: game.i18n.localize("EGM.Settings.highlightAlpha.Name"),
    hint: game.i18n.localize("EGM.Settings.highlightAlpha.Hint"),
    scope: "world",
    config: true,
    type: Number,
    default: DEFAULTS.highlightAlpha,
    range: { min: 0, max: 1, step: 0.05 },
    onChange: () => highlighter?.onSettingsChanged()
  });

  game.settings.register(MODULE_ID, "multiMode", {
    name: game.i18n.localize("EGM.Settings.multiMode.Name"),
    hint: game.i18n.localize("EGM.Settings.multiMode.Hint"),
    scope: "world",
    config: true,
    type: String,
    choices: {
      first: game.i18n.localize("EGM.Settings.multiMode.Choices.first"),
      all: game.i18n.localize("EGM.Settings.multiMode.Choices.all")
    },
    default: DEFAULTS.multiMode,
    onChange: () => highlighter?.onSettingsChanged()
  });

  game.settings.register(MODULE_ID, "cellLimit", {
    name: game.i18n.localize("EGM.Settings.cellLimit.Name"),
    hint: game.i18n.localize("EGM.Settings.cellLimit.Hint"),
    scope: "world",
    config: true,
    type: Number,
    default: DEFAULTS.cellLimit,
    range: { min: 500, max: 20000, step: 100 },
    onChange: () => highlighter?.onSettingsChanged()
  });

  game.settings.register(MODULE_ID, SETTINGS.debugEnabled, {
    name: game.i18n.localize("EGM.Settings.debugEnabled.Name"),
    hint: game.i18n.localize("EGM.Settings.debugEnabled.Hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => {
      if (value) {
        infoLog("Debug logging enabled");
      } else {
        infoLog("Debug logging disabled");
      }
    }
  });
}

/** Register a keybinding that toggles the highlighter on demand. */
function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "toggle-highlight", {
    name: game.i18n.localize("EGM.Keybinding.Toggle.Name"),
    hint: game.i18n.localize("EGM.Keybinding.Toggle.Hint"),
    editable: [{ key: "KeyM" }],
    onDown: () => {
      highlighter?.toggle();
      return true;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
}
