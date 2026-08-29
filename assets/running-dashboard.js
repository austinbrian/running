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

const PLOTLY_CONFIG = { displayModeBar: false };
const PLOTLY_LAYOUT_BASE = {
  plot_bgcolor: 'white',
  hovermode: 'closest',
  hoverlabel: { bgcolor: 'white', font_size: 12, font_family: 'Arial, sans-serif' },
};

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ── State ──────────────────────────────────────────────────────────────────────

let allActivities = [];
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

  Plotly.newPlot('cumulative-chart', data, layout, PLOTLY_CONFIG);
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
    title: { text: `Week of ${weekLabel}`, font: { family: 'Arial, sans-serif', size: 18, color: '#333' } },
    xaxis: {
      ticktext: DAY_NAMES,
      tickvals: [0, 1, 2, 3, 4, 5, 6],
      range: [-0.5, 6.5],
      showgrid: false, showline: false,
    },
    yaxis: {
      showticklabels: false,
      range: [-0.2, 0.2],
      showgrid: false, zeroline: false, showline: false,
    },
    showlegend: false,
    height: 150,
    margin: { l: 20, r: 20, t: 40, b: 20 },
    hovermode: 'x',
    hoverdistance: 300,
  };

  Plotly.newPlot(containerId, data, layout, PLOTLY_CONFIG).then(chart => {
    chart.on('plotly_click', (eventData) => {
      if (eventData.points && eventData.points[0]) {
        const ids = eventData.points[0].customdata;
        if (ids && ids.length > 0) {
          window.open(`https://www.strava.com/activities/${ids[0]}`, '_blank');
        }
      }
    });
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

  renderPaceScatter(filtered, xAxis);
  renderPaceDistribution(filtered, xAxis);
}

function renderPaceScatter(activities, xAxisType) {
  if (activities.length === 0) {
    Plotly.newPlot('pace-chart', [], { ...PLOTLY_LAYOUT_BASE, title: 'Pace Analysis' }, PLOTLY_CONFIG);
    return;
  }

  const xValues = [];
  const yValues = [];
  const markerSizes = [];
  const hoverTexts = [];
  const ids = [];

  activities.forEach(a => {
    const miles = a.distance_miles || a.distance * 0.000621371;
    const mins = a.moving_time_minutes || a.moving_time / 60;
    const pace = miles > 0 ? mins / miles : 0;
    const elev = a.elevation_feet || a.total_elevation_gain * 3.28084;

    xValues.push(xAxisType === 'distance' ? miles : (a.start_date_local || a.start_date));
    yValues.push(pace);
    markerSizes.push(miles * 2);
    ids.push(a.id);
    hoverTexts.push(
      `<b>${a.name}</b><br>` +
      `Distance: ${miles.toFixed(2)} miles<br>` +
      `Pace: ${formatPace(pace)} min/mile<br>` +
      `Date: ${activityDay(a)}<br>` +
      `Elevation: ${elev.toFixed(0)} ft`
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

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    title: 'Pace Analysis',
    xaxis: {
      title: xAxisType === 'distance' ? 'Distance (miles)' : 'Date',
      gridcolor: 'lightgray',
    },
    yaxis: {
      title: 'Pace (minutes/mile)',
      autorange: 'reversed',
      gridcolor: 'lightgray',
    },
  };

  Plotly.newPlot('pace-chart', data, layout, PLOTLY_CONFIG).then(chart => {
    chart.on('plotly_click', (eventData) => {
      if (eventData.points && eventData.points[0]) {
        const activityId = eventData.points[0].customdata;
        if (activityId) {
          window.open(`https://www.strava.com/activities/${activityId}`, '_blank');
        }
      }
    });
  });
}

function renderPaceDistribution(activities, xAxisType) {
  if (activities.length === 0) {
    Plotly.newPlot('pace-distribution', [], { ...PLOTLY_LAYOUT_BASE }, PLOTLY_CONFIG);
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
      xaxis: { title: 'Distance Range (miles)', gridcolor: 'lightgray', tickangle: 45 },
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
      xaxis: { title: 'Week', gridcolor: 'lightgray', tickformat: '%Y-%m-%d', tickangle: 45 },
      yaxis: { title: 'Total Distance (miles)', gridcolor: 'lightgray' },
    };
  }

  Plotly.newPlot('pace-distribution', data, layout, PLOTLY_CONFIG);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', loadActivities);

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
    // Rest days with nothing but boilerplate are not worth a disclosure triangle
    const detail = [
      w.prescription ? `<p class="td-session">${esc(w.prescription)}</p>` : '',
      w.goal ? `<p class="td-goal">${esc(w.goal)}</p>` : '',
    ].join('');
    const expandable = Boolean(detail);

    return `
      <div class="training-day ${state}${isToday ? ' today' : ''}${expandable ? ' has-detail' : ''}"
        ${expandable ? `tabindex="0" role="button" aria-expanded="false"` : ''}>
        <div class="td-day">${w.day_name.slice(0, 3)} <span>${w.date.slice(8)}</span></div>
        <div class="td-plan"><strong>${w.type}</strong>${w.duration ? ' &middot; ' + w.duration : ''}${
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

  // Race-day effort at recent average pace, for scale.
  let mi = 0, mins = 0;
  allActivities.forEach(a => {
    const d = activityDay(a);
    if (d >= '2026-06-01' && d <= today) { mi += a.distance_miles || 0; mins += a.moving_time_minutes || 0; }
  });
  const racePaceMin = mi > 0 ? (mins / mi) * plan.race_distance_miles : null;

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
    layout.annotations = [{
      xref: 'paper', x: 1, y: racePaceMin, xanchor: 'right', yanchor: 'bottom',
      text: `13.1 mi at your recent pace ≈ ${Math.round(racePaceMin)} min`,
      showarrow: false, font: { size: 11, color: '#777' },
    }];
  }

  Plotly.newPlot('training-longrun', traces, layout, PLOTLY_CONFIG);
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
  ], Object.assign({}, PLOTLY_LAYOUT_BASE, {
    yaxis: { title: 'minutes per week', rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.18 },
    margin: { t: 20, r: 20, b: 60, l: 60 },
    height: 320,
  }), PLOTLY_CONFIG);
}
