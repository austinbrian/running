/**
 * Running Dashboard — client-side Plotly.js charts powered by Strava data.
 *
 * Fully static: activities.json is committed to this repo by the sync workflow
 * and fetched once on load, with every chart rendered client-side.
 */

// ── Configuration ──────────────────────────────────────────────────────────────

// DATA_URL is set in index.html via a <script> tag before this file loads.

const STRAVA_ORANGE = '#FC4C02';
const BURNT_ORANGE = '#E67E22';
const DARK_BLUE = '#000080';

// responsive keeps a chart matched to its container as the window changes;
// without it a phone rotated to landscape keeps the portrait width forever.
const PLOTLY_CONFIG = { displayModeBar: false, responsive: true };
const PLOTLY_LAYOUT_BASE = {
  plot_bgcolor: 'white',
  hovermode: 'closest',
  hoverlabel: { bgcolor: 'white', font_size: 12, font_family: 'Arial, sans-serif' },
};

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Which zones get a shaded band, slowest last so they stack predictably. Not
// every zone: long_run sits inside easy and half_marathon inside threshold, and
// drawing all eight turns the plot into mud. These four are the ones a run can
// meaningfully be judged against.
const BAND_ZONES = [
  { key: '5k_10k', label: '5K–10K', color: 'rgba(252, 76, 2, 0.14)' },
  { key: 'tempo_interval', label: 'Threshold', color: 'rgba(230, 126, 34, 0.14)' },
  { key: 'easy', label: 'Easy', color: 'rgba(0, 0, 128, 0.08)' },
  { key: 'recovery', label: 'Recovery', color: 'rgba(0, 0, 128, 0.045)' },
];

// Every zone the engine derives, slowest to fastest — the order you would read
// them in. `band` points at the BAND_ZONES entry that shades this zone on the
// chart, so the table doubles as the chart's legend instead of needing a
// separate key to match up.
const ZONE_TABLE = [
  { key: 'recovery', label: 'Recovery' },
  { key: 'easy', label: 'Easy' },
  { key: 'long_run', label: 'Long run' },
  { key: 'half_marathon', label: 'Half marathon' },
  { key: 'tempo_interval', label: 'Tempo / threshold' },
  { key: 'cruise_interval', label: 'Cruise interval' },
  { key: '5k_10k', label: '5K–10K' },
  { key: 'goal', label: 'Goal' },
];

const PREDICTION_LABELS = { '5k': '5K', '10k': '10K', half: 'Half' };

// The plan's vocabulary, mapped to the zone that resolves it. Mirrors the table
// in .devlog/plans/pace-zones.md. This belongs in training-plan.json as a `zone`
// key per workout — a property of the plan, not of the renderer — and should
// move to build_site_plan.py when that script next changes.
const ZONE_FOR_TYPE = {
  'Easy Run': 'easy',
  'Long Run': 'long_run',
  'Fast Finish Long Run': 'half_marathon',
  'Progression Run': 'tempo_interval',
  'Tempo Intervals': 'tempo_interval',
  'Cruise Intervals': 'cruise_interval',
  'Fartlek Run': '5k_10k',
  'Race Day': 'goal',
};
const DAY_NAMES_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── Viewport ───────────────────────────────────────────────────────────────────
//
// Plotly's responsive mode resizes a chart but does not restyle it: the margins,
// fonts and legend placement are whatever the layout said when it was drawn. So
// anything that has to change with the width is read from here at render time,
// and the current tab is redrawn when the breakpoint is crossed. Matches the
// 640px breakpoint in dashboard.css.

const NARROW = window.matchMedia('(max-width: 640px)');
const isNarrow = () => NARROW.matches;

// Plotly's defaults reserve about 80px on the left and 80px on top for the
// title, which on a 350px-wide phone is most of the plot. An overlaid legend
// covers the data outright, so it moves below the x-axis.
const NARROW_LAYOUT = {
  height: 300,
  margin: { l: 50, r: 14, t: 40, b: 54 },
  font: { size: 11 },
  legend: { orientation: 'h', y: -0.32, x: 0, font: { size: 11 } },
};

function layoutFor(layout) {
  if (!isNarrow()) return layout;
  const narrow = { ...layout, ...NARROW_LAYOUT };
  // A layout title is either a bare string or an object; keep the text either
  // way, since spreading NARROW_LAYOUT over it would otherwise drop it.
  const title = typeof layout.title === 'string' ? layout.title : layout.title?.text;
  if (title) narrow.title = { text: title, font: { size: 15 } };
  return narrow;
}

// A tap fires hover and click together, so on a touchscreen the first tap on a
// run would open Strava before its tooltip could be read. Take the second tap
// on the same point instead; a mouse still opens on the first click.
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

function openActivityOnClick(chart, activityIdOf) {
  let armed = null;
  chart.on('plotly_click', (eventData) => {
    const point = eventData.points && eventData.points[0];
    const id = point && activityIdOf(point);
    if (!id) return;
    if (COARSE_POINTER && armed !== id) { armed = id; return; }
    window.open(`https://www.strava.com/activities/${id}`, '_blank');
  });
}

// ── State ──────────────────────────────────────────────────────────────────────

let allActivities = [];
// zones.json, or null when it has not been published yet. Everything that reads
// it degrades to the unzoned view rather than failing, because the page has to
// keep working through the window where the extraction is still running.
let zonesDoc = null;
let trainingPlan = null;
// Which plan week the Training Plan tab is showing. Null until first render,
// then defaults to the current week; clicking the week nav overrides it.
let trainingWeek = null;
let currentTab = 'cumulative';

// ── Utilities ──────────────────────────────────────────────────────────────────

