# SkillSelect EOI Explorer

An unofficial, fully-filterable explorer for the Department of Employment and Workplace
Relations' public [SkillSelect EOI dashboard](https://api.dynamic.reports.employment.gov.au/anonap/extensions/hSKLS02_SkillSelect_EOI_Data/hSKLS02_SkillSelect_EOI_Data.html).

The source dashboard only lets you view two extra columns at a time and pick a single "as at"
month. This site lets you filter and cross-reference every field at once, and see trends across
every month published so far — with no backend server, just a static site.

## How it works

- **Data source**: the source dashboard is a Qlik Sense app (not a REST API). Data is pulled
  directly from Qlik's Engine API over WebSocket using `enigma.js`, bypassing the rendered
  UI entirely. See `../skillselect-scraper`.
- **Storage**: rather than one flat JSON blob (which can't stay responsive at this scale — the
  full dataset is several million rows), the data is loaded into a SQLite database, dictionary-encoded
  and lightly indexed, then split into ~20MB chunks.
- **Querying**: the browser runs real SQL over that database via
  [`sql.js-httpvfs`](https://github.com/phiresky/sql.js-httpvfs) — SQLite compiled to WebAssembly with
  an HTTP-range-request virtual filesystem. Each filter change only fetches the bytes needed to
  answer that query, not the whole database.
- **Hosting**: 100% static files (HTML/CSS/JS + the chunked `.sqlite3` data + `sql.js-httpvfs`'s
  worker/wasm) — works on GitHub Pages with no server component.

## Two datasets

| Dataset | Fields | Coverage |
|---|---|---|
| **History & Trends** | Visa Type, EOI Status, Occupation, Occupation Group, Nominated State, Points Score | All ~24 monthly snapshots published so far |
| **Latest Snapshot (Full Detail)** | Every field the source exposes — adds English Test Score, Australian Study, Regional Study, Community Language Qualification, Specialist Education, Professional Year, Partner Skills Score, Month Submitted | Most recent month only |

This split exists because full detail × full history is ~17-24 million rows — no browser filters
that smoothly, regardless of hosting. See `../skillselect-scraper/build_sqlite.js` for the exact
row-count tradeoffs measured.

## Privacy

The source dashboard suppresses any count under 20 to avoid identifying individuals from small
groups ("shown as '<20'"). The raw pull via the Engine API returns exact numbers even for very
small cells, so this site enforces the same `<20` masking in the UI for any figure tied to a
specific filter combination — only broad, safely-aggregated totals show exact numbers.

## Updating the data

From `../skillselect-scraper`:

```bash
node scrape_tier1.js   # full history, core fields — resumable, ~15 min
node scrape_tier2.js   # latest month, full detail — resumable, ~45 min
node build_sqlite.js   # builds + chunks data/*.sqlite3.part* into this repo's data/
```

Each scrape script checkpoints progress to disk and can be safely re-run if interrupted.

## Local development

```bash
npx http-server . -p 8123 --cors
```

Then open `http://localhost:8123`. A plain `file://` open won't work — the database fetch needs
real HTTP Range request support.

## Deploying to GitHub Pages

1. Push this directory's contents to a GitHub repo.
2. In the repo's Settings → Pages, set the source to the branch/folder you pushed.
3. No build step is needed — it's already static files.

## Credits

Not affiliated with the Department of Home Affairs, the Department of Employment and Workplace
Relations, or SkillSelect. Built on top of publicly-available data from their own EOI dashboard.
