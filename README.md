# running

Static dashboard of my Strava running data, published at
[austinbrian.github.io/running](https://austinbrian.github.io/running/).

## How it works

No backend and no build step. A daily GitHub Actions job calls the Strava API,
merges anything new into `activities.json` in a Cloudflare R2 bucket, and
uploads it back. The page fetches that object directly and renders every chart
client-side with Plotly. No run data is stored in this repo.

```
index.html                        page shell, dashboard markup, and DATA_URL
assets/dashboard.css              styles, loosely mirroring austinbrian.github.io
assets/running-dashboard.js       chart rendering and interaction
scripts/sync_strava.py            Strava fetch, merge, and R2 upload
.github/workflows/sync-strava.yml daily cron
```

## Setup

### Strava

Three repository secrets:

- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_REFRESH_TOKEN`

The Strava API application must also be **Active** — check
[strava.com/settings/api](https://www.strava.com/settings/api). An inactive
application returns `403 {"resource":"Application","field":"Status","code":"Inactive"}`
on every data endpoint while OAuth token refresh continues to succeed, which
makes the failure easy to misread as an expired token.

### Cloudflare R2

Three more repository secrets, plus one repository variable:

- `R2_ACCOUNT_ID` — Cloudflare account id
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — an R2 API token scoped to
  **Object Read & Write** on this bucket alone
- `R2_BUCKET_NAME` (variable, defaults to `strava-data`)

Public read access is enabled via the r2.dev subdomain, and `DATA_URL` in
`index.html` points at it:

```
https://pub-0894dbef034948d8881890a14025ac52.r2.dev/activities.json
```

Note that r2.dev is rate limited and Cloudflare does not recommend it for
production traffic. For a personal dashboard it is fine; binding a custom
domain to the bucket is the upgrade path.

**CORS is required.** The page is served from `austinbrian.github.io` and fetches
from an `r2.dev` host, so the bucket needs a CORS policy allowing that origin:

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://austinbrian.github.io"],
        "methods": ["GET", "HEAD"],
        "headers": ["*"]
      },
      "maxAgeSeconds": 3600
    }
  ]
}
```

Applied with `wrangler r2 bucket cors set strava-data --file cors.json`. Note
that this is wrangler's schema, not the S3 `AllowedOrigins` shape.

Without CORS the fetch fails in the browser while `curl` still succeeds — the
failure shows up only in the console, not in a status code. Verify with:

```sh
curl -sI -H "Origin: https://austinbrian.github.io" \
  https://pub-0894dbef034948d8881890a14025ac52.r2.dev/activities.json \
  | grep -i access-control
```

Run the sync by hand from the Actions tab, or locally with the six variables
exported.

### Adding a field

`ACTIVITY_FIELDS` in `sync_strava.py` maps each Strava summary field to the
default used when Strava omits the key or sends an explicit null — the two are
not distinguishable and both mean "not reported", so they get the same stand-in.

An existing record cannot grow a field retroactively, so after adding one:

```sh
python scripts/sync_strava.py --full
```

That ignores the latest-activity timestamp and re-fetches everything. Summaries
page 200 at a time, so the whole history is about six requests. Records that are
not re-fetched are still filled with defaults by `normalize()`, so the object
stays uniform either way and charts never need their own fallbacks.

## Local preview

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. A `file://` open will not work, because the
dashboard fetches over HTTP. Note that `http://localhost` is not in the CORS
allowlist above, so add it temporarily if you need to test against live data.
