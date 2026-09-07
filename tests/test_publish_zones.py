"""Tests for the published zones document.

The risk here is not the arithmetic, which zones.py already covers. It is that
a refusal turns into a number somewhere between derivation and the page — an
anchor attributed to zones that were not built from it, or a race prediction
projected off nothing at all. Both would render as confident.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from publish_zones import build, predictions_from, summarise  # noqa: E402

TODAY = "2026-08-25"


def run(date: str, miles: float, minutes: float, hr: float | None = None) -> dict:
    r = {"start_date": f"{date}T12:00:00Z", "distance_miles": miles,
         "moving_time_minutes": minutes}
    if hr is not None:
        r["average_heartrate"] = hr
    return r


def easy_log(n: int = 40, pace: float = 9.5, hr: float = 142) -> list[dict]:
    return [run(f"2026-0{6 + i % 3}-{1 + i % 28:02d}", 5.0, 5.0 * pace, hr + (i % 5))
            for i in range(n)]


def effort(date: str, best: dict, workout_type: int = 0) -> dict:
    return {"id": 1, "start_date_local": f"{date}T06:00:00Z",
            "workout_type": workout_type,
            "best": {k: {"s": s, "moving_s": s, "pr": None} for k, s in best.items()},
            "splits": []}


class TestDocument(unittest.TestCase):
    def test_a_compressed_log_publishes_its_refusal(self):
        doc = build(easy_log(), [], TODAY)
        self.assertIsNone(doc["anchor"])
        self.assertFalse(doc["zones"]["tempo_interval"]["confident"])
        self.assertIn("no hard effort", doc["zones"]["tempo_interval"]["source"])
        # Easy still derives — it comes off the distribution, not off an anchor.
        self.assertTrue(doc["zones"]["easy"]["confident"])

    def test_an_effort_produces_an_anchor_and_predictions(self):
        doc = build(easy_log(), [effort("2026-08-20", {"1mi": 478})], TODAY)
        self.assertEqual(doc["anchor"]["effort"], "1mi")
        self.assertEqual(doc["anchor"]["date"], "2026-08-20")
        self.assertEqual(doc["anchor"]["pace_s"], 478)
        self.assertLess(doc["anchor"]["age_weeks"], 1)
        self.assertIn("half", doc["predicted_s"])
        # A half is longer than a 10K is longer than a 5K; anything else means
        # the extrapolation ran the wrong way.
        p = doc["predicted_s"]
        self.assertLess(p["5k"], p["10k"])
        self.assertLess(p["10k"], p["half"])

    def test_a_rejected_anchor_is_not_published_alongside_unset_zones(self):
        """The misattribution this guards against.

        derive() discards an anchor whose implied threshold is slower than easy
        pace. find_anchor() does not know that, so the document would otherwise
        show an anchor next to zones that were never built from it.
        """
        doc = build(easy_log(), [effort("2026-08-20", {"1mi": 600})], TODAY)
        self.assertFalse(doc["zones"]["tempo_interval"]["confident"])
        self.assertIsNone(doc["anchor"])
        self.assertEqual(doc["predicted_s"], {})

    def test_no_anchor_means_no_race_prediction_at_all(self):
        # Rather than a projection off average training pace, which is what the
        # field this replaces did.
        self.assertEqual(predictions_from(None), {})
        self.assertEqual(build(easy_log(), [], TODAY)["predicted_s"], {})

    def test_counts_describe_what_it_was_built_from(self):
        doc = build(easy_log(n=12), [effort("2026-08-20", {"1mi": 478})], TODAY)
        self.assertEqual(doc["counts"]["activities"], 12)
        self.assertEqual(doc["counts"]["efforts"], 1)

    def test_the_document_is_json_serialisable(self):
        json.dumps(build(easy_log(), [effort("2026-08-20", {"1mi": 478})], TODAY))

    def test_an_empty_history_does_not_crash(self):
        doc = build([], [], TODAY)
        self.assertIsNone(doc["anchor"])
        self.assertFalse(doc["zones"]["easy"]["confident"])


class TestSummary(unittest.TestCase):
    def test_it_says_so_when_there_is_no_anchor(self):
        self.assertIn("none", summarise(build(easy_log(), [], TODAY)))

    def test_it_names_the_effort_when_there_is_one(self):
        text = summarise(build(easy_log(), [effort("2026-08-20", {"1mi": 478})], TODAY))
        self.assertIn("1mi", text)
        self.assertIn("2026-08-20", text)


if __name__ == "__main__":
    unittest.main()
