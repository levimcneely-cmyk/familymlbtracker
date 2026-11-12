# Family MLB Tracker

A single-page tracker for four family teams (Dad = Rays, Mom = Brewers, Brady = Blue Jays, Deacon = Reds), using MLB's free public Stats API (no key needed).
Live site: https://levimcneely-cmyk.github.io/familymlbtracker/

## What it shows
- Record, MLB rank, streak, last 10, run differential, division standing
- Five stat categories; the family leader in each gets a gold ★ (lowest wins for RA). Cards sort by ★, ties by MLB rank
- Previous opponent / last score, next opponent / date / time (Eastern by default; **Times** button switches to your local time)
- Live score strip, World Series banner, 🏆 champion badge, league-champion pennant, division / wild card / playoff-round chips
- Family showdown banner when two family teams play each other
- Tap **Details** on a card: last 10 games, probable pitchers, division standings, live line score
- Season trend chart, past seasons panel, offline/installable (add to home screen)

## Layout
| Path | Purpose |
|---|---|
| `index.html`, `css/style.css` | Page and styles |
| `js/config.js` | **Edit this to change teams, owners, colors** |
| `js/core.js` | Data fetching, season logic, ranking (shared by the page and the data job) |
| `js/app.js` | Rendering and the refresh loop |
| `scripts/update-data.js` | Scheduled job: writes `snapshot.json`, `trend.json`, `history.json` |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline + install |
| `tests/` | `npm test` (needs `npm install` first) |

## Scheduled data job
`.github/workflows/update-data.yml` runs every ~10 minutes, fetches MLB once, and force-pushes the results to the `data` branch.
The page reads that snapshot first (when it's under 30 minutes old and from today), then falls back to calling MLB directly, so it keeps working if the job is late or the branch doesn't exist yet. It also gives every device the same trend chart and past-seasons list.
First run: Actions tab → "Update MLB data" → Run workflow (this creates the `data` branch).
Settings → Pages must serve the `main` branch (root).

## Debugging
Add `?debug` to the URL, or tap "debug" in the footer, for request logs and raw API responses.
