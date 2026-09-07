"""Extract Strava's per-activity analysis — best efforts and mile splits — to R2.

Step 2 of .devlog/plans/strava-extraction.md. The summary payload that
sync_strava.py stores carries one pace per run, which is an average over the
whole thing. A fast mile inside an easy run is invisible in it, and that is
exactly what the zone engine needs to see: 2026-06-17 averages 8:21/mi and
contains a 7:58 mile.

`GET /activities/{id}` returns best_efforts[] already computed by Strava, plus
splits_standard[] with per-mile pace *and* heart rate. Same one-request cost as
the streams endpoint for a much smaller answer.

Resumable by construction, with no cursor to persist: read the id list from
activities.json, read what is already distilled from efforts.json, fetch the
difference, write back. Each run picks up where the last one stopped, so a
backfill interrupted by a rate limit, a failed job or a cancelled workflow
resumes correctly with no bookkeeping.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

REQUIRED_VARS = [
    "STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN",
    "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
]

STRAVA_CLIENT_ID = os.environ.get("STRAVA_CLIENT_ID", "")
STRAVA_CLIENT_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "")
STRAVA_REFRESH_TOKEN = os.environ.get("STRAVA_REFRESH_TOKEN", "")

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME") or "strava-data"

ACTIVITIES_KEY = "activities.json"
EFFORTS_KEY = "efforts.json"

METERS_TO_MILES = 0.000621371
METERS_TO_FEET = 3.28084

# Strava's own labels for the standard distances, mapped to short keys. Anything
# it reports that is not in here is kept under its own lowercased name rather
# than dropped, so a label change shows up in the data instead of vanishing.
EFFORT_KEYS = {
    "400m": "400m",
    "1/2 mile": "half_mile",
    "1k": "1k",
    "1 mile": "1mi",
    "2 mile": "2mi",
    "5k": "5k",
    "10k": "10k",
    "15k": "15k",
    "10 mile": "10mi",
    "20k": "20k",
    "half-marathon": "half",
    "marathon": "marathon",
}

# One 15-minute window's worth, with margin. Strava's read limit is reported per
# response and honoured from there; this is only the ceiling for a single pass.
DEFAULT_PER_WINDOW = 180

# Stop this far short of a reported limit. A 429 mid-pass is recoverable — the
# merge is keyed by id — but it wastes the rest of the window.
RATE_LIMIT_MARGIN = 10


def check_env() -> None:
    """Fail with the full list of what is missing, rather than a bare KeyError."""
    missing = [name for name in REQUIRED_VARS if not os.environ.get(name)]
    if missing:
        raise SystemExit(
            "Missing required environment variables: " + ", ".join(missing) + ".\n"
            "Strava credentials live in GitHub secrets; this script is meant to run "
            "from .github/workflows/sync-efforts.yml, not locally."
        )


# ── R2 ─────────────────────────────────────────────────────────────────────────

def get_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


def download_json(client, key: str, default):
    """Read one object out of R2, tolerating a first run."""
    try:
        response = client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
    except ClientError as error:
        if error.response["Error"]["Code"] in ("404", "NoSuchKey"):
            logger.info(f"No existing {key} in R2, starting fresh")
            return default
        raise
    return json.loads(response["Body"].read() or "null") or default


def upload_efforts(client, efforts: list[dict]) -> None:
    client.put_object(
        Bucket=R2_BUCKET_NAME,
        Key=EFFORTS_KEY,
        Body=json.dumps(efforts, default=str),
        ContentType="application/json",
        CacheControl="public, max-age=1800",
    )
    logger.info(f"Uploaded {len(efforts)} effort records to R2")


# ── Strava ─────────────────────────────────────────────────────────────────────

def get_access_token() -> str:
    body = urllib.parse.urlencode({
        "client_id": STRAVA_CLIENT_ID,
        "client_secret": STRAVA_CLIENT_SECRET,
        "refresh_token": STRAVA_REFRESH_TOKEN,
        "grant_type": "refresh_token",
    }).encode()
    request = urllib.request.Request(
        "https://www.strava.com/oauth/token", data=body, method="POST"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)

    new_refresh = data.get("refresh_token")
    if new_refresh and new_refresh != STRAVA_REFRESH_TOKEN:
        logger.warning(
            "Strava issued a new refresh token. Update the STRAVA_REFRESH_TOKEN secret."
        )
    return data["access_token"]


def parse_rate_limits(headers) -> dict[str, tuple[int, int]]:
    """Read usage and ceiling out of the response headers.

    Strava sends "used,used_daily" against "limit,limit_daily", and separate
    read-only counters on top of the overall ones. The published numbers have
    changed more than once, so they are taken from the response rather than
    hardcoded — the plan was written against 100/1000 and the app may well be on
    200/2000 now.
    """
    limits: dict[str, tuple[int, int]] = {}
    for name, usage_header, limit_header in (
        ("overall", "X-RateLimit-Usage", "X-RateLimit-Limit"),
        ("read", "X-ReadRateLimit-Usage", "X-ReadRateLimit-Limit"),
    ):
        usage, limit = headers.get(usage_header), headers.get(limit_header)
        if not usage or not limit:
            continue
        try:
            used = [int(x) for x in usage.split(",")]
            allowed = [int(x) for x in limit.split(",")]
        except ValueError:
            continue
        for scope, index in (("15min", 0), ("daily", 1)):
            if index < len(used) and index < len(allowed):
                limits[f"{name}_{scope}"] = (used[index], allowed[index])
    return limits


def limit_reached(limits: dict[str, tuple[int, int]]) -> str | None:
    """Name the first counter within RATE_LIMIT_MARGIN of its ceiling."""
    for name, (used, allowed) in limits.items():
        if allowed and used >= allowed - RATE_LIMIT_MARGIN:
            return f"{name} {used}/{allowed}"
    return None


def fetch_detail(token: str, activity_id: int):
    """One detailed activity. Returns (payload, rate limits) or (None, limits).

    A None payload means this id is not worth retrying — deleted, or not visible
    to the token. Anything that would be worth retrying raises instead, so the
    caller can stop the pass rather than mark the id done.
    """
    url = f"https://www.strava.com/api/v3/activities/{activity_id}?include_all_efforts=true"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response), parse_rate_limits(response.headers)
    except urllib.error.HTTPError as error:
        limits = parse_rate_limits(error.headers)
        detail = error.read().decode()[:300]
        if error.code == 403 and "Inactive" in detail:
            logger.error(
                "Strava rejected the request because the API application is marked "
                "Inactive. Reactivate it at https://www.strava.com/settings/api "
                "and re-run this workflow."
            )
            sys.exit(1)
        if error.code == 404:
            logger.warning(f"Activity {activity_id} not found; skipping")
            return None, limits
        if error.code == 429:
            raise RateLimited(limits) from error
        logger.error(f"Strava API error {error.code} on {activity_id}: {detail}")
        raise


class RateLimited(Exception):
    def __init__(self, limits: dict[str, tuple[int, int]]):
        super().__init__("Strava returned 429")
        self.limits = limits


# ── Distillation ───────────────────────────────────────────────────────────────

def effort_key(name: str) -> str:
    return EFFORT_KEYS.get(name.strip().lower(), name.strip().lower().replace(" ", "_"))


def distil_splits(detail: dict) -> list[dict]:
    """Per-mile splits, keeping heart rate alongside pace.

    A deliberate widening of what the plan specified (bare pace floats). Between
    runs, average pace and average HR correlate at -0.15 in this dataset, which
    is noise; within a single run they separate cleanly — 2026-09-03 ran its body
    at 9:44/mi and HR 136 and closed at 8:42/mi and HR 151. Per-mile HR is the
    smallest unit that shows that, and it costs no extra requests.
    """
    splits = []
    for split in detail.get("splits_standard") or []:
        distance = split.get("distance") or 0
        moving = split.get("moving_time") or 0
        miles = distance * METERS_TO_MILES
        splits.append({
            "n": split.get("split"),
            # Kept rather than derived so a short final split is not mistaken for
            # a fast one: 0.2 miles in 100 seconds is an 8:20 pace over a fifth
            # of a mile, and only the pace survives division.
            "mi": round(miles, 3),
            "s": round(moving),
            "pace": round(moving / 60 / miles, 2) if miles > 0 else None,
            "hr": round(split["average_heartrate"], 1) if split.get("average_heartrate") else None,
            "elev": round((split.get("elevation_difference") or 0) * METERS_TO_FEET, 1),
        })
    return splits


def distil(detail: dict) -> dict:
    """Reduce a detailed activity to the record that goes in efforts.json.

    Keyed by id and self-describing, so the merge is idempotent and a partial
    backfill is a valid file rather than a broken one.
    """
    best = {}
    for effort in detail.get("best_efforts") or []:
        name = effort.get("name")
        elapsed = effort.get("elapsed_time")
        if not name or not elapsed:
            continue
        best[effort_key(name)] = {
            "s": elapsed,
            "moving_s": effort.get("moving_time"),
            # Strava's own PR ranking. 1 means this run holds the athlete's best
            # at that distance, which is the cheapest possible sanity check on
            # anything gpx_efforts.py computes independently.
            "pr": effort.get("pr_rank"),
        }

    return {
        "id": detail["id"],
        "start_date_local": detail.get("start_date_local", ""),
        "workout_type": detail.get("workout_type") or 0,
        # The open question from step 1: average_cadence is 0 on all 1,181
        # summary records, and this is the endpoint that settles whether the
        # watch ever reported it. Stored either way so the answer is in the data.
        "average_cadence": detail.get("average_cadence") or 0,
        "device_name": detail.get("device_name") or "",
        "best": best,
        "splits": distil_splits(detail),
    }


# ── Selection ──────────────────────────────────────────────────────────────────

def select_ids(activities: list[dict], done: set[int], order: str, year: str | None,
               limit: int) -> list[int]:
    """Which activity ids to fetch this pass, in the order the plan argues for.

    Newest-first by default: zones.py weights candidates exp(-ageWeeks/4), so
    nothing outside roughly the last year can move a zone no matter how good it
    is. `--order oldest` and `--year 2021` serve the other goal in the plan —
    preservation of the 180 runs that exist in no other source — and should be
    reached for the moment cancelling the subscription becomes a live decision.
    """
    candidates = [
        a for a in activities
        if a.get("id") not in done
        and (year is None or (a.get("start_date_local") or a.get("start_date") or "").startswith(year))
    ]
    candidates.sort(
        key=lambda a: a.get("start_date_local") or a.get("start_date") or "",
        reverse=(order == "newest"),
    )
    return [a["id"] for a in candidates[:limit]]


def seconds_until_window_reset(now: datetime | None = None) -> int:
    """Strava's short window is aligned to the quarter hour, not to first use."""
    now = now or datetime.now(timezone.utc)
    minutes_past = now.minute % 15
    seconds = (15 - minutes_past) * 60 - now.second
    return max(seconds, 0) + 15  # a little past the boundary, for clock skew


