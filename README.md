# running

Static dashboard of my Strava running data, published at
[austinbrian.github.io/running](https://austinbrian.github.io/running/).

## How it works

No backend and no build step. A daily GitHub Actions job calls the Strava API,
merges anything new into `data/activities.json`, and commits it. GitHub Pages
serves that file alongside the page, so the dashboard fetches it same-origin and
renders every chart client-side with Plotly.

```
index.html                        page shell and dashboard markup
assets/dashboard.css              styles, loosely mirroring austinbrian.github.io
assets/running-dashboard.js       chart rendering and interaction
data/activities.json              synced run data, committed by the workflow
scripts/sync_strava.py            Strava fetch and merge (standard library only)
.github/workflows/sync-strava.yml daily cron
```

## Setup

Three repository secrets are required:

- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_REFRESH_TOKEN`

The Strava API application must also be **Active** — check
[strava.com/settings/api](https://www.strava.com/settings/api). An inactive
application returns `403 {"resource":"Application","field":"Status","code":"Inactive"}`
on every data endpoint while OAuth token refresh continues to succeed, which
makes the failure easy to misread as an expired token.

Run the sync by hand from the Actions tab, or locally:

```sh
export STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... STRAVA_REFRESH_TOKEN=...
python scripts/sync_strava.py
```

## Local preview

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. A plain file:// open will not work, because the
dashboard fetches `data/activities.json` over HTTP.
