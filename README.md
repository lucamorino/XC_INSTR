# XC_INSTR — Xplosive Collision instrument

A static test space for the **Xplosive Collision** instrument: the same RNBO
device (`NOISE-GAME_v2`, rnbo.js 1.4.2), the same scene and the same motion
mapping as the networked [xplosive_collision](https://github.com/lucamorino/xplosive_collision)
player, packaged as a plain website so the instrument can be tried and shared
from GitHub Pages.

No server, no other players, no controller. Your opponent is a **ghost**.

## Using it

- Press **>>>** to start (on iOS, allow the motion sensors).
- **Tilt the phone** to move your dot. Without motion sensors (desktop, or
  permission denied) you drag the dot with the mouse or finger instead.
- **The ghost** is a fake opponent created at a random, hidden spot in the space.
  It acts like the other player did in XC:
  - inside its **periphery** (30 units) and **proximity** (15 units) radii it
    switches the device's `periphery` / `proximity` inports, which drive the
    patch's modulation;
  - on a **collision** (5 units) the device jumps to a random preset (0–6) and
    your dot lights up.
- The three buttons at the bottom of the page:
  1. **ghost** — show / hide the opponent (hidden by default).
  2. **auto** — the ghost moves on its own, drifting between random spots.
  3. **trial / game** — switch the session:
     - **trial** (default) shows the device's **sharpness**;
     - **game** shows your S-points against the ghost's. The first to 10 wins.
       The ghost earns its points at a random rate (~0.05/s on average). Tap
       the game-over screen to play again.

## How it maps to XC

| XC (networked)                                     | XC_INSTR (static)                          |
| -------------------------------------------------- | ------------------------------------------ |
| other players' `control` states                    | the ghost                                  |
| server `evaluateCollisions()`                      | the same check, between you and the ghost  |
| `global.training` (controller switch)              | **trial / game** button                    |
| `global.running` / game over                       | starts with the page; ends at 10 S-points  |
| `collision_distance`, `proximity_offset`, `periphery_offset`, `preset_range_*` | constants at the top of `js/app.js` |
| `global.alarm`                                     | `ALARM` constant (off; no controller here) |
| `@ircam/devicemotion`, platform-init screen        | `devicemotion` event, enter screen         |

## Layout

```
index.html                    entry point
js/app.js                     the scene, ghost and audio graph (ES module, no build step)
js/vendor/lit-html.js         lit-html 3.3.3 (BSD-3-Clause, see lit-html.LICENSE)
style/app.scss → app.css      styles (app.css is committed, compiled from app.scss)
assets/rnbo_export/           RNBO export of the device (patch.export.json)
assets/rnbo/<version>/        rnbo.js matching the export (1.4.2)
assets/fonts/                 Roboto Condensed, self-hosted
tools/sync-from-xc.sh         pull a new export from an xplosive_collision checkout
```

`rnbo.js` is loaded for the version recorded in the export
(`desc.meta.rnboversion`), from `assets/rnbo/<version>/` first and from the
Cycling '74 CDN if that copy is missing.

## Updating the device

Re-export the patch from Max into the xplosive_collision project, then:

```bash
tools/sync-from-xc.sh ../xplosive_collision
```

This copies `patch.export.json` and the matching `rnbo.js` here (dropping the
old ones) and recompiles the stylesheet. Set `EXPORT=<name>.export.json` if the
export is renamed, and update `PATCH_EXPORT_URL` in `js/app.js` to match.

## Running locally

Any static server works — the page uses ES modules and `fetch`, so it can't be
opened as a `file://` URL:

```bash
python3 -m http.server 8000
```

Motion sensors need https on phones (GitHub Pages provides it). From the
browser console, `xc.session`, `xc.me` and `xc.ghost` show the live state.

## Publishing on GitHub Pages

Settings → Pages → *Deploy from a branch* → `main` / `(root)`. The `.nojekyll`
file makes Pages serve the files as they are.