function formatPace(decimalMinutes) {
  if (!decimalMinutes || !isFinite(decimalMinutes)) return '--:--';
  const minutes = Math.floor(decimalMinutes);
  const seconds = Math.round((decimalMinutes - minutes) * 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// 1555 -> "25:55", 7153 -> "1:59:13". Hours only when there are any, and the
// minutes only zero-padded once an hour is in front of them.
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const secs = Math.round(seconds % 60);
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours ? hours + ':' : ''}${mm}:${String(secs).padStart(2, '0')}`;
}

function parseDate(dateStr) {
  return new Date(dateStr);
}

// Strava sends both a UTC start_date and a start_date_local wall clock, and every
// calendar question here wants the local one. An 8pm Eastern run is already the
// next day in UTC, so bucketing by start_date files it under tomorrow — which the
// training grid then reports as a missed session. Using the local string also
// makes the page read the same in any viewer's timezone, since a date-time with
// no offset parses as local wall clock. Records synced before start_date_local
// was stored fall back to UTC.
function activityDate(a) {
  return parseDate(a.start_date_local || a.start_date);
}

function activityDay(a) {
  return (a.start_date_local || a.start_date || '').slice(0, 10);
}

function rawPaceMin(a) {
  const miles = a.distance_miles || a.distance * 0.000621371;
  const mins = a.moving_time_minutes || a.moving_time / 60;
  return miles > 0 ? mins / miles : 0;
}

// Pace corrected to typical terrain, using the slope publish_zones.py fitted
// from this runner's own history. The reference is median terrain rather than
// flat ground on purpose: adjusting to flat would make every run faster and
// shift the whole distribution, which would quietly invalidate the zone bands —
// those come off the pace percentiles of real runs on real hills.
function gradeAdjustedPaceMin(a) {
  const raw = rawPaceMin(a);
  const fit = zonesDoc && zonesDoc.grade;
  const miles = a.distance_miles || a.distance * 0.000621371;
  const gain = a.elevation_feet;
  if (!fit || !miles || gain === undefined || gain === null) return raw;
  const delta = (gain / miles) - fit.reference_ft_per_mi;
  return raw - (fit.slope_s_per_ft_per_mi * delta) / 60;
}

// Pace at the reference heart rate: what this run would have been at the effort
// you usually give. Mirrors hr_adjusted_pace_s() in zones.py — the crude ratio
// rather than heart-rate reserve, because reserve needs an HRmax and that is the
// least settled number in this dataset.
//
// A run with no heart rate, or an artifact one, keeps its unadjusted pace rather
// than being dropped: an unadjusted point is honest, a missing one quietly
// changes which runs the trend is made of.
function hrAdjustedPaceMin(a, basePaceMin) {
  const base = basePaceMin === undefined ? rawPaceMin(a) : basePaceMin;
  const fit = zonesDoc && zonesDoc.hr;
  const hr = a.average_heartrate;
  if (!fit || !fit.reference_bpm || !hr || hr < 90 || hr > 195) return base;
  return base * hr / fit.reference_bpm;
}

function gradeAdjustOn() {
  return Boolean(document.getElementById('pace-grade-adjust')?.checked)
    && Boolean(zonesDoc && zonesDoc.grade);
}

function paceMin(a) {
  return gradeAdjustOn() ? gradeAdjustedPaceMin(a) : rawPaceMin(a);
}

function zone(key) {
  const z = zonesDoc && zonesDoc.zones && zonesDoc.zones[key];
  return z && z.confident && z.low_s ? z : null;
}

// "8:42–9:06/mi", or null. Callers show the zone's own `source` when this is
// null, rather than substituting a guess.
function zoneRange(key) {
  const z = zone(key);
  return z ? `${formatPace(z.low_s / 60)}–${formatPace(z.high_s / 60)}/mi` : null;
}

function toISODate(date) {
  return date.toISOString().split('T')[0];
}

function dayOfYear(date, startDate) {
  const diff = date - startDate;
  return Math.floor(diff / (1000 * 60 * 60 * 24)) + 1;
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  // Adjust to Monday (getDay: 0=Sun, 1=Mon, ... 6=Sat)
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function filterByDateRange(activities, startDate, endDate) {
  // A date-only string parses as UTC midnight, but setHours() below works in
  // local time, so a bare new Date('2026-12-31') lands the range end on the 30th
  // for any viewer west of UTC. Pinning the time makes both ends local, which is
  // what the date inputs and activityDate() both mean.
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  end.setHours(23, 59, 59, 999);
  return activities.filter(a => {
    const d = activityDate(a);
    return d >= start && d <= end;
  });
}

function getDateInputValue(id) {
  return document.getElementById(id)?.value || '';
}

function setDateInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

// ── Data Loading ───────────────────────────────────────────────────────────────

async function loadActivities() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    allActivities = await response.json();
    console.log(`Loaded ${allActivities.length} activities`);

    // Optional and fetched in parallel with nothing blocking on it: zones.json
    // does not exist until publish_zones.py has run, and the rest of the page
    // does not depend on it.
    try {
      const zonesResponse = await fetch(ZONES_URL);
      if (zonesResponse.ok) zonesDoc = await zonesResponse.json();
    } catch (zonesError) {
      console.warn('zones.json unavailable; bands and resolved paces are off', zonesError);
    }
    if (!allActivities.length) {
      document.getElementById('dashboard-content').innerHTML =
        '<p class="empty">No runs synced yet. The daily job writes ' +
        '<code>activities.json</code> to R2 once the Strava API app is active.</p>';
      return;
    }
    initializeDashboard();
  } catch (error) {
    console.error('Failed to load activities:', error);
    document.getElementById('dashboard-content').innerHTML =
      '<p class="error">Failed to load running data. Please try again later.</p>';
  }
}

// ── Dashboard Init ─────────────────────────────────────────────────────────────

function initializeDashboard() {
  const now = new Date();
  const yearStart = `${now.getFullYear()}-01-01`;
  const yearEnd = `${now.getFullYear()}-12-31`;
  const today = toISODate(now);

  // The cumulative tab runs year-to-date against an annual target, so its end
  // date is the end of the year. Ending it today would leave no remaining
  // period, which zeroes out the pace-to-target figures.
  setDateInputValue('cumulative-start', yearStart);
  setDateInputValue('cumulative-end', yearEnd);
  setDateInputValue('runs-start', yearStart);
  setDateInputValue('runs-end', today);
  setDateInputValue('pace-start', yearStart);
  setDateInputValue('pace-end', today);

  // Set default target
  const targetSlider = document.getElementById('target-slider');
  if (targetSlider) {
    targetSlider.value = 1000;
    document.getElementById('target-value').textContent = '1,000';
  }

  const gradeToggle = document.getElementById('pace-grade-adjust');
  if (gradeToggle && !(zonesDoc && zonesDoc.grade)) {
    gradeToggle.disabled = true;
    document.getElementById('pace-grade-toggle')?.setAttribute(
      'title', 'No hill adjustment published yet — publish_zones.py fits one from ' +
               'the last two years of runs.');
  }

  // Render initial tab
  renderCurrentTab();

  // Bind event listeners
  bindEvents();
}

function bindEvents() {
  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderCurrentTab();
    });
  });

  // Cumulative controls
  document.getElementById('cumulative-start')?.addEventListener('change', renderCumulative);
  document.getElementById('cumulative-end')?.addEventListener('change', renderCumulative);
  const targetSlider = document.getElementById('target-slider');
  if (targetSlider) {
    targetSlider.addEventListener('input', () => {
      document.getElementById('target-value').textContent =
        parseInt(targetSlider.value).toLocaleString();
      renderCumulative();
    });
  }

  // Individual runs controls
  document.getElementById('runs-start')?.addEventListener('change', renderWeeklyRuns);
  document.getElementById('runs-end')?.addEventListener('change', renderWeeklyRuns);
  document.getElementById('runs-quick-range')?.addEventListener('change', (e) => {
    applyQuickRange(e.target.value, 'runs-start', 'runs-end');
    renderWeeklyRuns();
  });
  // These are radio groups, not a single element — bind every input in the group.
  document.querySelectorAll('input[name="size-by"]')
    .forEach(input => input.addEventListener('change', renderWeeklyRuns));

  // Pace controls
  document.getElementById('pace-start')?.addEventListener('change', renderPaceAnalysis);
  document.getElementById('pace-end')?.addEventListener('change', renderPaceAnalysis);
  document.getElementById('pace-quick-range')?.addEventListener('change', (e) => {
    applyQuickRange(e.target.value, 'pace-start', 'pace-end');
    renderPaceAnalysis();
  });
  document.querySelectorAll('input[name="pace-x-axis"]')
    .forEach(input => input.addEventListener('change', renderPaceAnalysis));
  document.getElementById('pace-show-bands')?.addEventListener('change', renderPaceAnalysis);
  document.getElementById('pace-grade-adjust')?.addEventListener('change', renderPaceAnalysis);

  // Delegated: the week nav and day rows are re-rendered on every week change,
  // so binding per-element would leak listeners.
  document.getElementById('training-weeknav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-week]');
    if (!btn || btn.disabled) return;
    trainingWeek = Number(btn.dataset.week);
    renderTraining();
  });

  const weekTable = document.getElementById('training-week');
  weekTable?.addEventListener('click', (e) => toggleTrainingDay(e.target.closest('.has-detail')));
  weekTable?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.has-detail');
    if (!row) return;
    e.preventDefault();
    toggleTrainingDay(row);
  });
}

function toggleTrainingDay(row) {
  if (!row) return;
  const open = row.classList.toggle('open');
  row.setAttribute('aria-expanded', String(open));
}

function applyQuickRange(value, startId, endId) {
  const today = new Date();
  let start;
  switch (value) {
    case 'ytd':
      start = new Date(today.getFullYear(), 0, 1);
      break;
    case '1y':
      start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
      break;
    case '2y':
      start = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate());
      break;
    case '2020':
      start = new Date(2020, 0, 1);
      break;
    default:
      return;
  }
  setDateInputValue(startId, toISODate(start));
  setDateInputValue(endId, toISODate(today));
}

function renderCurrentTab() {
  // Show/hide tab panels
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.style.display = panel.dataset.tab === currentTab ? 'block' : 'none';
  });

  switch (currentTab) {
    case 'training':
      renderTraining();
      break;
    case 'cumulative':
      renderCumulative();
      break;
    case 'runs':
      renderWeeklyRuns();
      break;
    case 'pace':
      renderPaceAnalysis();
      break;
  }
}

// ── Tab 1: Cumulative Data ─────────────────────────────────────────────────────

function renderCumulative() {
  const startDate = getDateInputValue('cumulative-start');
  const endDate = getDateInputValue('cumulative-end');
  const target = parseInt(document.getElementById('target-slider')?.value || 1000);

  if (!startDate || !endDate) return;

  const filtered = filterByDateRange(allActivities, startDate, endDate);
  renderCumulativeChart(filtered, startDate, endDate, target);
  renderInfoBoxes(filtered, startDate, endDate, target);
}

function renderCumulativeChart(activities, startDateStr, endDateStr, target) {
  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);
  endDate.setHours(23, 59, 59);
  const daysInPeriod = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;

  // Group by day of year and sum distances
  const dailyMap = {};
  const dayToDate = {};
  activities.forEach(a => {
    const d = activityDate(a);
    const doy = dayOfYear(d, startDate);
    const miles = a.distance_miles || a.distance * 0.000621371;
    dailyMap[doy] = (dailyMap[doy] || 0) + miles;
    dayToDate[doy] = activityDay(a);
  });

  // Build cumulative series
  const days = Object.keys(dailyMap).map(Number).sort((a, b) => a - b);
  let cumulative = 0;
  const xActual = [];
  const yActual = [];
  const textActual = [];
  days.forEach(doy => {
    cumulative += dailyMap[doy];
    xActual.push(doy);
    yActual.push(cumulative);
    textActual.push(dayToDate[doy] || '');
  });

  // Target pace line
  const xTarget = [];
  const yTarget = [];
  for (let d = 1; d <= daysInPeriod; d++) {
    xTarget.push(d);
    yTarget.push(target * (d / daysInPeriod));
  }

  // Current day marker
  const now = new Date();
  const currentDoy = dayOfYear(now, startDate);
  const latestDoy = days.length > 0 ? days[days.length - 1] : currentDoy;
  const markerDoy = latestDoy < currentDoy ? latestDoy : currentDoy;
  const currentMiles = yActual.length > 0 ? yActual[yActual.length - 1] : 0;

  const data = [
    {
      type: 'scatter', mode: 'lines+markers', name: 'Actual Miles',
      x: xActual, y: yActual,
      line: { color: STRAVA_ORANGE }, marker: { size: 8 },
      text: textActual,
    },
    {
      type: 'scatter', mode: 'lines', name: `Target Pace (${target} miles)`,
      x: xTarget, y: yTarget,
      line: { color: 'gray', dash: 'dash' },
    },
    {
      type: 'scatter', mode: 'markers', name: 'Latest',
      x: [markerDoy], y: [currentMiles],
      marker: { size: 12, color: 'red', symbol: 'star' },
    },
  ];

  // Read the year off the string: `new Date('2026-01-01')` is UTC midnight, and
  // getFullYear() reads it back in local time, which lands on the previous year
  // in any negative-offset timezone.
  const year = Number(startDateStr.slice(0, 4));
  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    title: `Cumulative Running Distance ${year}`,
    xaxis: { title: 'Day of Year' },
    yaxis: { title: 'Cumulative Miles' },
    showlegend: true,
    legend: { yanchor: 'top', y: 0.99, xanchor: 'left', x: 0.01 },
  };

  Plotly.newPlot('cumulative-chart', data, layoutFor(layout), PLOTLY_CONFIG);
}

function renderInfoBoxes(activities, startDateStr, endDateStr, target) {
  if (activities.length === 0) {
    document.getElementById('info-boxes').innerHTML = '<p>No data for selected range.</p>';
    return;
  }

  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);

  const totalRuns = activities.length;
  let totalMiles = 0;
  let totalMinutes = 0;

  activities.forEach(a => {
    totalMiles += a.distance_miles || a.distance * 0.000621371;
    totalMinutes += (a.moving_time_minutes || a.moving_time / 60);
  });

  const avgPace = totalMinutes / totalMiles;

  // Find last, longest, fastest runs
  let lastRun = activities[0];
  let longestRun = activities[0];
  let fastestRun = null;

  activities.forEach(a => {
    const miles = a.distance_miles || a.distance * 0.000621371;
    const mins = a.moving_time_minutes || a.moving_time / 60;
    const pace = miles > 0 ? mins / miles : Infinity;

    if (activityDate(a) > activityDate(lastRun)) lastRun = a;
    if (miles > (longestRun.distance_miles || longestRun.distance * 0.000621371)) longestRun = a;
    if (miles >= 1.0 && (!fastestRun || pace < (fastestRun._pace || Infinity))) {
      fastestRun = { ...a, _pace: pace };
    }
  });

  const lastRunMiles = lastRun.distance_miles || lastRun.distance * 0.000621371;
  const lastRunMins = lastRun.moving_time_minutes || lastRun.moving_time / 60;
  const lastRunPace = lastRunMiles > 0 ? lastRunMins / lastRunMiles : 0;

  const longestMiles = longestRun.distance_miles || longestRun.distance * 0.000621371;
  const longestMins = longestRun.moving_time_minutes || longestRun.moving_time / 60;
  const longestPace = longestMiles > 0 ? longestMins / longestMiles : 0;

  const fastestPace = fastestRun?._pace || 0;
  const fastestMiles = fastestRun ? (fastestRun.distance_miles || fastestRun.distance * 0.000621371) : 0;

  // Progress calculations
  const lastRunDate = activityDate(lastRun);
  const daysElapsed = Math.floor((lastRunDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
  const totalDays = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
  const daysRemaining = Math.floor((endDate - lastRunDate) / (1000 * 60 * 60 * 24));
  const avgMilesPerCalendarDay = totalMiles / daysElapsed;
  const onPaceMiles = avgMilesPerCalendarDay * totalDays;
  const milesRemaining = target - totalMiles;
  const milesPerWeekRemaining = daysRemaining > 0 ? (milesRemaining / daysRemaining) * 7 : 0;
  const avgMilesPerRun = totalMiles / totalRuns;

  document.getElementById('info-boxes').innerHTML = `
    <div class="info-box">
      <h4>Totals</h4>
      <p>${totalRuns} runs</p>
      <p>${totalMiles.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} miles</p>
      <p>Average pace: ${formatPace(avgPace)}</p>
    </div>
    <div class="info-box">
      <h4>Records</h4>
      <div><b>Last run:</b> ${activityDay(lastRun)}, ${lastRunMiles.toFixed(2)} mi, pace: ${formatPace(lastRunPace)}</div>
      <div><b>Longest run:</b> ${activityDay(longestRun)}, ${longestMiles.toFixed(2)} mi, pace: ${formatPace(longestPace)}</div>
      <div><b>Fastest run:</b> ${fastestRun ? `${activityDay(fastestRun)}, ${fastestMiles.toFixed(2)} mi, pace: ${formatPace(fastestPace)}` : 'N/A'}</div>
    </div>
    <div class="info-box">
      <h4>Progress to Target</h4>
      <p>${avgMilesPerRun.toFixed(2)} avg miles per run</p>
      <p>On pace for ${onPaceMiles.toLocaleString(undefined, { maximumFractionDigits: 1 })} miles</p>
      <p>${milesPerWeekRemaining.toLocaleString(undefined, { maximumFractionDigits: 1 })} miles/week remaining</p>
    </div>
  `;
}

// ── Tab 2: Individual Runs (Weekly Bubbles) ────────────────────────────────────

function renderWeeklyRuns() {
  const startDate = getDateInputValue('runs-start');
  const endDate = getDateInputValue('runs-end');
  const sizeBy = document.querySelector('input[name="size-by"]:checked')?.value || 'distance';

  if (!startDate || !endDate) return;

  const filtered = filterByDateRange(allActivities, startDate, endDate);
  const container = document.getElementById('weekly-runs-container');
  container.innerHTML = '';

  if (filtered.length === 0) {
    container.innerHTML = '<p>No runs in selected range.</p>';
    return;
  }

  // Group by week
  const weeks = {};
  filtered.forEach(a => {
    const d = activityDate(a);
    const ws = getWeekStart(d);
    const key = toISODate(ws);
    if (!weeks[key]) weeks[key] = [];
    weeks[key].push(a);
  });

  // Sort weeks descending
  const sortedWeeks = Object.keys(weeks).sort().reverse();

  sortedWeeks.forEach(weekKey => {
    const weekStart = new Date(weekKey);
    const weekData = weeks[weekKey];
    const chartId = `week-chart-${weekKey}`;

    const weekDiv = document.createElement('div');
    weekDiv.className = 'week-row';
    weekDiv.innerHTML = `
      <div class="week-chart-wrapper">
        <div id="${chartId}" class="week-chart"></div>
        <div class="week-summary" id="summary-${weekKey}"></div>
      </div>
      <hr>
    `;
    container.appendChild(weekDiv);

    renderSingleWeekChart(chartId, weekStart, weekData, sizeBy);

    // Week summary
    const totalMiles = weekData.reduce((s, a) => s + (a.distance_miles || a.distance * 0.000621371), 0);
    const totalElev = weekData.reduce((s, a) => s + (a.elevation_feet || a.total_elevation_gain * 3.28084), 0);
    const summaryEl = document.getElementById(`summary-${weekKey}`);
    if (sizeBy === 'elevation') {
      summaryEl.innerHTML = `<div class="summary-number">${totalElev.toFixed(0)}</div><div class="summary-unit">ft</div>`;
    } else {
      summaryEl.innerHTML = `<div class="summary-number">${totalMiles.toFixed(1)}</div><div class="summary-unit">miles</div>`;
    }
  });
}

function renderSingleWeekChart(containerId, weekStart, weekData, sizeBy) {
  const xValues = [0, 1, 2, 3, 4, 5, 6];
  const yValues = [0, 0, 0, 0, 0, 0, 0];
  const sizes = [0, 0, 0, 0, 0, 0, 0];
  const hoverTexts = ['No runs', 'No runs', 'No runs', 'No runs', 'No runs', 'No runs', 'No runs'];
  const customdata = [null, null, null, null, null, null, null];

  weekData.forEach(a => {
    const d = activityDate(a);
    const dow = d.getDay();
    // Convert Sunday=0 to 6, Monday=1 to 0, etc.
    const dayIdx = dow === 0 ? 6 : dow - 1;

    const miles = a.distance_miles || a.distance * 0.000621371;
    const elev = a.elevation_feet || a.total_elevation_gain * 3.28084;
    const mins = a.moving_time_minutes || a.moving_time / 60;
    const pace = miles > 0 ? mins / miles : 0;

    sizes[dayIdx] += sizeBy === 'elevation' ? elev : miles;

    const runText = [
      `<b>${a.name}</b>`,
      `Distance: ${miles.toFixed(2)} miles`,
      `Time: ${formatPace(mins)} min`,
      `Pace: ${formatPace(pace)} min/mile`,
      `Elevation: ${elev.toFixed(0)} ft`,
    ].join('<br>');

    if (hoverTexts[dayIdx] === 'No runs') {
      hoverTexts[dayIdx] = runText;
      customdata[dayIdx] = [a.id];
    } else {
      hoverTexts[dayIdx] += '<br><br>' + runText;
      customdata[dayIdx].push(a.id);
    }
  });

  const maxSize = Math.max(...sizes);

  const data = [{
    type: 'scatter', mode: 'markers',
    x: xValues, y: yValues,
    marker: {
      size: sizes,
      sizemode: 'area',
      sizeref: maxSize > 0 ? 2.0 * maxSize / 3200.0 : 1,
      sizemin: 4,
      color: BURNT_ORANGE,
      opacity: 0.7,
    },
    text: hoverTexts,
    hoverinfo: 'text',
    customdata: customdata,
    hoverlabel: { bgcolor: 'white', font_size: 12, font_family: 'Arial, sans-serif' },
  }];

  const weekLabel = weekStart.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    title: {
      text: `Week of ${weekLabel}`,
      font: { family: 'Arial, sans-serif', size: isNarrow() ? 14 : 18, color: '#333' },
    },
    xaxis: {
      // Seven full weekday names need ~500px of plot; below that Plotly thins
      // them out rather than shortening them, leaving unlabelled bubbles.
      ticktext: isNarrow() ? DAY_NAMES_SHORT : DAY_NAMES,
      tickvals: [0, 1, 2, 3, 4, 5, 6],
      range: [-0.5, 6.5],
      showgrid: false, showline: false, zeroline: false,
      tickfont: isNarrow() ? { size: 10 } : undefined,
    },
    yaxis: {
      showticklabels: false,
      range: [-0.2, 0.2],
      showgrid: false, zeroline: false, showline: false,
    },
    showlegend: false,
    // Sized here rather than through layoutFor: this is a strip, not a plot,
    // and the shared narrow height would make it three times too tall.
    height: isNarrow() ? 130 : 150,
    margin: isNarrow() ? { l: 8, r: 8, t: 32, b: 22 } : { l: 20, r: 20, t: 40, b: 20 },
    hovermode: 'x',
    hoverdistance: 300,
  };

  Plotly.newPlot(containerId, data, layout, PLOTLY_CONFIG).then(chart => {
    openActivityOnClick(chart, point => (point.customdata || [])[0]);
  });
}

// ── Tab 3: Pace Analysis ───────────────────────────────────────────────────────

function renderPaceAnalysis() {
  const startDate = getDateInputValue('pace-start');
  const endDate = getDateInputValue('pace-end');
  const xAxis = document.querySelector('input[name="pace-x-axis"]:checked')?.value || 'distance';

  if (!startDate || !endDate) return;

  const filtered = filterByDateRange(allActivities, startDate, endDate)
    .filter(a => (a.distance_miles || a.distance * 0.000621371) >= 1.0);

  renderZoneSummary();
  renderPaceScatter(filtered, xAxis);
  renderPaceHistogram(filtered);
  renderEfficiency(filtered);
  renderPaceDistribution(filtered, xAxis);
}

function bandsOn() {
  return Boolean(document.getElementById('pace-show-bands')?.checked) && Boolean(zonesDoc);
}

// Horizontal shaded bands, drawn below the trace. Returns empty arrays when the
// toggle is off or nothing has been published, so the caller can spread these
// unconditionally.
function zoneBands() {
  if (!bandsOn()) return { shapes: [], annotations: [] };
  const shapes = [], annotations = [];
  BAND_ZONES.forEach(band => {
    const z = zone(band.key);
    if (!z) return;
    shapes.push({
      type: 'rect', xref: 'paper', x0: 0, x1: 1,
      y0: z.low_s / 60, y1: z.high_s / 60,
      fillcolor: band.color, line: { width: 0 }, layer: 'below',
    });
    annotations.push({
      xref: 'paper', x: 0.995, xanchor: 'right',
      y: (z.low_s + z.high_s) / 120, yanchor: 'middle',
      text: band.label, showarrow: false,
      font: { size: isNarrow() ? 9 : 11, color: '#777' },
    });
  });
  return { shapes, annotations };
}

// The bands are only as good as the anchor behind them, so the anchor is stated
// next to them rather than left implicit. When there is no anchor this reports
// zones.py's own refusal verbatim: a visibly missing tempo pace is a prompt to
// run a time trial, a quietly guessed one is how you get hurt.
function renderZoneSummary() {
  const el = document.getElementById('zone-summary');
  if (!el) return;

  // Say so, rather than rendering nothing. An empty panel and a disabled toggle
  // are indistinguishable from the feature being broken, which is exactly how
  // this read while zones.json was still a 404.
  if (!zonesDoc) {
    el.innerHTML = '<div class="zone-head zone-pending">Pace zones have not been '
      + 'published yet &mdash; <code>zones.json</code> is written by the sync workflow. '
      + 'Bands and hill adjustment turn on once it lands.</div>';
    return;
  }

  const a = zonesDoc.anchor;
  const head = a
    ? `Zones anchored on a <b>${esc(a.effort)}</b> best effort of `
      + `<b>${formatPace(a.pace_s / 60)}/mi</b> on ${a.date} `
      + `<span class="zone-age">(${a.age_weeks} weeks old)</span>`
    : `<span class="zone-warn">No anchor.</span> `
      + esc((zonesDoc.zones.tempo_interval || {}).source || '');

  const bandFor = key => BAND_ZONES.find(b => b.key === key);
  const rows = ZONE_TABLE.map(entry => {
    const z = (zonesDoc.zones || {})[entry.key];
    if (!z) return '';
    const band = bandFor(entry.key);
    const swatch = band
      ? `<i class="zone-swatch" style="background:${band.color}"></i>`
      : '<i class="zone-swatch zone-swatch-none"></i>';
    const range = z.confident && z.low_s
      ? `${formatPace(z.low_s / 60)}–${formatPace(z.high_s / 60)}`
      : '<span class="zone-unset">not set</span>';
    return `<tr>
        <th scope="row">${swatch}${entry.label}</th>
        <td class="zone-range">${range}</td>
        <td class="zone-src">${esc(z.source || '')}</td>
      </tr>`;
  }).join('');

  const predicted = Object.entries(zonesDoc.predicted_s || {})
    .map(([key, seconds]) =>
      `${PREDICTION_LABELS[key] || key} <b>${formatDuration(seconds)}</b>`)
    .join(' &middot; ');

  el.innerHTML = `<div class="zone-head">${head}</div>`
    + `<table class="zone-table"><tbody>${rows}</tbody></table>`
    + (predicted ? `<div class="zone-predicted">Predicted: ${predicted}</div>` : '');
}

function renderPaceScatter(activities, xAxisType) {
  if (activities.length === 0) {
    Plotly.newPlot('pace-chart', [], layoutFor({ ...PLOTLY_LAYOUT_BASE, title: 'Pace Analysis' }), PLOTLY_CONFIG);
    return;
  }

  const xValues = [];
  const yValues = [];
  const markerSizes = [];
  const hoverTexts = [];
  const ids = [];

  const adjusted = gradeAdjustOn();
  activities.forEach(a => {
    const miles = a.distance_miles || a.distance * 0.000621371;
    const raw = rawPaceMin(a);
    const pace = adjusted ? gradeAdjustedPaceMin(a) : raw;
    const elev = a.elevation_feet || a.total_elevation_gain * 3.28084;

    xValues.push(xAxisType === 'distance' ? miles : (a.start_date_local || a.start_date));
    yValues.push(pace);
    markerSizes.push(miles * 2);
    ids.push(a.id);
    hoverTexts.push(
      `<b>${a.name}</b><br>` +
      `Distance: ${miles.toFixed(2)} miles<br>` +
      // Both paces when adjusting, so the correction is never invisible.
      (adjusted
        ? `Pace: ${formatPace(pace)} adjusted (${formatPace(raw)} actual)<br>`
        : `Pace: ${formatPace(pace)} min/mile<br>`) +
      `Date: ${activityDay(a)}<br>` +
      `Elevation: ${elev.toFixed(0)} ft (${(elev / miles).toFixed(0)} ft/mi)`
    );
  });

  const maxMiles = Math.max(...activities.map(a => a.distance_miles || a.distance * 0.000621371));

  const data = [{
    type: 'scatter', mode: 'markers',
    x: xValues, y: yValues,
    marker: {
      size: markerSizes,
      sizemode: 'area',
      sizeref: 2.0 * maxMiles / (30.0 ** 2),
      sizemin: 4,
      color: BURNT_ORANGE,
      opacity: 0.7,
    },
    text: hoverTexts,
    hoverinfo: 'text',
    customdata: ids,
  }];

  const bands = zoneBands();
  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    title: 'Pace Analysis',
    xaxis: {
      title: xAxisType === 'distance' ? 'Distance (miles)' : 'Date',
      gridcolor: 'lightgray',
    },
    yaxis: {
      title: adjusted
        ? `Pace (min/mile, hill-adjusted to ${zonesDoc.grade.reference_ft_per_mi} ft/mi)`
        : 'Pace (minutes/mile)',
      autorange: 'reversed',
      gridcolor: 'lightgray',
    },
    shapes: bands.shapes,
    annotations: bands.annotations,
  };

  Plotly.newPlot('pace-chart', data, layoutFor(layout), PLOTLY_CONFIG).then(chart => {
    openActivityOnClick(chart, point => point.customdata);
  });
}

// Fifteen seconds. Wide enough that a bin is not one run, narrow enough that
// the easy band (about 23 seconds wide) is more than a single bar.
const PACE_BIN_MINUTES = 0.25;

// Vertical counterpart to zoneBands(): the same zones, shaded across x instead
// of y, so the two charts read as one set of bands seen from two directions.
//
// No labels on this one. The scatter can put them down its right-hand margin;
// here they would sit on top of the bars, and the widest band is 24 seconds of
// x — narrower than the word "Threshold". The pace table above the charts
// already carries the same swatch against the same name, so it is the legend
// for both.
function zoneBandsVertical(loMin, hiMin) {
  if (!bandsOn()) return [];
  return BAND_ZONES.flatMap(band => {
    const z = zone(band.key);
    if (!z) return [];
    const x0 = Math.max(z.low_s / 60, loMin), x1 = Math.min(z.high_s / 60, hiMin);
    if (x1 <= x0) return [];  // zone lies entirely outside the plotted range
    return [{
      type: 'rect', yref: 'paper', y0: 0, y1: 1, x0, x1,
      fillcolor: band.color, line: { width: 0 }, layer: 'below',
    }];
  });
}

function renderPaceHistogram(activities) {
  const el = document.getElementById('pace-histogram');
  if (!el) return;

  const paces = activities.map(a => paceMin(a)).filter(p => p > 0 && isFinite(p));
  if (paces.length < 5) { Plotly.purge(el); el.innerHTML = ''; return; }

  const counts = new Map();
  paces.forEach(p => {
    const bin = Math.floor(p / PACE_BIN_MINUTES) * PACE_BIN_MINUTES;
    counts.set(bin, (counts.get(bin) || 0) + 1);
  });
  const bins = [...counts.keys()].sort((a, b) => a - b);
  const centres = bins.map(b => b + PACE_BIN_MINUTES / 2);

  // Whole and half minutes only; every bin edge would be unreadable.
  const lo = bins[0], hi = bins[bins.length - 1] + PACE_BIN_MINUTES;
  const ticks = [];
  for (let t = Math.ceil(lo * 2) / 2; t <= hi; t += 0.5) ticks.push(t);

  const data = [{
    type: 'bar', x: centres, y: bins.map(b => counts.get(b)),
    width: PACE_BIN_MINUTES * 0.92,
    marker: { color: BURNT_ORANGE, opacity: 0.75 },
    text: bins.map(b => `<b>${formatPace(b)}–${formatPace(b + PACE_BIN_MINUTES)}/mi</b><br>`
      + `${counts.get(b)} run${counts.get(b) === 1 ? '' : 's'}`),
    hovertemplate: '%{text}<extra></extra>',
    textposition: 'none',
  }];

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    title: 'Pace Distribution',
    bargap: 0.04,
    xaxis: {
      title: gradeAdjustOn() ? 'Pace (hill-adjusted)' : 'Pace (min/mile)',
      gridcolor: 'lightgray',
      tickvals: ticks, ticktext: ticks.map(t => formatPace(t)),
      range: [lo, hi],
    },
    yaxis: {
      title: 'Number of Runs', gridcolor: 'lightgray',
      // Headroom, so the tallest bar does not run into the top of its band.
      range: [0, Math.max(...counts.values()) * 1.12],
    },
    shapes: zoneBandsVertical(lo, hi),
  };
  Plotly.newPlot(el, data, layoutFor(layout), PLOTLY_CONFIG);
}

// Trailing median over a window of days rather than a count of runs, because
// the runs are not evenly spaced — a fortnight off would otherwise sit inside
// the same window as the fortnight before it.
const EFFICIENCY_WINDOW_DAYS = 42;
const EFFICIENCY_MIN_SAMPLES = 8;

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function renderEfficiency(activities) {
  const el = document.getElementById('efficiency-chart');
  if (!el) return;
  const fit = zonesDoc && zonesDoc.hr;
  if (!fit) { Plotly.purge(el); el.innerHTML = ''; return; }

  // Terrain first, then effort, so the trend is normalised for both when the
  // hills toggle is on.
  const graded = gradeAdjustOn();
  const points = activities
    .filter(a => a.average_heartrate)
    .map(a => ({
      t: activityDate(a).getTime(),
      day: activityDay(a),
      name: a.name,
      raw: rawPaceMin(a),
      hr: a.average_heartrate,
      y: hrAdjustedPaceMin(a, graded ? gradeAdjustedPaceMin(a) : undefined),
    }))
    .sort((p, q) => p.t - q.t);

  if (points.length < EFFICIENCY_MIN_SAMPLES) { Plotly.purge(el); el.innerHTML = ''; return; }

  const windowMs = EFFICIENCY_WINDOW_DAYS * 86400000;
  const trendX = [], trendY = [];
  points.forEach((point, i) => {
    const window = [];
    for (let j = i; j >= 0 && points[j].t >= point.t - windowMs; j--) window.push(points[j].y);
    if (window.length >= EFFICIENCY_MIN_SAMPLES) {
      trendX.push(point.day);
      trendY.push(median(window));
    }
  });

  const data = [
    {
      type: 'scatter', mode: 'markers', name: 'per run',
      x: points.map(p => p.day), y: points.map(p => p.y),
      marker: { size: 6, color: BURNT_ORANGE, opacity: 0.35 },
      text: points.map(p => `<b>${p.name}</b><br>`
        + `Actual: ${formatPace(p.raw)}/mi at ${Math.round(p.hr)} bpm<br>`
        + `At ${fit.reference_bpm} bpm: ${formatPace(p.y)}/mi<br>${p.day}`),
      hoverinfo: 'text',
    },
    {
      type: 'scatter', mode: 'lines', name: `${EFFICIENCY_WINDOW_DAYS}-day median`,
      x: trendX, y: trendY,
      line: { color: DARK_BLUE, width: 2.5 },
      hovertemplate: '%{y:.2f} min/mi<extra>trend</extra>',
    },
  ];

  // A dropped heart rate reads as a spectacular run: 8:55/mi recorded at 116 bpm
  // adjusts to 7:05/mi, and two of those stretch the axis until the trend is a
  // flat line in the middle. The floor of 90 bpm cannot catch them, because a
  // wrong-but-plausible reading is indistinguishable from a real one here.
  //
  // So the view is clipped, not the data: the axis covers the middle 96% of
  // runs, every point is still in the trace, and the trend is legible.
  const sorted = [...points.map(p => p.y), ...trendY].sort((x, y) => x - y);
  const lo = quantile(sorted, 0.02), hi = quantile(sorted, 0.98);
  const pad = Math.max((hi - lo) * 0.08, 0.1);

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    title: 'Aerobic Efficiency',
    xaxis: { title: '', gridcolor: 'lightgray' },
    yaxis: {
      // Descending, so up is faster — matching the pace chart above it.
      title: `Pace at ${fit.reference_bpm} bpm${graded ? ', hill-adjusted' : ''}`,
      range: [hi + pad, lo - pad],
      gridcolor: 'lightgray',
    },
    showlegend: true,
    legend: { orientation: 'h', y: -0.18 },
  };
  Plotly.newPlot(el, data, layoutFor(layout), PLOTLY_CONFIG);
}

function renderPaceDistribution(activities, xAxisType) {
  if (activities.length === 0) {
    Plotly.newPlot('pace-distribution', [], layoutFor({ ...PLOTLY_LAYOUT_BASE }), PLOTLY_CONFIG);
    return;
  }

  let data, layout;

  if (xAxisType === 'distance') {
    // Distance bins in half-mile increments
    const maxMiles = Math.max(...activities.map(a => a.distance_miles || a.distance * 0.000621371));
    const numBins = Math.ceil(maxMiles / 0.5) + 1;
    const bins = {};
    const binPaces = {};

    for (let i = 0; i < numBins; i++) {
      const lo = (i * 0.5).toFixed(1);
      const hi = ((i + 1) * 0.5).toFixed(1);
      const label = `${lo}-${hi}`;
      bins[label] = 0;
      binPaces[label] = [];
    }

    activities.forEach(a => {
      const miles = a.distance_miles || a.distance * 0.000621371;
      const mins = a.moving_time_minutes || a.moving_time / 60;
      const pace = miles > 0 ? mins / miles : 0;
      const binIdx = Math.floor(miles / 0.5);
      const lo = (binIdx * 0.5).toFixed(1);
      const hi = ((binIdx + 1) * 0.5).toFixed(1);
      const label = `${lo}-${hi}`;
      if (bins[label] !== undefined) {
        bins[label]++;
        binPaces[label].push(pace);
      }
    });

    const labels = Object.keys(bins).filter(k => bins[k] > 0);
    const counts = labels.map(k => bins[k]);
    const hoverTexts = labels.map(k => {
      const paces = binPaces[k];
      const avgPace = paces.reduce((s, p) => s + p, 0) / paces.length;
      return `<b>${k} miles</b><br>Number of runs: ${bins[k]}<br>Average pace: ${formatPace(avgPace)} min/mile`;
    });

    data = [{
      type: 'bar', x: labels, y: counts,
      marker: { color: BURNT_ORANGE, opacity: 0.7 },
      text: hoverTexts,
      hovertemplate: '%{text}<extra></extra>',
      textposition: 'none',
    }];

    layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: 'Run Distance Distribution',
      xaxis: {
        title: 'Distance Range (miles)',
        gridcolor: 'lightgray',
        tickangle: isNarrow() ? 0 : 45,
        // Naming the ticks explicitly stops Plotly thinning them, so the
        // thinning has to be done here: roughly eight labels, lower bound only.
        tickvals: isNarrow() ? labels : undefined,
        ticktext: isNarrow()
          ? labels.map((l, i) => (i % Math.ceil(labels.length / 8) ? '' : l.split('-')[0]))
          : undefined,
      },
      yaxis: { title: 'Number of Runs', gridcolor: 'lightgray' },
    };
  } else {
    // Weekly distance totals
    const weeklyMap = {};
    activities.forEach(a => {
      const d = activityDate(a);
      const ws = getWeekStart(d);
      const key = toISODate(ws);
      const miles = a.distance_miles || a.distance * 0.000621371;
      const mins = a.moving_time_minutes || a.moving_time / 60;
      if (!weeklyMap[key]) weeklyMap[key] = { miles: 0, runs: 0, totalPace: 0 };
      weeklyMap[key].miles += miles;
      weeklyMap[key].runs += 1;
      weeklyMap[key].totalPace += (miles > 0 ? mins / miles : 0);
    });

    const sortedWeeks = Object.keys(weeklyMap).sort();
    const xVals = sortedWeeks;
    const yVals = sortedWeeks.map(k => weeklyMap[k].miles);
    const hoverTexts = sortedWeeks.map(k => {
      const w = weeklyMap[k];
      const avgPace = w.totalPace / w.runs;
      return `<b>Week of ${k}</b><br>Total distance: ${w.miles.toFixed(1)} miles<br>Number of runs: ${w.runs}<br>Average pace: ${formatPace(avgPace)} min/mile`;
    });

    data = [{
      type: 'bar', x: xVals, y: yVals,
      marker: { color: BURNT_ORANGE, opacity: 0.7 },
      text: hoverTexts,
      hovertemplate: '%{text}<extra></extra>',
      textposition: 'none',
    }];

    layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: 'Weekly Running Distance',
      xaxis: {
        title: 'Week', gridcolor: 'lightgray',
        tickformat: isNarrow() ? '%b %-d' : '%Y-%m-%d',
        tickangle: isNarrow() ? 0 : 45,
      },
      yaxis: { title: 'Total Distance (miles)', gridcolor: 'lightgray' },
    };
  }

  Plotly.newPlot('pace-distribution', data, layoutFor(layout), PLOTLY_CONFIG);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', loadActivities);

// Crossing the breakpoint changes tick labels, margins and legend placement,
// none of which Plotly's responsive resize touches. Rotating a phone fires this
// once, not on every intermediate width.
NARROW.addEventListener('change', () => {
  if (allActivities.length) renderCurrentTab();
});

// ── Training Plan ──────────────────────────────────────────────────────────────
//
// Overlays the McMillan half-marathon plan on actual Strava runs. The plan is a
// static file written by half-marathon/build_site_plan.py; nothing here mutates it.

// Static site content, not run data — data/ is gitignored for the R2 sync.
const PLAN_URL = 'assets/training-plan.json';
const RUN_TYPES = new Set(['Easy Run', 'Long Run', 'Tempo Intervals', 'Fast Finish Long Run',
                           'Fartlek Run', 'Progression Run', 'Cruise Intervals', 'Race Day']);

async function loadTrainingPlan() {
  if (trainingPlan) return trainingPlan;
  const res = await fetch(PLAN_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  trainingPlan = await res.json();
  return trainingPlan;
}

function activitiesByDate() {
  const map = {};
  allActivities.forEach(a => {
    const d = activityDay(a);
    if (!d) return;
    (map[d] = map[d] || []).push(a);
  });
  return map;
}

async function renderTraining() {
  let plan;
  try {
    plan = await loadTrainingPlan();
  } catch (e) {
    document.getElementById('training-status').innerHTML =
      '<p class="error">Could not load the training plan.</p>';
    return;
  }

  const byDate = activitiesByDate();
  const today = toISODate(new Date());
  const raceDate = plan.race_date;
  const daysToRace = Math.round((parseDate(raceDate) - parseDate(today)) / 86400000);

  // Which plan week are we in?
  const startMs = parseDate(plan.plan_start).getTime();
  const weekNow = Math.floor((parseDate(today).getTime() - startMs) / (7 * 86400000)) + 1;
  const currentWeek = Math.min(Math.max(weekNow, 1), plan.weeks);

  // The plan is written in minutes, so report in minutes. Miles are the wrong
  // unit here — a 9-mile run and a 90-minute run are different instructions.
  let longestSoFar = 0, baseMi = 0, baseMin = 0;
  allActivities.forEach(a => {
    const d = activityDay(a);
    if (d >= '2026-05-11' && d <= today) {
      longestSoFar = Math.max(longestSoFar, a.moving_time_minutes || 0);
      baseMi += a.distance_miles || 0;
      baseMin += a.moving_time_minutes || 0;
    }
  });
  const racePaceMin = baseMi > 0 ? (baseMin / baseMi) * plan.race_distance_miles : null;

  if (trainingWeek === null) trainingWeek = currentWeek;
  const shownWeek = Math.min(Math.max(trainingWeek, 1), plan.weeks);

  const thisWeek = plan.workouts.filter(w => w.week === currentWeek);
  const longThis = thisWeek.find(w => w.type.includes('Long'));
  const pct = racePaceMin ? Math.min(100, Math.round((longestSoFar / racePaceMin) * 100)) : 0;

  document.getElementById('training-status').innerHTML = `
    <div class="info-box">
      <h4>Race day</h4>
      <p><strong>${daysToRace}</strong> days &middot; ${new Date(raceDate + 'T12:00:00')
        .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p>
    </div>
    <div class="info-box">
      <h4>Plan week</h4>
      <p><strong>${currentWeek}</strong> of ${plan.weeks}</p>
    </div>
    <div class="info-box">
      <h4>Longest run so far</h4>
      <p><strong>${Math.round(longestSoFar)}</strong> min &middot; ${pct}% of race effort${
        racePaceMin ? ` (~${Math.round(racePaceMin)} min)` : ''}</p>
    </div>
    <div class="info-box">
      <h4>This week&rsquo;s long run</h4>
      <p><strong>${longThis ? longThis.duration : '&mdash;'}</strong></p>
    </div>`;

  renderWeekNav(plan, currentWeek, shownWeek);
  renderWeekTable(plan, byDate, today, currentWeek, shownWeek);

  renderLongRunChart(plan, byDate, today);
  renderTrainingVolume(plan, byDate, today);
}

// The week strip. Marks the current week so jumping away and back is easy, and
// stays a plain list of buttons so keyboard and screen readers get it for free.
function renderWeekNav(plan, currentWeek, shownWeek) {
  const pills = [];
  for (let w = 1; w <= plan.weeks; w++) {
    const classes = ['week-pill'];
    if (w === shownWeek) classes.push('active');
    if (w === currentWeek) classes.push('current');
    pills.push(`<button type="button" class="${classes.join(' ')}" data-week="${w}"` +
      `${w === shownWeek ? ' aria-current="true"' : ''}` +
      `${w === currentWeek ? ' title="Current week"' : ''}>${w}</button>`);
  }

  document.getElementById('training-weeknav').innerHTML = `
    <button type="button" class="week-step" data-week="${shownWeek - 1}"
      ${shownWeek <= 1 ? 'disabled' : ''} aria-label="Previous week">&lsaquo;</button>
    <div class="week-pills">${pills.join('')}</div>
    <button type="button" class="week-step" data-week="${shownWeek + 1}"
      ${shownWeek >= plan.weeks ? 'disabled' : ''} aria-label="Next week">&rsaquo;</button>
    <button type="button" class="week-today" data-week="${currentWeek}"
      ${shownWeek === currentWeek ? 'hidden' : ''}>Today</button>`;
}

function renderWeekTable(plan, byDate, today, currentWeek, shownWeek) {
  const week = plan.workouts.filter(w => w.week === shownWeek);
  const heading = shownWeek === currentWeek ? 'This week'
    : shownWeek < currentWeek ? `Week ${shownWeek} — done`
    : `Week ${shownWeek} — ahead`;
  document.getElementById('training-week-heading').textContent = heading;

  const span = week.length
    ? `${fmtDay(week[0].date)} – ${fmtDay(week[week.length - 1].date)}`
    : '';
  document.getElementById('training-week-note').textContent =
    `${plan.plan_name} — week ${shownWeek} of ${plan.weeks}${span ? `, ${span}` : ''}. ` +
    `Planned sessions against what Strava recorded. Tap a day for the full session.`;

  const rows = week.map(w => {
    const runs = byDate[w.date] || [];
    const mins = runs.reduce((t, r) => t + (r.moving_time_minutes || 0), 0);
    const miles = runs.reduce((t, r) => t + (r.distance_miles || 0), 0);
    const isRest = w.type === 'Rest Day';
    const past = w.date < today, isToday = w.date === today;

    let state = 'pending', label = '';
    if (runs.length) {
      state = isRest ? 'extra' : 'done';
      label = `${miles.toFixed(1)} mi &middot; ${Math.round(mins)} min`;
    } else if (isRest) {
      state = 'rest'; label = 'rest';
    } else if (past) {
      state = 'missed'; label = 'no run recorded';
    } else {
      label = 'upcoming';
    }
    // The plan names a zone; zones.json is what turns it into a pace. When the
    // zone is unset, say why rather than leaving the session unresolvable — the
    // refusal is the useful output.
    const zoneKey = ZONE_FOR_TYPE[w.type];
    const range = zoneKey ? zoneRange(zoneKey) : null;
    const zoneNote = !zoneKey || isRest ? ''
      : range
        ? `<p class="td-pace">Target <b>${range}</b>`
          + `<span class="td-src"> — ${esc(zonesDoc.zones[zoneKey].source)}</span></p>`
        : zonesDoc
          ? `<p class="td-pace td-pace-unset">No pace for this session yet — `
            + `${esc((zonesDoc.zones[zoneKey] || {}).source || 'zone not derived')}</p>`
          : '';

    // Rest days with nothing but boilerplate are not worth a disclosure triangle
    const detail = [
      w.prescription ? `<p class="td-session">${esc(w.prescription)}</p>` : '',
      zoneNote,
      w.goal ? `<p class="td-goal">${esc(w.goal)}</p>` : '',
    ].join('');
    const expandable = Boolean(detail);

    return `
      <div class="training-day ${state}${isToday ? ' today' : ''}${expandable ? ' has-detail' : ''}"
        ${expandable ? `tabindex="0" role="button" aria-expanded="false"` : ''}>
        <div class="td-day">${w.day_name.slice(0, 3)} <span>${w.date.slice(8)}</span></div>
        <div class="td-plan"><strong>${w.type}</strong>${w.duration ? ' &middot; ' + w.duration : ''}${
          range && !isRest ? ` <span class="td-target">@ ${range}</span>` : ''}${
          w.prescription ? '<span class="td-flag" title="Structured session">&#9679;</span>' : ''}</div>
        <div class="td-actual">${label}</div>
        ${expandable ? `<div class="td-detail">${detail}</div>` : ''}
      </div>`;
  }).join('');
  document.getElementById('training-week').innerHTML = rows;
}

function fmtDay(iso) {
  return new Date(iso + 'T12:00:00')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function esc(str) {
  return String(str).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderLongRunChart(plan, byDate, today) {
  const weeks = [], base = [], span = [], actual = [];
  for (let w = 1; w <= plan.weeks; w++) {
    const days = plan.workouts.filter(x => x.week === w);
    const long = days.find(x => x.type.includes('Long'));
    weeks.push(`W${w}`);
    // One floating bar per week (base = plan minimum, height = the range) reads as a
    // single band. Stacking two traces made the legend claim two separate series.
    base.push(long ? long.min_minutes : 0);
    span.push(long ? long.max_minutes - long.min_minutes : 0);

    let best = 0;
    days.forEach(d => (byDate[d.date] || []).forEach(r => {
      if (d.date <= today) best = Math.max(best, r.moving_time_minutes || 0);
    }));
    actual.push(best || null);
  }

  // Race-day effort, for scale. This used to be total minutes over total miles
  // since 2026-06-01, times 13.1 — every easy shakeout weighted equally with
  // every long run and no distance decay at all, which read as a prediction and
  // was not one. It now comes from zones.json, Riegel-extrapolated from the
  // anchoring effort, and is simply absent when there is no anchor.
  const predictedHalfS = zonesDoc && zonesDoc.predicted_s && zonesDoc.predicted_s.half;
  const racePaceMin = predictedHalfS ? predictedHalfS / 60 : null;

  const traces = [
    { x: weeks, y: span, base: base, type: 'bar', name: 'plan target range',
      marker: { color: 'rgba(252,76,2,0.30)', line: { color: 'rgba(252,76,2,0.55)', width: 1 } },
      hovertemplate: '%{base}–%{customdata} min<extra>plan</extra>',
      customdata: base.map((b, i) => b + span[i]) },
    { x: weeks, y: actual, type: 'scatter', mode: 'lines+markers', name: 'your longest run',
      connectgaps: false, line: { color: DARK_BLUE, width: 2 },
      marker: { size: 10, color: DARK_BLUE },
      hovertemplate: '%{y} min<extra>actual</extra>' },
  ];

  const layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
    yaxis: { title: 'minutes', rangemode: 'tozero' },
    xaxis: { title: '' },
    legend: { orientation: 'h', y: -0.18 },
    margin: { t: 20, r: 20, b: 60, l: 55 },
    height: 340,
  });

  if (racePaceMin) {
    layout.shapes = [{
      type: 'line', xref: 'paper', x0: 0, x1: 1, y0: racePaceMin, y1: racePaceMin,
      line: { color: '#999', width: 1, dash: 'dash' },
    }];
    // Right-anchored the label sits over the peak weeks' bars, which on a phone
    // is most of the plot; the left of the line is empty by the time it matters.
    layout.annotations = [{
      xref: 'paper', y: racePaceMin, yanchor: 'bottom', showarrow: false,
      x: isNarrow() ? 0 : 1,
      xanchor: isNarrow() ? 'left' : 'right',
      text: isNarrow()
        ? `13.1 mi ≈ ${Math.round(racePaceMin)} min`
        : `predicted half marathon ≈ ${Math.round(racePaceMin)} min`,
      font: { size: isNarrow() ? 10 : 11, color: '#777' },
    }];
  }

  Plotly.newPlot('training-longrun', traces, layoutFor(layout), PLOTLY_CONFIG);
}

function renderTrainingVolume(plan, byDate, today) {
  const weeks = [], mins = [], partial = [], base = [], span = [];
  for (let w = 1; w <= plan.weeks; w++) {
    const days = plan.workouts.filter(x => x.week === w);
    weeks.push(`W${w}`);

    let total = 0, elapsed = 0;
    days.forEach(d => {
      if (d.date <= today) {
        elapsed++;
        (byDate[d.date] || []).forEach(r => { total += r.moving_time_minutes || 0; });
      }
    });
    // A week still in progress cannot be compared to a weekly target — plotting
    // Monday's partial as if it were the week's total reads as a collapse.
    if (elapsed === 0) { mins.push(null); partial.push(null); }
    else if (elapsed < 7) { mins.push(null); partial.push(Math.round(total)); }
    else { mins.push(Math.round(total)); partial.push(null); }

    // The plan's weekly ask, summed from its per-session ranges.
    const lo = days.reduce((t, d) => t + d.min_minutes, 0);
    const hi = days.reduce((t, d) => t + d.max_minutes, 0);
    base.push(lo);
    span.push(hi - lo);
  }

  Plotly.newPlot('training-volume', [
    { x: weeks, y: span, base: base, type: 'bar', name: 'plan target range',
      marker: { color: 'rgba(252,76,2,0.22)', line: { color: 'rgba(252,76,2,0.45)', width: 1 } },
      hovertemplate: '%{base}–%{customdata} min<extra>plan</extra>',
      customdata: base.map((b, i) => b + span[i]) },
    { x: weeks, y: mins, type: 'scatter', mode: 'lines+markers', name: 'minutes run',
      connectgaps: false, line: { color: STRAVA_ORANGE, width: 2 },
      marker: { size: 9, color: STRAVA_ORANGE },
      hovertemplate: '%{y} min<extra>completed week</extra>' },
    { x: weeks, y: partial, type: 'scatter', mode: 'markers', name: 'this week so far',
      marker: { size: 11, color: 'white', symbol: 'circle',
                line: { color: STRAVA_ORANGE, width: 2 } },
      hovertemplate: '%{y} min so far<extra>week in progress</extra>' },
  ], layoutFor(Object.assign({}, PLOTLY_LAYOUT_BASE, {
    yaxis: { title: 'minutes per week', rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.18 },
    margin: { t: 20, r: 20, b: 60, l: 60 },
    height: 320,
  })), PLOTLY_CONFIG);
}
