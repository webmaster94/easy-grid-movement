import { CONFIRM_DASH_SETTING, MODULE_ID } from "./constants";
import { loadDashAction, type DashAction } from "./bg3-integration";

interface DashAllowance { key: string; bonus: number }
export interface DashReservation { rollback(): Promise<void> }

export function movementTurnKey(): string {
  const combat = game.combat;
  return combat?.started ? `${combat.id}:${combat.round}:${combat.turn}` : "outside";
}

export class DashController {
  readonly #outside = new Map<string, DashAllowance>();
  readonly #loadAction: (token: Token) => Promise<DashAction | null>;

  constructor(loadAction = loadDashAction) { this.#loadAction = loadAction; }

  reset(tokenId: string): void { this.#outside.delete(tokenId); }

  bonus(token: Token): number {
    const stored = game.combat?.started
      ? token.document.getFlag(MODULE_ID, "dashAllowance")
      : this.#outside.get(token.id);
    if (!stored || typeof stored !== "object" || !("key" in stored) || !("bonus" in stored)) return 0;
    return stored.key === movementTurnKey() && typeof stored.bonus === "number" && Number.isFinite(stored.bonus)
      ? Math.max(0, stored.bonus) : 0;
  }

  async reserve(
    token: Token,
    speed: number,
    exceedsDash: boolean,
    isCurrent: () => boolean,
  ): Promise<DashReservation | null> {
    const action = await this.#loadAction(token);
    if (!isCurrent()) return null;
    if (action && !action.available()) {
      ui.notifications.warn(game.i18n.localize("EGM.Notify.NoDashAction"));
      return null;
    }
    if (game.settings.get(MODULE_ID, CONFIRM_DASH_SETTING) !== false) {
      const message = action?.cost === "bonus" ? "EGM.Dash.BonusPrompt" : "EGM.Dash.ActionPrompt";
      const warning = exceedsDash ? `<p>${game.i18n.localize("EGM.Dash.OverRange")}</p>` : "";
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("EGM.Dash.Title") },
        content: `<p>${game.i18n.localize(message)}</p>${warning}`,
        modal: true,
        rejectClose: false,
        yes: { label: game.i18n.localize("EGM.Dash.Confirm") },
        no: { label: game.i18n.localize("EGM.Dash.Cancel"), default: true },
      });
      if (confirmed !== true) return null;
    }
    if (!isCurrent()) return null;
    if (action && !action.available()) {
      ui.notifications.warn(game.i18n.localize("EGM.Notify.NoDashAction"));
      return null;
    }
    const key = movementTurnKey();
    const previous = this.bonus(token);
    const bonus = previous + speed;
    const refundAction = await action?.spend();
    let granted = false;
    let rolledBack = false;
    const rollback = async (): Promise<void> => {
      if (rolledBack) return;
      rolledBack = true;
      try {
        if (granted && movementTurnKey() === key && this.bonus(token) === bonus) {
          await this.#save(token, { key, bonus: previous });
        }
      } finally {
        await refundAction?.();
      }
    };
    try {
      if (!isCurrent()) { await rollback(); return null; }
      await this.#save(token, { key, bonus });
      granted = true;
      if (!isCurrent()) { await rollback(); return null; }
      return { rollback };
    } catch (error) {
      await rollback();
      throw error;
    }
  }

  async #save(token: Token, allowance: DashAllowance): Promise<void> {
    if (allowance.key === "outside") this.#outside.set(token.id, allowance);
    else await token.document.setFlag(MODULE_ID, "dashAllowance", allowance);
  }
}
