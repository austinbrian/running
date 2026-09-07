"""Derive pace zones from run history, and judge whether you are hitting one.

The plan names zones ("Tempo Interval Pace") but never defines them. The usual
fix is to type in a recent race time and let a calculator do the rest. Better,
where the data allows: derive them from what you have actually run.

The catch, and the reason this module reports confidence instead of just
returning numbers: **zone derivation needs an anchor at a known effort.** Easy
and long-run paces can be read straight off a pace distribution, because that
is what most runs are. Threshold and interval paces cannot — they need a
near-maximal effort to extrapolate from, and a training log full of easy runs
does not contain one. Inventing them anyway is how you get a "tempo" pace that
is either pointless or injurious, with nothing on the watch to say which.

So: derive what the evidence supports, and say plainly what it does not.
"""

from __future__ import annotations

import statistics
from typing import Any, Literal, TypedDict

# Optical wrist HR throws obvious artifacts — dropouts reading ~35 bpm and
# cadence-lock spikes north of 200. Neither is a heart rate; both wreck a
# percentile if left in.
HR_FLOOR = 90
HR_CEILING = 195

RECENT_DAYS = 90
MIN_MILES = 2.0
MIN_RUNS_FOR_EASY = 15

# An anchor effort has to be genuinely hard to extrapolate from. This is the
# floor for treating a run as one; it is deliberately strict.
ANCHOR_MIN_MINUTES = 15
# How much faster than normal running an effort must be to count as an anchor.
# 5% is roughly the gap between easy pace and threshold for most runners — below
# that, the difference is indistinguishable from a good day.
ANCHOR_MIN_MARGIN = 0.05
RIEGEL_EXPONENT = 1.06

# ── Best efforts as anchors ────────────────────────────────────────────────────
#
# A best effort is a maximal sustained segment by construction, so the HR test
# that guards the whole-run heuristic is unnecessary for it — the "faster than
# easy" sanity check in derive() still applies and still has the last word.
#
# Distances in miles. Anything shorter than a mile is excluded: Riegel is not
# trustworthy extrapolating from a few hundred metres to a half marathon, and a
# 400m surge inside an easy run is not an effort at all.
EFFORT_DISTANCES = {
    "1mi": 1.0, "2mi": 2.0, "5k": 3.107, "10k": 6.214, "15k": 9.321,
    "10mi": 10.0, "20k": 12.427, "half": 13.109,
}

# Four minutes of maximal running anchors better than fifteen of moderate, so
# this is deliberately lower than ANCHOR_MIN_MINUTES, which governs whole runs.
EFFORT_MIN_SECONDS = 240

# Recency weight, w = exp(-age_weeks / 4), and the floor a candidate must clear.
# 0.05 puts the cutoff at 4*ln(20) = 11.98 weeks, i.e. 83 days — a hair inside
# RECENT_DAYS rather than exactly on it. Beyond that a performance is a fact
# about a different runner: the 2021 half weights to 1e-28.
#
# The plan asked for a weighted maximum. This is a floor plus a maximum instead,
# because a continuous weight applied to a *pace* has no natural scale — there is
# no defensible way to say a 12-week-old 5K is "worth" 20 seconds per mile more
# than a fresh one. The floor expresses the same judgement without inventing an
# exchange rate, and the weight is reported so confidence can carry the age.
ANCHOR_MIN_WEIGHT = 0.05

# A Strava-flagged race is maximal by definition; an effort extracted from an
# ordinary training run is a segment someone happened to run fast. Rank accounts
# for that before speed does.
TRUST_RACE = 0
TRUST_WORKOUT = 1
TRUST_SEGMENT = 2
TRUST_WHOLE_RUN = 3

