"""Derive pace zones from R2 and publish them back as zones.json.

The site and the watch app need the same zones, and the way they get them is
one implementation with two readers rather than two implementations that drift.
`zones.py` is that implementation; this is the step that runs it.

Deliberately publishes the refusals too. `zones.py` says "not set" and why when
the evidence for a zone does not exist, and that has to survive to the page
verbatim. A visibly missing tempo pace is a prompt to run a time trial; a
quietly guessed one is how you get hurt.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

sys.path.insert(0, str(Path(__file__).parent))
import zones as zone_engine  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

REQUIRED_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME") or "strava-data"

ACTIVITIES_KEY = "activities.json"
EFFORTS_KEY = "efforts.json"
ZONES_KEY = "zones.json"

# Distances the page shows a predicted time for.
PREDICTIONS = {"5k": 3.107, "10k": 6.214, "half": 13.109}


def get_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


def download_json(client, key: str, default):
    try:
        response = client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
    except ClientError as error:
        if error.response["Error"]["Code"] in ("404", "NoSuchKey"):
            logger.info(f"No {key} in R2 yet")
            return default
        raise
    return json.loads(response["Body"].read() or "null") or default


def predictions_from(anchor: dict | None) -> dict:
    """Race-time predictions, or nothing at all.

    Nothing, rather than a projection off average training pace: the field this
    replaces multiplied total minutes over total miles by 13.1, weighting every
    easy shakeout equally with every long run and applying no distance decay,
    and it read as a real prediction on the page.
    """
    if not anchor:
        return {}
    miles = anchor["distance_miles"]
    seconds = anchor["moving_time_minutes"] * 60
    return {
        name: round(zone_engine.riegel(miles, seconds, target) * target)
        for name, target in PREDICTIONS.items()
    }


def build(activities: list[dict], efforts: list[dict], today: str) -> dict:
    """The published document. Pure, so the shape is testable without network."""
    zones = zone_engine.derive(activities, today, efforts=efforts)
    anchor = zone_engine.find_anchor(activities, today, efforts=efforts)

    # derive() applies one check find_anchor() does not — that the implied
    # threshold pace is faster than easy pace — and discards the anchor if it
    # fails. Publishing an anchor the zones were not actually built from would
    # misattribute them, so trust the zones and drop it.
    if anchor and not zones.get("tempo_interval", {}).get("confident"):
        anchor = None

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "today": today,
        "counts": {
            "activities": len(activities),
            "efforts": len(efforts),
        },
        "anchor": anchor and {
            "date": anchor["start_date"][:10],
            "effort": anchor.get("effort", "whole run"),
            "distance_miles": round(anchor["distance_miles"], 3),
            "seconds": round(anchor["moving_time_minutes"] * 60),
            "pace_s": round(anchor["moving_time_minutes"] * 60 / anchor["distance_miles"]),
            "weight": anchor.get("weight"),
            "age_weeks": round(zone_engine.age_weeks(anchor["start_date"][:10], today), 1),
        },
        "zones": zones,
        "predicted_s": predictions_from(anchor),
        # None when there is not enough history to fit. The page has to be able
        # to render without it, and to say so rather than adjusting by nothing
        # and calling the result adjusted.
        "grade": zone_engine.fit_grade_adjustment(activities, today),
    }


def upload(client, document: dict) -> None:
    client.put_object(
        Bucket=R2_BUCKET_NAME,
        Key=ZONES_KEY,
        Body=json.dumps(document, indent=2, default=str),
        ContentType="application/json",
        CacheControl="public, max-age=1800",
    )
    logger.info(f"Uploaded {ZONES_KEY}")


def summarise(document: dict) -> str:
    anchor = document["anchor"]
    head = (f"anchor: {anchor['effort']} on {anchor['date']}, "
            f"{zone_engine.fmt_pace(anchor['pace_s'])}, {anchor['age_weeks']}w old"
            if anchor else
            "anchor: none — quality zones stay unset, which is the correct answer")
    return head + "\n" + zone_engine.report(document["zones"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Derive and print, but do not write to R2.")
    parser.add_argument("--today", default=None,
                        help="Override the reference date, for checking how the "
                             "zones would have read on a past day.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    missing = [name for name in REQUIRED_VARS if not os.environ.get(name)]
    if missing:
        raise SystemExit("Missing required environment variables: " + ", ".join(missing))

    r2 = get_r2_client()
    activities = download_json(r2, ACTIVITIES_KEY, [])
    efforts = download_json(r2, EFFORTS_KEY, [])
    if not activities:
        raise SystemExit(f"{ACTIVITIES_KEY} is empty or missing; run sync_strava.py first.")

    today = args.today or datetime.now(timezone.utc).date().isoformat()
    document = build(activities, efforts, today)

    logger.info(f"{len(activities)} activities, {len(efforts)} efforts distilled")
    print(summarise(document))

    if args.dry_run:
        logger.info("Dry run; nothing written")
        return
    upload(r2, document)


if __name__ == "__main__":
    main()
