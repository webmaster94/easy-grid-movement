const BG3_ID = "bg3-combat-bar";

interface Economy {
  key: string;
  action: number;
  bonus: number;
  [key: string]: unknown;
}

export interface BG3Context {
  document: {
    uuid: string;
    setFlag(scope: string, key: string, value: unknown): Promise<unknown>;
  };
}

export interface BG3State {
  context(this: void, token: TokenDocument): BG3Context | null;
  actionCost(actor: NonNullable<Token["actor"]>, action: string): string;
  canSpend(context: BG3Context, cost: string): boolean;
  consume(this: void, context: BG3Context, cost: string): Promise<void>;
  economy(context: BG3Context): Economy;
  serial<T>(key: string, action: () => Promise<T>): Promise<T>;
}

export interface DashAction {
  cost: "action" | "bonus";
  available(): boolean;
  spend(): Promise<() => Promise<void>>;
}

export async function loadDashAction(token: Token): Promise<DashAction | null> {
  if (!game.modules?.get(BG3_ID)?.active) return null;
  // BG3 0.1.4 exposes its context through api, but its action mutations live in state.js.
  // Load the same exported functions as the bar so storage, turn keys, and queues stay shared.
  const url = `/modules/${BG3_ID}/scripts/state.js`;
  const state = await import(/* @vite-ignore */ url) as BG3State;
  return bg3DashAction(token, state);
}

export function bg3DashAction(token: Token, state: BG3State): DashAction {
  const context = state.context(token.document);
  if (!context || !token.actor) throw new Error("BG3 Combat Bar could not find this token's action tracker.");
  const cost = state.actionCost(token.actor, "dash");
  if (cost !== "action" && cost !== "bonus") throw new Error("BG3 Dash must be configured to use an action or bonus action.");
  return {
    cost,
    available: () => token.actor?.isOwner !== false && !token.actor?.statuses?.has("incapacitated") && state.canSpend(context, cost),
    spend: async () => {
      const inCombat = game.combat?.started;
      await state.consume(context, cost);
      const spent = state.economy(context);
      let refunded = false;
      return async () => {
        if (refunded || !inCombat) return;
        refunded = true;
        await state.serial(`${context.document.uuid}:economy`, async () => {
          const current = state.economy(context);
          // Only return this reservation; never overwrite another turn or a manual correction.
          if (current.key !== spent.key || current[cost] !== spent[cost]) return;
          await context.document.setFlag(BG3_ID, "economy", { ...current, [cost]: current[cost] + 1 });
        });
      };
    },
  };
}
