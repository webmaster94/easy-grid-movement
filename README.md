# Easy Grid Movement

Easy Grid Movement provides XCOM-inspired movement planning for Foundry VTT. It uses D&D 5e's native token-ruler colors: green destinations use the token's remaining normal movement, yellow destinations require a Dash, and red destinations preview movement beyond the current turn's allowance.

The interaction model follows the [XCOM 2 manual](https://www.feralinteractive.com/en/manuals/xcom2/latest/steam/): a one-action range, a dash range, and a visible route before committing movement.

- Hover a destination to see the exact wall-aware route and movement cost.
- Click a highlighted destination to move the token along that route.
- Movement spent during the current combat turn is subtracted immediately.
- Paths are rendered from the center of the token's footprint and show green, yellow, and red segments as cumulative cost crosses each movement threshold.
- Hovered destinations can be raised or lowered with the mouse wheel; the chosen elevation is included in Foundry's native path constraint, terrain, 3D measurement, and movement-history pipelines.
- Foundry v14 wall, token-footprint, occupied-space, terrain-cost, and diagonal-distance rules are used when planning.
- Native difficult-terrain regions are identified through Foundry's terrain movement path; affected cells use angular hatching and affected route segments use an angular line.

## Requirements

- Foundry Virtual Tabletop 14
- A square-grid scene
- An actor with a walking speed

## Usage

1. Control a token.
2. Press `M` to toggle the overlay.
3. Hover any highlighted square to preview its route and cost.
4. While hovering, scroll the mouse wheel up or down to raise or lower the destination by one grid-distance step. Hold `Shift` while scrolling to use Foundry's precise elevation increment.
5. Click a green or yellow square to move there. Red squares are preview-only.

During combat, movement is tracked until the turn changes. Outside combat, movement is tracked while the overlay remains active; toggle it off and on to begin a fresh planning session.

The key can be changed in Foundry's **Configure Controls** menu. Client-side diagnostic logging is available in **Module Settings**.

## Installation

Paste this manifest URL into Foundry's **Install Module** dialog:

```text
https://github.com/webmaster94/easy-grid-movement/releases/latest/download/module.json
```

## Development

```bash
npm install
npm run check
npm run package
```

- `npm run build` creates a loadable module in `dist/`.
- `npm run build:watch` rebuilds during development.
- `npm run check` runs linting, strict TypeScript checks, unit tests, the production build, and manifest validation.
- `npm run package` creates the Foundry release manifest and zip in `package/`.

Pushes and pull requests run the same checks in GitHub Actions. Publishing a GitHub release with a tag such as `v1.3.0` runs the League of Foundry Developers release workflow and attaches `module.json` and `module.zip`.