# ── Main ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--per-window", type=int, default=DEFAULT_PER_WINDOW,
                        help="Requests per 15-minute window (default %(default)s).")
    parser.add_argument("--windows", type=int, default=1,
                        help="How many 15-minute windows to work through, sleeping "
                             "between them. 1 (the default) does a single pass and "
                             "exits; a larger number drains more of the daily budget "
                             "in one job. Every window uploads before sleeping, so "
                             "stopping early never loses work.")
    parser.add_argument("--order", choices=["newest", "oldest"], default="newest",
                        help="Which end of the history to work from (default newest, "
                             "which is what the zone engine reads).")
    parser.add_argument("--year", default=None,
                        help="Restrict to one year, e.g. 2021 — the 180 runs that "
                             "exist in no other source.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    check_env()

    r2 = get_r2_client()
    activities = download_json(r2, ACTIVITIES_KEY, [])
    efforts = download_json(r2, EFFORTS_KEY, [])
    if not activities:
        raise SystemExit(f"{ACTIVITIES_KEY} is empty or missing; run sync_strava.py first.")

    by_id = {record["id"]: record for record in efforts}
    logger.info(
        f"{len(activities)} activities known, {len(by_id)} already distilled, "
        f"{len(activities) - len(by_id)} remaining"
    )

    token = get_access_token()
    fetched_total = 0

    for window in range(1, args.windows + 1):
        ids = select_ids(activities, set(by_id), args.order, args.year, args.per_window)
        if not ids:
            logger.info("Nothing left to fetch; efforts.json is complete for this selection")
            break

        logger.info(f"Window {window}/{args.windows}: fetching {len(ids)} activities")
        fetched_here = 0
        stopped = None

        for activity_id in ids:
            try:
                detail, limits = fetch_detail(token, activity_id)
            except RateLimited as limited:
                stopped = limit_reached(limited.limits) or "429, no counters reported"
                break

            if detail is not None:
                by_id[detail["id"]] = distil(detail)
                fetched_here += 1

            stopped = limit_reached(limits)
            if stopped:
                break

        fetched_total += fetched_here
        if fetched_here:
            # Upload every window rather than once at the end: a job killed at
            # hour two of a long backfill should keep everything before it.
            upload_efforts(r2, sorted(by_id.values(),
                                      key=lambda r: r.get("start_date_local", ""), reverse=True))
        logger.info(f"Window {window}: {fetched_here} fetched"
                    + (f", stopped on rate limit {stopped}" if stopped else ""))

        remaining = len(activities) - len(by_id)
        if remaining <= 0 or window >= args.windows:
            break
        # The 15-minute counter refills on the quarter hour; the daily one does
        # not refill until midnight UTC. Sleeping through the rest of the
        # windows would spend hours of job time to make no further requests.
        if stopped and "daily" in stopped:
            logger.info(
                f"Daily budget spent ({stopped}); {remaining} activities remain. "
                "Re-run after midnight UTC — the pass resumes where it stopped."
            )
            break
        sleep_for = seconds_until_window_reset()
        logger.info(f"{remaining} remaining; sleeping {sleep_for}s for the next window")
        time.sleep(sleep_for)

    with_cadence = sum(1 for r in by_id.values() if r.get("average_cadence"))
    logger.info(
        f"Done. {fetched_total} fetched this run, {len(by_id)} distilled in total, "
        f"{len(activities) - len(by_id)} remaining. "
        f"average_cadence present on {with_cadence}/{len(by_id)}."
    )


if __name__ == "__main__":
    main()