# ── Grade adjustment ───────────────────────────────────────────────────────────
#
# Elevation gain per mile is the strongest single correlate of pace in this
# dataset (r = +0.30), which is not saying much — it explains about 9% of the
# variance, and the whole effect across the p10-p90 terrain range is roughly
# 19 s/mi. Worth correcting for, not worth trusting far.
#
# The slope is fitted from the runner's own history rather than taken from a
# published cost-of-transport curve. Those are calibrated on treadmill grade,
# and the only signal available here is *total gain*, which says how hilly a
# run was but not how the climb was distributed. A fitted slope also absorbs
# what correlates with hills — trail surfaces, longer efforts, harder days —
# so it is a terrain correction rather than a physiological one. Named
# accordingly everywhere it surfaces.
GRADE_FIT_DAYS = 730
GRADE_FIT_MIN_RUNS = 30
# A run has to be long enough that its gain per mile means something.
GRADE_FIT_MIN_MILES = 2.0

ZoneName = Literal["recovery", "easy", "long_run", "half_marathon", "goal",
                   "tempo_interval", "cruise_interval", "5k_10k"]


class Zone(TypedDict):
    name: str
    low_s: float | None      # seconds per mile, faster end
    high_s: float | None     # seconds per mile, slower end
    source: str
    confident: bool


def pace_s(run: dict[str, Any]) -> float | None:
    """Seconds per mile, or None if the run cannot supply one."""
    miles = run.get("distance_miles") or 0
    mins = run.get("moving_time_minutes") or 0
    if miles < MIN_MILES or mins <= 0:
        return None
    return (mins * 60) / miles


def clean_hr(run: dict[str, Any]) -> float | None:
    hr = run.get("average_heartrate")
    if not hr or hr < HR_FLOOR or hr > HR_CEILING:
        return None
    return hr


def recent(activities: list[dict], today: str, days: int = RECENT_DAYS) -> list[dict]:
    """Runs from the last `days`, by ISO date string comparison."""
    from datetime import date, timedelta

    y, m, d = (int(p) for p in today.split("-"))
    cutoff = (date(y, m, d) - timedelta(days=days)).isoformat()
    return [a for a in activities
            if a.get("start_date", "") >= cutoff and pace_s(a) is not None]


def find_anchor(activities: list[dict], today: str,
                efforts: list[dict] | None = None) -> dict[str, Any] | None:
    """The hardest recent sustained effort, if one is hard enough to trust.

    Best efforts are consulted first when they are available, because a maximal
    segment is better evidence than any inference from a whole-run average. The
    heart-rate heuristic below remains the fallback for a history with no
    extracted efforts, and remains the only route for treadmill runs and others
    with no route to extract from.

    "Hard enough" means the average HR stands clearly above this runner's own
    normal — an absolute bpm threshold would be meaningless across people. If
    every run sits in the same narrow band, there is no anchor and this returns
    None rather than nominating the least-easy easy run.
    """
    from_efforts = anchor_from_efforts(efforts, today) if efforts else None
    if from_efforts is not None:
        return from_efforts

    runs = [a for a in recent(activities, today, days=365)
            if clean_hr(a) and (a.get("moving_time_minutes") or 0) >= ANCHOR_MIN_MINUTES]
    if len(runs) < 10:
        return None

    hrs = sorted(clean_hr(a) for a in runs)
    median_hr = statistics.median(hrs)
    spread = statistics.pstdev(hrs)
    # A real hard effort sits ~2 standard deviations above the usual. With a
    # compressed log, nothing clears this, which is the correct answer.
    hr_threshold = median_hr + 2 * spread

    # High HR alone is not effort. A hot or depleted day gives a high heart
    # rate at a *slow* pace, and extrapolating from it yields a "tempo" pace
    # slower than easy pace — which is exactly the nonsense this module exists
    # to refuse. A hard effort must be fast as well as hard.
    #
    # "Fast" needs a real margin, not a percentile: when every run sits in a
    # narrow band, the 25th percentile is a couple of seconds off the median
    # and a bad day clears it easily. Require the anchor to be meaningfully
    # quicker than normal running.
    paces = sorted(p for p in (pace_s(a) for a in runs) if p)
    pace_ceiling = statistics.median(paces) * (1 - ANCHOR_MIN_MARGIN)

    candidates = [a for a in runs
                  if clean_hr(a) >= hr_threshold and pace_s(a) <= pace_ceiling]
    if not candidates:
        return None
    # Among genuinely hard runs, the fastest is the best extrapolation base.
    return min(candidates, key=pace_s)


