/**
 * Easy Grid Movement
 * V13 Refactor with Robust Border Rendering and Debugging
 */

const MODULE_ID = "easy-grid-movement";
const SETTING_DEBUG = "debug";

const STYLES = {
  walk: {
    fillColor: 0x2e86ff,
    fillAlpha: 0.15,
    borderColor: 0x2e86ff,
    borderAlpha: 1.0,
    borderWidth: 4, 
  },
  dash: {
    fillColor: 0xf7d046,
    fillAlpha: 0.15,
    borderColor: 0xf7d046,
    borderAlpha: 1.0,
    borderWidth: 4,
  },
};

function debugEnabled() {
  return game.settings.get(MODULE_ID, SETTING_DEBUG);
}

function debugLog(msg, ...args) {
  if (debugEnabled()) console.debug(`[EGM] ${msg}`, ...args);
}

/* -------------------------------------------------------------------------- */
/*                             Movement Tracking                              */
/* -------------------------------------------------------------------------- */

class MovementTracker {
  static _moved = new Map(); 

  static init() {
    Hooks.on("updateCombat", () => {
      this._moved.clear();
      debugLog("Combat Round Change - Reset Movement");
      EasyGridMovement.refresh();
    });

    Hooks.on("preUpdateToken", (tokenDoc, changes) => {
      if (!tokenDoc.inCombat) return;
      if (changes.x === undefined && changes.y === undefined) return;
      tokenDoc._egm_temp_loc = { x: tokenDoc.x, y: tokenDoc.y };
    });

    Hooks.on("updateToken", (tokenDoc, changes) => {
      if (!tokenDoc._egm_temp_loc) return;
      if (changes.x === undefined && changes.y === undefined) {
        delete tokenDoc._egm_temp_loc;
        return;
      }

      const start = tokenDoc._egm_temp_loc;
      const end = { x: tokenDoc.x, y: tokenDoc.y };
      delete tokenDoc._egm_temp_loc;

      const dist = MovementTracker.measureDistance(start, end);
      
      if (dist > 0) {
        const current = this._moved.get(tokenDoc.id) || 0;
        this._moved.set(tokenDoc.id, current + dist);
        debugLog(`Token moved ${dist}ft. Total: ${current + dist}ft`);
      }
      
      if (EasyGridMovement.isActive && EasyGridMovement.lastTokenId === tokenDoc.id) {
        EasyGridMovement.refresh();
      }
    });
  }

  static measureDistance(p1, p2) {
    if (!canvas.grid) return 0;
    try {
        const measure = canvas.grid.measurePath([p1, p2]);
        return measure?.distance || 0;
    } catch (err) {
        return 0;
    }
  }

