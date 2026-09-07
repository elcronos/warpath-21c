# Warpath Command

An offline, single-player, browser-based 4X base-builder — a fan-made tribute to the mobile
strategy game *Warpath: Ace Shooter / 21st Century*.

Build a command base, research a tech tree, train a combined-arms army, raid a procedurally
generated world map, recruit commanders, and grind twenty campaign stages. Everything runs
in the browser, on your machine, with no account, no server and no network traffic.

**Pure static site.** No build step, no bundler, no npm, no CDN, no external requests of any
kind. Every graphic is inline SVG generated in JavaScript. Your save lives in `localStorage`.

---

## Running it locally

**Option A — a local web server (recommended)**

```bash
cd warpath_claude
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Any static server works equally well (`npx serve`, `php -S localhost:8000`, VS Code Live
Server, …) — the project has no server-side component.

**Option B — opening `index.html` directly**

Double-clicking `index.html` works in Safari and Firefox. **It does not work in Chrome or
Edge**: those browsers refuse to load ES modules over `file://` for security reasons
(module scripts are subject to CORS, and `file://` origins are opaque). You will get a
blank page and a CORS error in the console. Use Option A for Chromium browsers.

No data is ever fetched at runtime — all game data is JavaScript modules — so the game is
fully functional offline once the page has loaded.

---

## Deploying to GitHub Pages

The repository root *is* the site. There is nothing to compile.

1. Push the repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
4. Choose your branch (e.g. `main`) and the **`/ (root)`** folder. Save.
5. Wait for the Pages build, then visit `https://<user>.github.io/<repo>/`.

A `.nojekyll` file is already present in the root. Keep it — without it, GitHub Pages runs
the files through Jekyll, which strips directories beginning with an underscore and can
interfere with static asset serving.

All internal paths are relative (`./js/main.js`, `./css/style.css`), so the game works from
a project subpath as well as from a user/organisation root domain.

---

## Controls

The whole game is pointer-driven and built mobile-first (360×640 and up). Every control is a
tap target; there are no hover-only interactions and no keyboard requirements.

| Where | Action |
| --- | --- |
| Bottom navigation | Switch between the seven screens |
| Base — empty plot | Tap to open the build picker |
| Base — a building | Tap to open its detail sheet (upgrade, speed up, jump to its screen) |
| Base / Map | Drag to pan · pinch or scroll-wheel to zoom · `+` / `−` buttons |
| Map — a tile | Tap for the sector sheet: Scout, Gather, Attack, Centre |
| Map — march composer | Steppers and **Max** to pick troops, then choose a commander |
| Army | Tap a unit card to open the training sheet; batch steppers set the size |
| Research | Tap a branch tab, then a node in the tech tree |
| Officers | Roster / Recruit tabs; tap a portrait for level-up, promotion and assignment |
| Campaign | Tap a stage for the briefing, pick a task force, then **Engage** |
| Anywhere | `Esc` closes the topmost dialog |

URLs are hash-routed (`#base`, `#map`, `#army`, `#research`, `#officers`, `#campaign`,
`#settings`), so screens are linkable and the browser back button works. The router defaults
to `#base`.

---

## Features

**Base building** — 16 facility types on an 8×8 isometric plot grid, each 1–30. The HQ gates
every other building's level. Costs, build times and output all come from formulas, so all
30 levels genuinely exist. Construction uses a main queue plus a free quick slot, with gold
speed-ups and free finishes under five minutes.

**Economy** — oil, steel, rare earth and food produced per hour; warehouses give storage caps
plus a raid-protected reserve; the army eats food, and a sustained deficit starves it.

**Offline progress** — the game records when you left and applies production, construction,
research, training, healing and marches on your next load, capped at 12 hours. A welcome-back
report shows exactly what accrued.

**Research** — 40 technologies across Economy, Infantry, Vehicles and Aviation, with
prerequisite chains, Research-Lab gating and level scaling. Everything feeds one central
`getBonus(key)` used by the rest of the engine.

**Units and combat** — 32 units: four classes × eight tiers, unlocked by factory level and
doctrine tech. The counter triangle is **tanks beat infantry**, **infantry beat aircraft**
(anti-air), **aircraft beat tanks** (air-to-ground); artillery is a support class that hits
everything harder, fires last and takes double damage. Battles resolve in rounds with a
damage matrix, officer skills, tech bonuses, HP pools and walls, and produce a detailed
round-by-round report. Casualties split into dead and wounded; wounded go to the Hospital if
there is a free bed.

**World map** — a 40×40 grid generated from your save's seed: resource nodes, NPC camps
(levels 1–30), ruins, and your city. Scout to reveal, gather to haul resources home, attack
for loot. Travel time scales with distance and your slowest unit; marches can be recalled.

**Officers** — 12 commanders across three rarities, with levels, star promotion via fragments,
passive bonuses and an active battle skill. Recruit through a gold draw with a pity counter.
Assign them to your garrison or as march leaders.

**Campaign** — 20 PvE stages with fixed enemy compositions, a difficulty ramp from ~640 power
to over a million, first-clear rewards and the same combat resolver as everything else.

**Progression** — a power score aggregated from buildings, tech, army and officers; an
activity log; and toasts for everything that completes.

---

## Project layout

```
index.html            single page; mounts #app and imports js/main.js
css/style.css         all styling — CSS custom properties, dark military theme
js/main.js            bootstrap + hash router + welcome-back report
js/util/              fmt (format/RNG), events (pub-sub), dom (h/svg helpers)
js/data/              pure data tables: balance, buildings, units, tech, officers, campaign
js/engine/            state, bonus, economy, build, research, training, combat, worldmap,
                      officers, loop — systems that mutate state and emit events
js/ui/                registry, shell, svg/svg-art, and one module per screen
tools/smoke.mjs       headless integration test (see below)
```

`js/engine/state.js` owns the single mutable `S` object and persistence
(`localStorage` key `warpath_save_v1`, with migration on load).

---

## Tests

A headless integration smoke test drives the whole engine in Node — new game, building,
ticking time, research, training, healing, combat, map generation, marches, officers,
offline progress and a save round-trip:

```bash
node tools/smoke.mjs
```

It stubs only `localStorage`, imports the real modules the browser loads, and exits non-zero
if any assertion fails. It is a development tool and is not part of the deployed site.

---

## Save data

Everything lives under the `localStorage` key `warpath_save_v1` on the origin you play from.
Settings → Export copies your save to the clipboard, Import restores one, and Reset wipes it.
Clearing site data for the origin deletes your progress.

---

## Credits and legal

Fan-made, non-commercial, offline tribute. **Not affiliated with, endorsed by, or connected
to Lilith Games** or the *Warpath* franchise in any way. No assets from the original game are
used — every graphic here is SVG drawn in code. All trademarks belong to their respective
owners.