def riegel(anchor_miles: float, anchor_seconds: float, target_miles: float) -> float:
    """Predicted seconds per mile at `target_miles`, from an anchor effort."""
    total = anchor_seconds * (target_miles / anchor_miles) ** RIEGEL_EXPONENT
    return total / target_miles


def age_weeks(date: str, today: str) -> float:
    """Whole weeks between two ISO dates. Negative ages clamp to zero."""
    from datetime import date as _date

    def parse(value: str) -> _date:
        y, m, d = (int(part) for part in value[:10].split("-"))
        return _date(y, m, d)

    return max((parse(today) - parse(date)).days, 0) / 7


def recency_weight(date: str, today: str) -> float:
    """exp(-age_weeks / 4). Reported alongside every anchor, never hidden."""
    import math

    return math.exp(-age_weeks(date, today) / 4)


def anchor_from_efforts(efforts: list[dict], today: str) -> dict[str, Any] | None:
    """The best recent maximal segment, from efforts.json.

    This is the route around the problem that whole-run averages cannot see:
    2026-06-17 averages 8:21/mi and contains a 7:58 mile. `find_anchor()` reads
    the 8:21 and correctly concludes there is nothing hard in it; this reads the
    mile.

    Candidates are ranked by trust first — a flagged race beats a tagged workout
    beats an ordinary segment — and only then by implied 10K pace. Fitness is a
    ceiling, so the best qualifying effort wins rather than an average of them.
    """
    candidates = []
    for record in efforts or []:
        date = (record.get("start_date_local") or "")[:10]
        if not date:
            continue
        weight = recency_weight(date, today)
        if weight < ANCHOR_MIN_WEIGHT:
            continue

        workout_type = record.get("workout_type") or 0
        trust = {1: TRUST_RACE, 3: TRUST_WORKOUT}.get(workout_type, TRUST_SEGMENT)

        for key, miles in EFFORT_DISTANCES.items():
            effort = (record.get("best") or {}).get(key)
            seconds = effort and (effort.get("s") or effort.get("moving_s"))
            if not seconds or seconds < EFFORT_MIN_SECONDS:
                continue
            candidates.append({
                "distance_miles": miles,
                "moving_time_minutes": seconds / 60,
                "start_date": f"{date}T00:00:00Z",
                "effort": key,
                "trust": trust,
                "weight": round(weight, 4),
                "implied_10k_s": riegel(miles, seconds, 6.214),
            })

    if not candidates:
        return None
    # Trust ascending (race first), then implied pace ascending (fastest first).
    return min(candidates, key=lambda c: (c["trust"], c["implied_10k_s"]))