  static getMovedDistance(tokenId) {
    return this._moved.get(tokenId) || 0;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Main Class                                 */
/* -------------------------------------------------------------------------- */

class EasyGridMovement {
  static isActive = false;
  static lastTokenId = null;
  static container = null;

  static init() {
    game.settings.register(MODULE_ID, SETTING_DEBUG, {
      name: game.i18n.localize("EGM.Settings.DebugName"),
      hint: game.i18n.localize("EGM.Settings.DebugHint"),
      scope: "client",
      config: true,
      type: Boolean,
      default: false,
    });

    game.keybindings.register(MODULE_ID, "toggleHighlight", {
      name: game.i18n.localize("EGM.Keybind.ToggleName"),
      hint: game.i18n.localize("EGM.Keybind.ToggleHint"),
      editable: [{ key: "KeyM" }],
      onDown: () => {
        this.toggle();
        return true;
      },
    });

    Hooks.on("controlToken", (token, controlled) => {
      if (controlled && this.isActive) {
        this.lastTokenId = token.id;
        this.draw(token);
      }
      if (!controlled && this.isActive && !canvas.tokens.controlled.length) {
        this.clear();
      }
    });

    Hooks.on("canvasReady", () => {
      this.container = null; 
    });

    MovementTracker.init();
  }

  static toggle() {
    const token = canvas.tokens.controlled[0];
    if (!token) {
      ui.notifications.info(game.i18n.localize("EGM.Notify.NoToken"));
      return;
    }

    if (this.isActive && this.lastTokenId === token.id) {
      this.clear();
    } else {
      this.isActive = true;
      this.lastTokenId = token.id;
      this.draw(token);
    }
  }

  static clear() {
    this.isActive = false;
    this.lastTokenId = null;
    if (this.container) {
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  static refresh() {
    if (!this.isActive || !this.lastTokenId) return;
    const token = canvas.tokens.get(this.lastTokenId);
    if (token) this.draw(token);
    else this.clear();
  }

  static async draw(token) {
    const movement = token.actor?.system?.attributes?.movement;
    if (!movement) {
        ui.notifications.warn(game.i18n.localize("EGM.Notify.NoSpeed"));
        return;
    }

    let walkSpeed = parseFloat(movement.walk) || 0;
    const moved = MovementTracker.getMovedDistance(token.id);
    const remainingWalk = Math.max(0, walkSpeed - moved);
    const totalDash = (walkSpeed * 2); 
    const remainingDash = Math.max(0, totalDash - moved);

    debugLog(`DRAW: ${token.name} | Spd:${walkSpeed} | RemWalk:${remainingWalk} | RemDash:${remainingDash}`);

    if (remainingDash <= 0) {
        this.clear();
        return;
    }

    const { walkAnchors, dashAnchors } = this.calculateReachableAnchors(token, remainingWalk, remainingDash);
    const walkSet = this.expandToFootprint(token, walkAnchors);
    const dashSet = this.expandToFootprint(token, dashAnchors);

    this.renderGraphics(walkSet, dashSet);
  }

  static calculateReachableAnchors(token, walkDist, dashDist) {
    const gridSize = canvas.dimensions.size;
    const widthSquares = Math.max(1, Math.ceil(token.document.width));
    const heightSquares = Math.max(1, Math.ceil(token.document.height));

    const center = token.center;
    const halfWidth = (widthSquares * gridSize) / 2;
    const halfHeight = (heightSquares * gridSize) / 2;
    
    const idealTopLeft = {
        x: center.x - halfWidth,
        y: center.y - halfHeight
    };

    const startOffset = canvas.grid.getOffset(idealTopLeft);
    debugLog(`Anchor Calc: Center(${Math.round(center.x)},${Math.round(center.y)}) -> Offset[${startOffset.i},${startOffset.j}]`);
    
    const getCenterFromAnchor = (offset) => {
        const tl = canvas.grid.getTopLeftPoint(offset);
        return {
            x: tl.x + halfWidth,
            y: tl.y + halfHeight
        };
    };

    const walkAnchors = new Set();
    const dashAnchors = new Set();
    const getKey = (o) => `${o.i},${o.j}`;

    const queue = [{ offset: startOffset, cost: 0 }];
    const visited = new Map();
    visited.set(getKey(startOffset), 0);
    
    const moveCollision = CONFIG.Canvas.polygonBackends.move;
    let debugCount = 0;

    while (queue.length) {
      queue.sort((a, b) => a.cost - b.cost);
      const current = queue.shift();
      const currentKey = getKey(current.offset);
      
      if (current.cost <= walkDist) walkAnchors.add(currentKey);
      if (current.cost <= dashDist) dashAnchors.add(currentKey);
      
      if (current.cost >= dashDist) continue;

      const neighbors = canvas.grid.getAdjacentOffsets(current.offset);
      
      for (const neighbor of neighbors) {
        const nKey = getKey(neighbor);
        
        const currCenter = getCenterFromAnchor(current.offset);
        const nextCenter = getCenterFromAnchor(neighbor);

        if (moveCollision.testCollision(currCenter, nextCenter, { mode: "any", type: "move" })) continue;

        let stepCost = 0;
        try {
            const result = canvas.grid.measurePath([currCenter, nextCenter]);
            stepCost = result.distance;
        } catch (e) {
            stepCost = canvas.dimensions.distance;
        }
        
        stepCost = Math.round(stepCost * 100) / 100;
        const newCost = current.cost + stepCost;
        const safeCost = Math.round(newCost * 100) / 100;
        
        if (debugCount < 5 && current.cost === 0) {
             debugLog(` Neighbor check: Cost +${stepCost} = ${safeCost}`);
        }

        if (safeCost > dashDist + 0.01) continue;
        if (visited.has(nKey) && visited.get(nKey) <= safeCost) continue;

        visited.set(nKey, safeCost);
        queue.push({ offset: neighbor, cost: safeCost });
      }
      if (current.cost === 0) debugCount++;
    }

    return { walkAnchors, dashAnchors };
  }

  static expandToFootprint(token, anchorSet) {
    const expanded = new Set();
    const width = Math.max(1, Math.ceil(token.document.width));
    const height = Math.max(1, Math.ceil(token.document.height));

    for (const key of anchorSet) {
        const [i, j] = key.split(',').map(Number);
        // Expand simply in index space. If i=Row, j=Col or vice versa, consistency holds as long as render uses consistent keys.
        for (let dx = 0; dx < width; dx++) {
            for (let dy = 0; dy < height; dy++) {
                expanded.add(`${i + dx},${j + dy}`);
            }
        }
    }
    return expanded;
  }

  static renderGraphics(walkSet, dashSet) {
    if (!this.container || this.container.destroyed) {
      this.container = new PIXI.Container();
      canvas.interface.grid.addChild(this.container);
    }
    
    this.container.removeChildren();
    const graphics = new PIXI.Graphics();
    this.container.addChild(graphics);

    const size = canvas.dimensions.size;
    const halfSize = size / 2;

    const parseKey = (k) => {
      const [i, j] = k.split(',').map(Number);
      return { i, j };
    };

    // Helper: Get Key from World Point
    // This ensures we check "Physical Left" regardless of i/j mapping
    const getKeyFromPoint = (x, y) => {
        const off = canvas.grid.getOffset({x, y});
        return `${off.i},${off.j}`;
    };

    const drawRegion = (set, style, excludeSet = null) => {
      // 1. Fill
      graphics.beginFill(style.fillColor, style.fillAlpha);
      graphics.lineStyle(0);

      for (const key of set) {
        if (excludeSet && excludeSet.has(key)) continue;
        const { i, j } = parseKey(key);
        const pt = canvas.grid.getTopLeftPoint({ i, j });
        graphics.drawRect(pt.x, pt.y, size, size);
      }
      graphics.endFill();

      // 2. Borders - Robust Physical Check
      graphics.lineStyle(style.borderWidth, style.borderColor, style.borderAlpha, 0.5);
      
      for (const key of set) {
        if (excludeSet && excludeSet.has(key)) continue;

        const { i, j } = parseKey(key);
        const pt = canvas.grid.getTopLeftPoint({ i, j });
        
        // Calculate Center of current cell
        const cx = pt.x + halfSize;
        const cy = pt.y + halfSize;

        // Check Top Neighbor (Physical Up)
        // We sample a point 1 grid unit Up from center
        const topKey = getKeyFromPoint(cx, cy - size);
        if (!set.has(topKey)) {
            graphics.moveTo(pt.x, pt.y).lineTo(pt.x + size, pt.y);
        }

        // Check Bottom Neighbor (Physical Down)
        const bottomKey = getKeyFromPoint(cx, cy + size);
        if (!set.has(bottomKey)) {
            graphics.moveTo(pt.x, pt.y + size).lineTo(pt.x + size, pt.y + size);
        }

        // Check Left Neighbor (Physical Left)
        const leftKey = getKeyFromPoint(cx - size, cy);
        if (!set.has(leftKey)) {
            graphics.moveTo(pt.x, pt.y).lineTo(pt.x, pt.y + size);
        }

        // Check Right Neighbor (Physical Right)
        const rightKey = getKeyFromPoint(cx + size, cy);
        if (!set.has(rightKey)) {
            graphics.moveTo(pt.x + size, pt.y).lineTo(pt.x + size, pt.y + size);
        }
      }
    };

    // Draw Dash (Outer Ring)
    // We only draw border if the neighbor is NOT in Dash set. 
    // Inner edge touching Walk set will have neighbors in Dash set (since Dash contains Walk), so no border.
    drawRegion(dashSet, STYLES.dash, walkSet);
    
    // Draw Walk (Inner Block)
    drawRegion(walkSet, STYLES.walk);
  }
}

Hooks.once("init", () => EasyGridMovement.init());