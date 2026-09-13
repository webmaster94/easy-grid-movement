import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bg3DashAction, type BG3Context, type BG3State } from "../src/bg3-integration";
import { DashController } from "../src/dash";

describe("Dash action integration", () => {
  let token: Token;
  let state: BG3State;
  let context: BG3Context;
  let controller: DashController;
  let confirm: ReturnType<typeof vi.fn<(options: unknown) => Promise<boolean | null>>>;
  let saved: ReturnType<BG3State["economy"]>;
  let allowance: unknown;
  let cost: "action" | "bonus";

  beforeEach(() => {
    allowance = undefined;
    cost = "action";
    saved = { key: "combat:1:actor", action: 1, bonus: 1, reaction: 1 };
    token = {
      id: "token", actor: { isOwner: true, statuses: new Set() },
      document: { getFlag: () => allowance, setFlag: vi.fn((_scope, _key, value: unknown) => { allowance = value; return Promise.resolve(); }) },
    } as unknown as Token;
    context = { document: {
      uuid: "Actor.linked", setFlag: vi.fn((_scope, _key, value) => { saved = value as typeof saved; return Promise.resolve(); }),
    } };
    state = {
      context: vi.fn(() => context), actionCost: () => cost,
      economy: () => ({ ...saved }), canSpend: (_ctx, resource) => Number(saved[resource]) > 0,
      consume: vi.fn<BG3State["consume"]>((_ctx, resource) => {
        if (Number(saved[resource]) <= 0) return Promise.reject(new Error("Action already spent"));
        saved = { ...saved, [resource]: Number(saved[resource]) - 1 };
        return Promise.resolve();
      }),
      serial: (_key, action) => action(),
    };
    confirm = vi.fn<(options: unknown) => Promise<boolean | null>>().mockResolvedValue(true);
    vi.stubGlobal("game", {
      combat: { id: "combat", round: 1, turn: 0, started: true },
      settings: { get: () => true }, i18n: { localize: (s: string) => s },
    });
    vi.stubGlobal("ui", { notifications: { warn: vi.fn() } });
    vi.stubGlobal("foundry", { applications: { api: { DialogV2: { confirm } } } });
    controller = new DashController(() => Promise.resolve(bg3DashAction(token, state)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the bar's token context and reserves exactly one action", async () => {
    await controller.reserve(token, 30, false, () => true);
    expect(vi.mocked(state.context).mock.calls[0]?.[0]).toBe(token.document);
    expect(vi.mocked(state.consume)).toHaveBeenCalledWith(context, "action");
    expect(saved).toMatchObject({ action: 0, bonus: 1, reaction: 1 });
    expect(controller.bonus(token)).toBe(30);
  });

  it("honors a bonus-action Dash override and names the correct resource", async () => {
    cost = "bonus";
    await controller.reserve(token, 30, false, () => true);
    expect(saved).toMatchObject({ action: 1, bonus: 0, reaction: 1 });
    expect(confirm.mock.lastCall?.[0]).toMatchObject({ content: "<p>EGM.Dash.BonusPrompt</p>" });
  });

  it("does not spend or grant movement on cancel", async () => {
    confirm.mockResolvedValue(false);
    expect(await controller.reserve(token, 30, false, () => true)).toBeNull();
    expect(vi.mocked(state.consume)).not.toHaveBeenCalled();
    expect(allowance).toBeUndefined();
  });

  it("rejects a spent action, including one spent while the dialog was open", async () => {
    confirm.mockImplementation(() => { saved.action = 0; return Promise.resolve(true); });
    expect(await controller.reserve(token, 30, false, () => true)).toBeNull();
    expect(vi.mocked(state.consume)).not.toHaveBeenCalled();
    expect(await controller.reserve(token, 30, false, () => true)).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("returns only the reserved resource on failure, preserving another resource spent later", async () => {
    const reservation = await controller.reserve(token, 30, false, () => true);
    saved.bonus = 0;
    await reservation!.rollback();
    await reservation!.rollback();
    expect(saved).toMatchObject({ action: 1, bonus: 0, reaction: 1 });
    expect(controller.bonus(token)).toBe(0);
  });

  it("does not refund into a later turn or overwrite a manual resource restore", async () => {
    const reservation = await controller.reserve(token, 30, false, () => true);
    saved = { ...saved, key: "combat:2:actor", action: 1 };
    game.combat!.round = 2;
    await reservation!.rollback();
    expect(saved.action).toBe(1);
    expect(controller.bonus(token)).toBe(0);
  });

  it("retains combat allowance in a new controller, but not on the next turn", async () => {
    await controller.reserve(token, 30, false, () => true);
    expect(new DashController().bonus(token)).toBe(30);
    game.combat!.turn = 1;
    expect(controller.bonus(token)).toBe(0);
  });

  it("still spends the action when confirmation is turned off", async () => {
    game.settings.get = () => false;
    await controller.reserve(token, 30, false, () => true);
    expect(confirm).not.toHaveBeenCalled();
    expect(saved.action).toBe(0);
  });

  it("fails closed if the optional bar integration cannot load", async () => {
    controller = new DashController(() => Promise.reject(new Error("Module unavailable")));
    await expect(controller.reserve(token, 30, false, () => true)).rejects.toThrow("Module unavailable");
    expect(allowance).toBeUndefined();
  });

  it("refunds if persisting the allowance fails", async () => {
    token.document.setFlag = () => Promise.reject(new Error("Permission denied"));
    await expect(controller.reserve(token, 30, false, () => true)).rejects.toThrow("Permission denied");
    expect(saved.action).toBe(1);
  });
});