def derive(activities: list[dict], today: str,
           goal_pace_s: float | None = None,
           efforts: list[dict] | None = None) -> dict[str, Zone]:
    """Build the zone table. Zones without evidence come back unset, not guessed."""
    runs = recent(activities, today)
    paces = sorted(p for p in (pace_s(a) for a in runs) if p)
    zones: dict[str, Zone] = {}

    def unset(name: str, why: str) -> Zone:
        return {"name": name, "low_s": None, "high_s": None,
                "source": why, "confident": False}

    if len(paces) >= MIN_RUNS_FOR_EASY:
        # What he actually runs, most of the time, is by definition his easy pace.
        p25, p50, p75, p90 = (paces[int(q * len(paces))] for q in (.25, .5, .75, .9))
        src = f"{len(paces)} runs in the last {RECENT_DAYS} days"
        zones["easy"] = {"name": "easy", "low_s": p25, "high_s": p75,
                         "source": src, "confident": True}
        zones["long_run"] = {"name": "long_run", "low_s": p50, "high_s": p90,
                             "source": src, "confident": True}
        zones["recovery"] = {"name": "recovery", "low_s": p75, "high_s": p90 + 45,
                             "source": src, "confident": True}
    else:
        why = f"only {len(paces)} qualifying runs in {RECENT_DAYS} days"
        for n in ("easy", "long_run", "recovery"):
            zones[n] = unset(n, why)

    anchor = find_anchor(activities, today, efforts=efforts)

    # Last line of defence, and the one that catches anchors the heuristics
    # let through: threshold work must be faster than easy running. If it is
    # not, the anchor was not a hard effort, whatever its heart rate said.
    #
    # "Faster" needs the same margin the anchor search uses, for the same
    # reason. Bare `>=` passes anything a second quicker than easy p25, and on
    # a compressed log that is a coin flip: on 2026-09-09, when the 17 Jun
    # effort ages out, the best remaining candidate implies 9:23/mi against an
    # easy p25 of 9:25/mi and clears a bare check by two seconds — publishing
    # a "tempo" band of 9:23–9:49 that sits on top of easy 9:25–9:48. A zone
    # indistinguishable from easy pace is not a zone, and shipping one is the
    # exact failure this module exists to prevent.
    if anchor is not None and zones.get("easy", {}).get("low_s"):
        implied = riegel(anchor["distance_miles"],
                         anchor["moving_time_minutes"] * 60, 6.214)
        if implied >= zones["easy"]["low_s"] * (1 - ANCHOR_MIN_MARGIN):
            anchor = None

    if anchor is None:
        why = ("no hard effort on record — every recent run sits at the same "
               "easy effort, so there is nothing to extrapolate from")
        for n in ("half_marathon", "tempo_interval", "cruise_interval", "5k_10k"):
            zones[n] = unset(n, why)
    else:
        miles = anchor["distance_miles"]
        secs = anchor["moving_time_minutes"] * 60
        if anchor.get("effort"):
            src = (f"Riegel from a {anchor['effort']} best effort on "
                   f"{anchor['start_date'][:10]} ({fmt_pace(secs / miles)})")
        else:
            src = f"Riegel from {miles:.1f}mi on {anchor['start_date'][:10]}"
        hm = riegel(miles, secs, 13.109)
        tenk = riegel(miles, secs, 6.214)
        fivek = riegel(miles, secs, 3.107)
        zones["half_marathon"] = {"name": "half_marathon", "low_s": hm - 5,
                                  "high_s": hm + 5, "source": src, "confident": True}
        # Threshold sits between 10K and half-marathon effort.
        zones["tempo_interval"] = {"name": "tempo_interval", "low_s": tenk,
                                   "high_s": hm, "source": src, "confident": True}
        zones["cruise_interval"] = {"name": "cruise_interval", "low_s": tenk,
                                    "high_s": hm, "source": src, "confident": True}
        zones["5k_10k"] = {"name": "5k_10k", "low_s": fivek,
                           "high_s": tenk, "source": src, "confident": True}

    if goal_pace_s:
        zones["goal"] = {"name": "goal", "low_s": goal_pace_s - 5,
                         "high_s": goal_pace_s + 5,
                         "source": "set by you", "confident": True}
    else:
        zones["goal"] = unset("goal", "no goal time set")

    return zones


