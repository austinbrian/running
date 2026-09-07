"""Tests for the best-efforts extraction.

Three things carry risk here and none of them are the HTTP call.

The first is the merge: a backfill runs across days and gets interrupted, so
select_ids() has to skip what is done and order what is left the way the plan
argues for, or the anchor arrives after the deadline it exists to serve.

The second is the rate limit. Strava reports it per response and the published
numbers have changed, so the counters are read rather than assumed — and a
misread that fails open burns a window into 429s.

The third is distillation, where the failure is silent: a short final split
divided into its own time reads as the fastest split of the run.
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from sync_efforts import (  # noqa: E402
    distil, distil_splits, effort_key, limit_reached, parse_rate_limits,
    seconds_until_window_reset, select_ids,
)


def activity(id_, date):
    return {"id": id_, "start_date_local": date, "start_date": date}


DETAIL = {
    "id": 20018448225,
    "start_date_local": "2026-09-03T06:11:45Z",
    "workout_type": 3,
    "average_cadence": 82.4,
    "device_name": "Apple Watch",
    "best_efforts": [
        {"name": "400m", "elapsed_time": 96, "moving_time": 96, "pr_rank": None},
        {"name": "1 mile", "elapsed_time": 478, "moving_time": 476, "pr_rank": 1},
        {"name": "5k", "elapsed_time": 1549, "moving_time": 1540, "pr_rank": 2},
    ],
    "splits_standard": [
        {"split": 1, "distance": 1609.3, "moving_time": 584,
         "average_heartrate": 136.0, "elevation_difference": 12.0},
        {"split": 2, "distance": 1609.3, "moving_time": 561,
         "average_heartrate": 151.0, "elevation_difference": -8.0},
    ],
}


class TestEffortKeys(unittest.TestCase):
    def test_strava_labels_map_to_short_keys(self):
        self.assertEqual(effort_key("1/2 mile"), "half_mile")
        self.assertEqual(effort_key("Half-Marathon"), "half")
        self.assertEqual(effort_key("1 mile"), "1mi")

    def test_an_unknown_label_is_kept_not_dropped(self):
        # A label change should show up in the data, not vanish from it.
        self.assertEqual(effort_key("30k"), "30k")
        self.assertEqual(effort_key("Some New Distance"), "some_new_distance")


class TestDistil(unittest.TestCase):
    def test_best_efforts_are_keyed_by_distance(self):
        record = distil(DETAIL)
        self.assertEqual(set(record["best"]), {"400m", "1mi", "5k"})
        self.assertEqual(record["best"]["1mi"]["s"], 478)
        self.assertEqual(record["best"]["1mi"]["pr"], 1)

    def test_an_effort_without_a_time_is_skipped(self):
        detail = {**DETAIL, "best_efforts": [{"name": "1 mile", "elapsed_time": None}]}
        self.assertEqual(distil(detail)["best"], {})

    def test_cadence_is_carried_through(self):
        # The open question from step 1: zero on every summary record, and this
        # endpoint is what settles whether the watch ever reported it.
        self.assertEqual(distil(DETAIL)["average_cadence"], 82.4)

    def test_missing_cadence_is_zero_not_none(self):
        detail = dict(DETAIL)
        del detail["average_cadence"]
        self.assertEqual(distil(detail)["average_cadence"], 0)

    def test_an_activity_with_no_efforts_still_distils(self):
        record = distil({"id": 1, "start_date_local": "2026-01-01T00:00:00Z"})
        self.assertEqual(record["best"], {})
        self.assertEqual(record["splits"], [])
        self.assertEqual(record["id"], 1)

    def test_workout_type_null_becomes_zero(self):
        # Strava sends an explicit null for an ordinary run.
        self.assertEqual(distil({**DETAIL, "workout_type": None})["workout_type"], 0)


class TestSplits(unittest.TestCase):
    def test_pace_and_heart_rate_survive_together(self):
        splits = distil_splits(DETAIL)
        self.assertEqual(len(splits), 2)
        self.assertAlmostEqual(splits[0]["pace"], 9.73, places=1)
        self.assertEqual(splits[0]["hr"], 136.0)
        self.assertEqual(splits[1]["hr"], 151.0)

    def test_a_short_final_split_keeps_its_distance(self):
        """The silent failure this guards against.

        Strava's last split is whatever is left over. Its pace is correct, but
        without the distance beside it there is no way to know it covered a
        fifth of a mile, and a partial split reads like a full one.
        """
        detail = {"id": 1, "splits_standard": [
            {"split": 1, "distance": 322, "moving_time": 100, "average_heartrate": 150},
        ]}
        split = distil_splits(detail)[0]
        self.assertAlmostEqual(split["mi"], 0.2, places=2)
        self.assertEqual(split["s"], 100)
        self.assertAlmostEqual(split["pace"], 8.33, places=1)

    def test_a_split_without_heart_rate_is_none_not_zero(self):
        # A 0 would drag any average over splits toward zero.
        detail = {"id": 1, "splits_standard": [
            {"split": 1, "distance": 1609.3, "moving_time": 584},
        ]}
        self.assertIsNone(distil_splits(detail)[0]["hr"])

    def test_a_zero_distance_split_does_not_divide_by_zero(self):
        detail = {"id": 1, "splits_standard": [
            {"split": 1, "distance": 0, "moving_time": 10},
        ]}
        self.assertIsNone(distil_splits(detail)[0]["pace"])


class TestSelection(unittest.TestCase):
    def setUp(self):
        self.activities = [
            activity(1, "2021-05-01T08:00:00Z"),
            activity(2, "2026-08-01T08:00:00Z"),
            activity(3, "2026-09-01T08:00:00Z"),
            activity(4, "2019-01-01T08:00:00Z"),
        ]

    def test_newest_first_by_default(self):
        self.assertEqual(select_ids(self.activities, set(), "newest", None, 10), [3, 2, 1, 4])

    def test_oldest_first_when_asked(self):
        self.assertEqual(select_ids(self.activities, set(), "oldest", None, 10), [4, 1, 2, 3])

    def test_already_distilled_ids_are_skipped(self):
        """What makes the backfill resumable with no cursor to persist."""
        self.assertEqual(select_ids(self.activities, {3, 2}, "newest", None, 10), [1, 4])

    def test_the_limit_is_a_ceiling_on_the_pass(self):
        self.assertEqual(select_ids(self.activities, set(), "newest", None, 2), [3, 2])

    def test_a_year_filter_isolates_the_irreplaceable_runs(self):
        self.assertEqual(select_ids(self.activities, set(), "newest", "2021", 10), [1])

    def test_nothing_left_returns_empty_rather_than_raising(self):
        self.assertEqual(select_ids(self.activities, {1, 2, 3, 4}, "newest", None, 10), [])

    def test_a_record_with_no_date_still_sorts(self):
        # Older syncs are not guaranteed to have written start_date_local.
        acts = self.activities + [{"id": 5}]
        self.assertIn(5, select_ids(acts, set(), "newest", None, 10))


class TestRateLimits(unittest.TestCase):
    def test_both_scopes_are_read(self):
        limits = parse_rate_limits({
            "X-RateLimit-Usage": "45,150", "X-RateLimit-Limit": "200,2000",
            "X-ReadRateLimit-Usage": "40,120", "X-ReadRateLimit-Limit": "100,1000",
        })
        self.assertEqual(limits["overall_15min"], (45, 200))
        self.assertEqual(limits["overall_daily"], (150, 2000))
        self.assertEqual(limits["read_15min"], (40, 100))

    def test_absent_headers_yield_no_counters(self):
        self.assertEqual(parse_rate_limits({}), {})

    def test_malformed_headers_are_ignored_rather_than_raising(self):
        self.assertEqual(parse_rate_limits({
            "X-RateLimit-Usage": "not,numbers", "X-RateLimit-Limit": "200,2000",
        }), {})

    def test_the_read_limit_binds_before_the_overall_one(self):
        """The case that matters: plenty of overall budget, no read budget."""
        limits = parse_rate_limits({
            "X-RateLimit-Usage": "45,150", "X-RateLimit-Limit": "200,2000",
            "X-ReadRateLimit-Usage": "95,120", "X-ReadRateLimit-Limit": "100,1000",
        })
        self.assertIn("read_15min", limit_reached(limits))

    def test_room_left_reports_nothing_reached(self):
        self.assertIsNone(limit_reached({"overall_15min": (45, 200)}))

    def test_a_zero_limit_is_not_treated_as_reached(self):
        # An unparsed or absent ceiling must not stop the pass on its own.
        self.assertIsNone(limit_reached({"overall_15min": (0, 0)}))


class TestWindowReset(unittest.TestCase):
    def test_sleeps_to_the_next_quarter_hour(self):
        """Strava's window is aligned to the clock, not to first use.

        Sleeping a flat 15 minutes from the moment the limit is hit wastes up to
        a whole window; sleeping to the boundary does not.
        """
        at = datetime(2026, 9, 7, 12, 3, 30, tzinfo=timezone.utc)
        self.assertEqual(seconds_until_window_reset(at), (15 - 3) * 60 - 30 + 15)

    def test_on_the_boundary_waits_a_full_window(self):
        at = datetime(2026, 9, 7, 12, 15, 0, tzinfo=timezone.utc)
        self.assertEqual(seconds_until_window_reset(at), 15 * 60 + 15)

    def test_never_returns_a_negative_sleep(self):
        for minute in range(60):
            at = datetime(2026, 9, 7, 12, minute, 59, tzinfo=timezone.utc)
            self.assertGreater(seconds_until_window_reset(at), 0)


if __name__ == "__main__":
    unittest.main()
