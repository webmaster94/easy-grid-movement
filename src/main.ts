import { easyGridMovement } from "./easy-grid-movement";

Hooks.once("init", () => easyGridMovement.initialize());

export { EasyGridMovement, easyGridMovement } from "./easy-grid-movement";
export { cellsWithin, expandToFootprint, findReachableCosts } from "./grid";
