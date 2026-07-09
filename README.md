# Easy Grid Movement

Easy Grid Movement highlights the square-grid spaces a controlled token can reach with its remaining walking movement. Blue shows normal movement; yellow shows the additional range available by taking a Dash.

## Requirements

- Foundry Virtual Tabletop 14
- A square-grid scene
- An actor with a walking speed

## Usage

1. Control a token.
2. Press `M` to toggle the overlay.
3. Move the token. During combat, the overlay subtracts movement already used during the current turn.

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

Pushes and pull requests run the same checks in GitHub Actions. Pushing a version tag such as `v1.1.0` creates a GitHub release whose assets match the URLs in `module.json`.