def fit_grade_adjustment(activities: list[dict], today: str) -> dict[str, Any] | None:
    """Least squares of pace against elevation gain per mile.

    Returns the slope in seconds per mile per foot-of-gain per mile, along with
    the reference terrain and the R^2, so a consumer can see how little of the
    variance this explains before leaning on it.

    The reference is the **median terrain**, not flat ground. Adjusting to flat
    would make every run faster and shift the whole distribution, which would
    silently invalidate the zone bands — those are derived from the pace
    percentiles of actual runs on actual hills. Normalising to typical terrain
    leaves the centre where it is and only moves runs relative to each other,
    which is the comparison the adjustment is for.
    """
    runs = []
    for activity in recent(activities, today, days=GRADE_FIT_DAYS):
        miles = activity.get("distance_miles") or 0
        gain = activity.get("elevation_feet")
        pace = pace_s(activity)
        if gain is None or pace is None or miles < GRADE_FIT_MIN_MILES:
            continue
        runs.append((gain / miles, pace))

    if len(runs) < GRADE_FIT_MIN_RUNS:
        return None

    mean_x = statistics.mean(x for x, _ in runs)
    mean_y = statistics.mean(y for _, y in runs)
    sxx = sum((x - mean_x) ** 2 for x, _ in runs)
    if sxx == 0:
        return None  # every run on identical terrain; nothing to fit
    slope = sum((x - mean_x) * (y - mean_y) for x, y in runs) / sxx

    var_y = statistics.pvariance([y for _, y in runs])
    residuals = [y - (mean_y + slope * (x - mean_x)) for x, y in runs]
    r_squared = 1 - statistics.pvariance(residuals) / var_y if var_y else 0.0

    return {
        "slope_s_per_ft_per_mi": round(slope, 4),
        "reference_ft_per_mi": round(mean_x, 1),
        "runs": len(runs),
        "r_squared": round(r_squared, 3),
    }


def grade_adjusted_pace_s(activity: dict[str, Any], fit: dict[str, Any] | None) -> float | None:
    """Pace corrected to the reference terrain. Kept here so the site and the
    watch cannot disagree about it any more than they can about the zones."""
    pace = pace_s(activity)
    miles = activity.get("distance_miles") or 0
    gain = activity.get("elevation_feet")
    if pace is None or not fit or gain is None or miles <= 0:
        return pace
    delta = (gain / miles) - fit["reference_ft_per_mi"]
    return pace - fit["slope_s_per_ft_per_mi"] * delta


# ── At-a-glance target feedback ────────────────────────────────────────────────

State = Literal["fast", "on", "slow", "unknown"]


def state_for(pace_now_s: float | None, zone: Zone, previous: State = "unknown",
              hysteresis_s: float = 8.0) -> State:
    """Are you on target right now? Three states, because that is all you can read.

    Mid-run you cannot read a number and compare it to another number. You can
    read one of three states, especially as colour. So the watch shows a state.

    Hysteresis matters more than it looks: GPS pace is noisy, and a hard
    threshold makes the indicator strobe every few seconds at the boundary,
    which is worse than useless — it trains you to ignore it. Once you are
    on target the band widens, so you have to genuinely drift to lose it.
    """
    if pace_now_s is None or zone["low_s"] is None or zone["high_s"] is None:
        return "unknown"

    low, high = zone["low_s"], zone["high_s"]
    if previous == "on":
        low -= hysteresis_s
        high += hysteresis_s

    if pace_now_s < low:
        return "fast"        # lower seconds-per-mile is faster
    if pace_now_s > high:
        return "slow"
    return "on"


def fmt_pace(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    return f"{int(seconds // 60)}:{int(round(seconds % 60)):02d}/mi"


def report(zones: dict[str, Zone]) -> str:
    """The zone table as the app would show it, confidence included."""
    order = ["recovery", "easy", "long_run", "half_marathon", "goal",
             "tempo_interval", "cruise_interval", "5k_10k"]
    lines = []
    for name in order:
        z = zones.get(name)
        if not z:
            continue
        if z["confident"]:
            span = f"{fmt_pace(z['low_s'])} – {fmt_pace(z['high_s'])}"
            lines.append(f"  {name:<16} {span:<22} {z['source']}")
        else:
            lines.append(f"  {name:<16} {'not set':<22} {z['source']}")
    return "\n".join(lines)
