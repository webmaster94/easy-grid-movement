# Easy Grid Movement

Easy Grid Movement provides XCOM-inspired movement planning for Foundry VTT. Blue destinations use the token's remaining normal movement; yellow destinations require a Dash.

The interaction model follows the [XCOM 2 manual](https://www.feralinteractive.com/en/manuals/xcom2/latest/steam/): a blue one-action range, a yellow dash range, and a visible route before committing movement.

- Hover a destination to see the exact wall-aware route and movement cost.
- Click a highlighted destination to move the token along that route.
- Movement spent during the current combat turn is subtracted immediately.
- Foundry v14 wall, token-footprint, occupied-space, terrain-cost, and diagonal-distance rules are used when planning.

## Requirements

- Foundry Virtual Tabletop 14
- A square-grid scene
- An actor with a walking speed

## Usage

1. Control a token.
2. Press `M` to toggle the overlay.
3. Hover a highlighted square to preview its route and cost.
4. Click the square to move there.

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

Pushes and pull requests run the same checks in GitHub Actions. Publishing a GitHub release with a tag such as `v1.2.0` runs the League of Foundry Developers release workflow and attaches `module.json` and `module.zip`.
