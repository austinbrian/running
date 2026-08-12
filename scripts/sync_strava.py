"""Sync Strava running activities into data/activities.json.

Reads the committed JSON, fetches anything newer from the Strava API, merges and
deduplicates by activity id, then writes the file back. The workflow commits the
result, and GitHub Pages serves it same-origin to the dashboard.

Uses only the standard library so the workflow needs no dependency install.
"""

import json
import logging
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

STRAVA_CLIENT_ID = os.environ["STRAVA_CLIENT_ID"]
STRAVA_CLIENT_SECRET = os.environ["STRAVA_CLIENT_SECRET"]
STRAVA_REFRESH_TOKEN = os.environ["STRAVA_REFRESH_TOKEN"]

DATA_PATH = pathlib.Path(__file__).resolve().parent.parent / "data" / "activities.json"

METERS_TO_MILES = 0.000621371
METERS_TO_FEET = 3.28084

ACTIVITY_FIELDS = [
    "id", "name", "type", "distance", "moving_time", "elapsed_time",
    "total_elevation_gain", "start_date", "average_speed", "max_speed",
    "average_cadence", "average_heartrate", "max_heartrate",
]


def read_existing() -> list[dict]:
    """Read the committed activities file, tolerating a missing or empty file."""
    if not DATA_PATH.exists():
        logger.info("No existing activities file, starting fresh")
        return []
    try:
        data = json.loads(DATA_PATH.read_text() or "[]")
    except json.JSONDecodeError:
        logger.warning("activities.json is not valid JSON, starting fresh")
        return []
    logger.info(f"Read {len(data)} existing activities")
    return data


def write_activities(activities: list[dict]) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(activities, indent=1, default=str) + "\n")
    logger.info(f"Wrote {len(activities)} activities to {DATA_PATH}")


def get_access_token() -> str:
    """Exchange the refresh token for a fresh access token."""
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


def fetch_activities(token: str, after: int | None = None) -> list[dict]:
    """Fetch activities from Strava, following pagination."""
    all_activities: list[dict] = []
    page = 1
    per_page = 200

    while True:
        params = {"per_page": per_page, "page": page}
        if after:
            params["after"] = after
        url = f"https://www.strava.com/api/v3/athlete/activities?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                activities = json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode()[:300]
            if error.code == 403 and "Inactive" in detail:
                logger.error(
                    "Strava rejected the request because the API application is marked "
                    "Inactive. Reactivate it at https://www.strava.com/settings/api "
                    "and re-run this workflow."
                )
                sys.exit(1)
            logger.error(f"Strava API error {error.code}: {detail}")
            raise

        if not activities:
            break

        for activity in activities:
            processed = {field: activity.get(field, 0) for field in ACTIVITY_FIELDS}
            processed["id"] = activity["id"]
            processed["name"] = activity.get("name", "")
            processed["type"] = activity.get("type", "")
            processed["start_date"] = activity.get("start_date", "")
            all_activities.append(processed)

        page += 1
        if len(activities) < per_page:
            break

    logger.info(f"Fetched {len(all_activities)} activities from Strava")
    return all_activities


def enrich_activity(activity: dict) -> dict:
    """Add the derived fields the dashboard charts read."""
    distance_miles = activity["distance"] * METERS_TO_MILES
    moving_time_minutes = activity["moving_time"] / 60
    elevation_feet = activity["total_elevation_gain"] * METERS_TO_FEET
    pace = moving_time_minutes / distance_miles if distance_miles > 0 else 0

    return {
        **activity,
        "distance_miles": round(distance_miles, 4),
        "moving_time_minutes": round(moving_time_minutes, 2),
        "elevation_feet": round(elevation_feet, 1),
        "pace": round(pace, 2),
    }


def get_latest_timestamp(activities: list[dict]) -> int | None:
    """Unix timestamp of the most recent activity, for incremental fetches."""
    dates = []
    for activity in activities:
        try:
            parsed = datetime.fromisoformat(activity["start_date"].replace("Z", "+00:00"))
            dates.append(int(parsed.timestamp()))
        except (ValueError, KeyError, AttributeError):
            continue
    return max(dates) if dates else None


def main() -> None:
    existing = read_existing()
    after = get_latest_timestamp(existing)
    if after:
        logger.info(f"Fetching activities after timestamp {after}")

    token = get_access_token()
    fetched = fetch_activities(token, after=after)

    runs = [a for a in fetched if a.get("type") == "Run"]
    logger.info(f"Found {len(runs)} runs out of {len(fetched)} activities")

    fetched_ids = {a["id"] for a in runs}
    merged = [a for a in existing if a["id"] not in fetched_ids]
    merged.extend(enrich_activity(a) for a in runs)

    # Backfill derived fields on anything written before they existed.
    merged = [a if "distance_miles" in a else enrich_activity(a) for a in merged]
    merged.sort(key=lambda a: a.get("start_date", ""), reverse=True)

    logger.info(f"Total: {len(merged)} runs ({len(merged) - len(existing)} new)")
    write_activities(merged)
    logger.info("Sync complete")


if __name__ == "__main__":
    main()
