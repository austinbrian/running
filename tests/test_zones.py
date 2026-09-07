"""Tests for zone derivation and at-a-glance target state.

The important ones here are the refusals. Producing a plausible-looking pace
table from inadequate data is the failure mode that matters, because nothing
downstream can tell an invented zone from a derived one.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from zones import derive, find_anchor, state_for  # noqa: E402


def run(date: str, miles: float, minutes: float, hr: float | None = None) -> dict:
    r = {"start_date": f"{date}T12:00:00Z", "distance_miles": miles,
         "moving_time_minutes": minutes}
    if hr is not None:
        r["average_heartrate"] = hr
    return r


def easy_log(n: int = 40, pace: float = 9.5, hr: float = 142) -> list[dict]:
    """A log of nothing but easy running — the realistic case."""
    return [run(f"2026-0{6 + i % 3}-{1 + i % 28:02d}", 5.0, 5.0 * pace, hr + (i % 5))
            for i in range(n)]


TODAY = "2026-08-25"


class TestEasyZones(unittest.TestCase):
    def test_easy_zones_derive_from_ordinary_running(self):
        z = derive(easy_log(), TODAY)
        self.assertTrue(z["easy"]["confident"])
        self.assertTrue(z["long_run"]["confident"])
        # Long runs are run slower than easy runs, so a higher seconds-per-mile.
        self.assertGreaterEqual(z["long_run"]["high_s"], z["easy"]["high_s"])

    def test_too_few_runs_leaves_easy_unset(self):
        z = derive(easy_log(n=5), TODAY)
        self.assertFalse(z["easy"]["confident"])
        self.assertIsNone(z["easy"]["low_s"])
        self.assertIn("qualifying runs", z["easy"]["source"])

    def test_heart_rate_artifacts_do_not_reach_the_anchor_search(self):
        # A 35bpm dropout and a 207bpm cadence-lock spike are not heart rates.
        log = easy_log() + [run("2026-08-01", 5, 47, 35), run("2026-08-02", 5, 47, 207)]
        self.assertIsNone(find_anchor(log, TODAY))


class TestAnchorRefusal(unittest.TestCase):
    def test_no_anchor_when_every_run_is_the_same_effort(self):
        z = derive(easy_log(), TODAY)
        for name in ("tempo_interval", "cruise_interval", "5k_10k", "half_marathon"):
            with self.subTest(zone=name):
                self.assertFalse(z[name]["confident"])
                self.assertIn("no hard effort", z[name]["source"])

    def test_high_hr_at_slow_pace_is_not_an_anchor(self):
        """Regression: a hot-day run had high HR at a slow pace, and produced a
        'tempo' zone slower than easy pace before this was caught."""
        log = easy_log() + [run("2026-08-10", 3.8, 36, 167)]   # 9:28/mi, high HR
        self.assertIsNone(find_anchor(log, TODAY))

    def test_derived_threshold_is_never_slower_than_easy(self):
        log = easy_log() + [run("2026-08-10", 3.8, 36, 167)]
        z = derive(log, TODAY)
        self.assertFalse(z["tempo_interval"]["confident"])

    def test_a_genuinely_hard_effort_is_accepted(self):
        # Fast *and* hard: well under easy pace, well above usual HR.
        log = easy_log() + [run("2026-08-10", 4.0, 30, 175)]   # 7:30/mi
        anchor = find_anchor(log, TODAY)
        self.assertIsNotNone(anchor)

        z = derive(log, TODAY)
        self.assertTrue(z["tempo_interval"]["confident"])
        # The whole point: threshold work must be faster than easy running.
        self.assertLess(z["tempo_interval"]["high_s"], z["easy"]["low_s"])
        self.assertLess(z["5k_10k"]["low_s"], z["tempo_interval"]["low_s"])


class TestGoalZone(unittest.TestCase):
    def test_goal_is_unset_until_you_set_it(self):
        self.assertFalse(derive(easy_log(), TODAY)["goal"]["confident"])

    def test_goal_brackets_the_pace_you_give_it(self):
        z = derive(easy_log(), TODAY, goal_pace_s=9 * 60 + 35)
        self.assertLess(z["goal"]["low_s"], 575)
        self.assertGreater(z["goal"]["high_s"], 575)


class TestGlanceableState(unittest.TestCase):
    ZONE = {"name": "easy", "low_s": 560.0, "high_s": 590.0,
            "source": "test", "confident": True}

    def test_reports_fast_slow_and_on(self):
        self.assertEqual(state_for(540, self.ZONE), "fast")
        self.assertEqual(state_for(575, self.ZONE), "on")
        self.assertEqual(state_for(620, self.ZONE), "slow")

    def test_unset_zone_gives_unknown_not_a_verdict(self):
        blank = {**self.ZONE, "low_s": None, "high_s": None, "confident": False}
        self.assertEqual(state_for(575, blank), "unknown")
        self.assertEqual(state_for(None, self.ZONE), "unknown")

    def test_hysteresis_holds_on_target_through_gps_noise(self):
        # 594s/mi is just outside the band. Arriving fresh it reads slow; while
        # already on target it holds, so the indicator does not strobe.
        self.assertEqual(state_for(594, self.ZONE, previous="fast"), "slow")
        self.assertEqual(state_for(594, self.ZONE, previous="on"), "on")

    def test_hysteresis_still_lets_you_genuinely_lose_the_zone(self):
        self.assertEqual(state_for(650, self.ZONE, previous="on"), "slow")


if __name__ == "__main__":
    unittest.main(verbosity=2)


# ── Best efforts as anchors ────────────────────────────────────────────────────

from zones import (  # noqa: E402
    ANCHOR_MIN_WEIGHT, age_weeks, anchor_from_efforts, recency_weight,
)


def effort(date: str, best: dict, workout_type: int = 0) -> dict:
    """One efforts.json record. `best` maps distance key to elapsed seconds."""
    return {
        "id": abs(hash(date + str(best))) % 10**9,
        "start_date_local": f"{date}T06:00:00Z",
        "workout_type": workout_type,
        "best": {key: {"s": secs, "moving_s": secs, "pr": None}
                 for key, secs in best.items()},
        "splits": [],
    }


class TestEffortAnchor(unittest.TestCase):
    def test_a_fast_mile_inside_an_easy_run_becomes_the_anchor(self):
        """The whole point.

        A log of nothing but easy running yields no anchor from whole-run
        averages, and should not — but a 7:58 mile inside one of those runs is a
        maximal segment, and it is the thing the quality zones need.
        """
        efforts = [effort("2026-08-20", {"1mi": 478})]
        self.assertIsNone(find_anchor(easy_log(), TODAY))
        anchor = find_anchor(easy_log(), TODAY, efforts=efforts)
        self.assertIsNotNone(anchor)
        self.assertEqual(anchor["effort"], "1mi")

    def test_quality_zones_come_back_set(self):
        z = derive(easy_log(), TODAY, efforts=[effort("2026-08-20", {"1mi": 478})])
        for name in ("half_marathon", "tempo_interval", "cruise_interval", "5k_10k"):
            self.assertTrue(z[name]["confident"], f"{name} should be set")
        # Every quality zone must be faster than the easy band it sits above.
        self.assertLess(z["tempo_interval"]["high_s"], z["easy"]["low_s"])
        self.assertLess(z["5k_10k"]["low_s"], z["tempo_interval"]["low_s"])

    def test_the_source_names_the_effort_it_came_from(self):
        z = derive(easy_log(), TODAY, efforts=[effort("2026-08-20", {"1mi": 478})])
        self.assertIn("1mi", z["tempo_interval"]["source"])
        self.assertIn("2026-08-20", z["tempo_interval"]["source"])

    def test_a_stale_effort_is_refused(self):
        """A performance from a year ago is a fact about a different runner."""
        self.assertIsNone(anchor_from_efforts([effort("2025-08-20", {"1mi": 400})], TODAY))

    def test_a_stale_effort_does_not_beat_a_fresh_slower_one(self):
        anchor = anchor_from_efforts([
            effort("2025-08-20", {"1mi": 400}),   # much faster, far too old
            effort("2026-08-20", {"1mi": 478}),
        ], TODAY)
        self.assertEqual(anchor["start_date"][:10], "2026-08-20")

    def test_a_race_outranks_a_faster_ordinary_segment(self):
        """Trust before speed.

        A flagged race is maximal by definition; a fast segment inside a
        training run is someone who happened to push for a mile.
        """
        anchor = anchor_from_efforts([
            effort("2026-08-19", {"5k": 1500}),                    # fast, untagged
            effort("2026-08-20", {"5k": 1560}, workout_type=1),    # slower, a race
        ], TODAY)
        self.assertEqual(anchor["trust"], 0)
        self.assertEqual(anchor["start_date"][:10], "2026-08-20")

    def test_the_fastest_wins_among_equal_trust(self):
        anchor = anchor_from_efforts([
            effort("2026-08-19", {"5k": 1600}),
            effort("2026-08-20", {"5k": 1500}),
        ], TODAY)
        self.assertEqual(anchor["start_date"][:10], "2026-08-20")

    def test_efforts_shorter_than_a_mile_are_ignored(self):
        """Riegel from 400m to a half marathon is not extrapolation, it is fiction."""
        self.assertIsNone(anchor_from_efforts(
            [effort("2026-08-20", {"400m": 96, "half_mile": 220, "1k": 280})], TODAY))

    def test_an_effort_under_the_duration_floor_is_ignored(self):
        # A 1-mile "effort" of 200s is 3:20/mi — a GPS artifact, not a run.
        self.assertIsNone(anchor_from_efforts([effort("2026-08-20", {"1mi": 200})], TODAY))

    def test_an_anchor_slower_than_easy_pace_is_still_discarded(self):
        """The last line of defence in derive() still has the final word.

        A "best" mile at 10:00 inside a log of 9:30 running is not an effort,
        however maximal the segment technically was.
        """
        z = derive(easy_log(), TODAY, efforts=[effort("2026-08-20", {"1mi": 600})])
        self.assertFalse(z["tempo_interval"]["confident"])
        self.assertIn("no hard effort", z["tempo_interval"]["source"])

    def test_no_efforts_falls_back_to_the_heart_rate_heuristic(self):
        log = easy_log() + [run("2026-08-24", 5, 39, 178)]
        self.assertIsNotNone(find_anchor(log, TODAY))
        self.assertIsNotNone(find_anchor(log, TODAY, efforts=[]))

    def test_records_with_no_efforts_are_skipped_not_crashed_on(self):
        self.assertIsNone(anchor_from_efforts([
            {"id": 1, "start_date_local": "2026-08-20T06:00:00Z"},
            {"id": 2, "best": {}},
            effort("2026-08-20", {}),
        ], TODAY))

    def test_an_empty_list_is_not_an_anchor(self):
        self.assertIsNone(anchor_from_efforts([], TODAY))


class TestRecency(unittest.TestCase):
    def test_age_in_weeks(self):
        self.assertEqual(age_weeks("2026-08-18", "2026-08-25"), 1.0)
        self.assertEqual(age_weeks("2026-08-25", "2026-08-25"), 0.0)

    def test_a_future_date_clamps_to_zero_rather_than_going_negative(self):
        # A negative age would weight above 1 and let tomorrow outrank today.
        self.assertEqual(age_weeks("2026-09-01", "2026-08-25"), 0.0)
        self.assertEqual(recency_weight("2026-09-01", "2026-08-25"), 1.0)

    def test_the_weight_floor_lands_at_83_days(self):
        # 4*ln(20) = 11.98 weeks. Pinned exactly, because "about twelve weeks"
        # is off by a day and the boundary is what decides whether the last
        # good effort of a training block still counts.
        self.assertGreater(recency_weight("2026-06-03", "2026-08-25"), ANCHOR_MIN_WEIGHT)
        self.assertLess(recency_weight("2026-06-02", "2026-08-25"), ANCHOR_MIN_WEIGHT)

    def test_the_2021_half_weights_to_nothing(self):
        self.assertLess(recency_weight("2021-10-17", "2026-08-25"), 1e-20)


class TestThresholdMargin(unittest.TestCase):
    """The guard that decides whether a marginal anchor ships.

    A compressed log produces candidates that are barely faster than easy pace.
    Accepting one publishes a tempo band sitting on top of the easy band, which
    reads as a real prescription and is not one.
    """

    def test_an_anchor_barely_faster_than_easy_is_refused(self):
        # easy p25 here is 9:30/mi = 570s. A 5K implying 9:23/mi clears a bare
        # ">= easy" check by seven seconds and is still not a hard effort.
        log = easy_log(pace=9.5)
        z = derive(log, TODAY, efforts=[effort("2026-08-20", {"5k": 1745})])
        self.assertFalse(z["tempo_interval"]["confident"])

    def test_an_anchor_clearly_faster_than_easy_is_accepted(self):
        z = derive(easy_log(pace=9.5), TODAY, efforts=[effort("2026-08-20", {"5k": 1550})])
        self.assertTrue(z["tempo_interval"]["confident"])

    def test_the_margin_applies_to_the_bands_fast_end(self):
        """What the guard actually promises.

        It tests the implied 10K pace, which is `tempo_interval.low_s`. The
        slow end of the band is half-marathon pace and is legitimately closer
        to easy running — requiring the whole band to clear by 5% would reject
        anchors that are perfectly good.
        """
        z = derive(easy_log(pace=9.5), TODAY, efforts=[effort("2026-08-20", {"5k": 1550})])
        self.assertLess(z["tempo_interval"]["low_s"], z["easy"]["low_s"] * 0.95)

    def test_the_accepted_band_does_not_overlap_easy(self):
        z = derive(easy_log(pace=9.5), TODAY, efforts=[effort("2026-08-20", {"5k": 1550})])
        self.assertLess(z["tempo_interval"]["high_s"], z["easy"]["low_s"])
