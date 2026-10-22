"use strict";

// ============================================================
// STATE
// ============================================================

const state = {
  results: [],
  meta: null,

  animation: {
    ready: false,
    playing: false,
    time: 0,
    dtMin: 0.05,
    scenarioIndex: 0,
    series: null,
    frameRequest: null,
    previousTimestamp: null
  }
};

const charts = {
  histogram: null,
  waitBar: null,
  sla: null,
  timeSeries: null
};

const markerPlugin = {
  id: "timeMarker",

  afterDatasetsDraw(chart, args, pluginOptions) {
    if (!pluginOptions || !Number.isFinite(pluginOptions.value)) {
      return;
    }

    const xScale = chart.scales.x;
    const chartArea = chart.chartArea;

    if (!xScale || !chartArea) {
      return;
    }

    const x = xScale.getPixelForValue(pluginOptions.value);
    const context = chart.ctx;

    context.save();
    context.beginPath();
    context.moveTo(x, chartArea.top);
    context.lineTo(x, chartArea.bottom);
    context.lineWidth = 1.5;
    context.strokeStyle = "rgba(30,41,59,0.75)";
    context.setLineDash([6, 4]);
    context.stroke();
    context.restore();
  }
};

Chart.register(markerPlugin);

// ============================================================
// DOM
// ============================================================

const backendStatus = document.getElementById("backendStatus");
const lambdaInput = document.getElementById("lambdaInput");
const muInput = document.getElementById("muInput");
const simTimeInput = document.getElementById("simTimeInput");
const slaInput = document.getElementById("slaInput");
const scenariosInput = document.getElementById("scenariosInput");
const binsInput = document.getElementById("binsInput");
const seedInput = document.getElementById("seedInput");
const runButton = document.getElementById("runButton");
const exportCsvButton = document.getElementById("exportCsvButton");
const exportVideoButtonLeft = document.getElementById("exportVideoButtonLeft");
const statusBox = document.getElementById("status");
const summaryBody = document.querySelector("#summaryTable tbody");
const scenarioSelect = document.getElementById("scenarioSelect");
const playButton = document.getElementById("playButton");
const resetButton = document.getElementById("resetButton");
const stepButton = document.getElementById("stepButton");
const speedSlider = document.getElementById("speedSlider");
const speedValue = document.getElementById("speedValue");
const animationInfo = document.getElementById("animationInfo");
const sceneCanvas = document.getElementById("sceneCanvas");
const sceneContext = sceneCanvas.getContext("2d");

// ============================================================
// API
// ============================================================

function apiUrl(path) {
  return `${window.OSE_API_BASE}${path}`;
}

async function apiRequest(path, options = {}) {
  const response = await window.oseFetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.detail || payload?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

async function checkBackend() {
  if (window.OSE_API_BASE.includes("REPLACE-WITH-YOUR-RENDER-URL")) {
    backendStatus.textContent = "Backend: configure config.js";
    backendStatus.className = "backend-status offline";
    return;
  }

  backendStatus.textContent = "Backend: checking...";
  backendStatus.className = "backend-status checking";

  try {
    const data = await apiRequest("/api/health", { method: "GET" });
    backendStatus.textContent = `Backend: ${await oseServerName()} · v${data.version}`;
    backendStatus.className = "backend-status online";
  } catch (error) {
    backendStatus.textContent = `Backend: ${await oseServerName()} offline (${error.message})`;
    backendStatus.className = "backend-status offline";
  }
}

// ============================================================
// TABS
// ============================================================

document.querySelectorAll(".tab-button").forEach(button => {
  button.addEventListener("click", () => openTab(button.dataset.tab));
});

function openTab(tabId) {
  document.querySelectorAll(".tab-button").forEach(button => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });

  document.querySelectorAll(".tab-content").forEach(content => {
    content.classList.toggle("active", content.id === tabId);
  });
}

// ============================================================
// STATUS AND INPUTS
// ============================================================

function setStatus(message, type = "") {
  statusBox.textContent = `Status: ${message}`;
  statusBox.className = `status ${type}`;
}

function parseInputs() {
  const lambda = Number(lambdaInput.value);
  const mu = Number(muInput.value);
  const simulationHours = Number(simTimeInput.value);
  const slaMinutes = Number(slaInput.value);
  let bins = Math.floor(Number(binsInput.value));

  if (
    !Number.isFinite(lambda) ||
    !Number.isFinite(mu) ||
    !Number.isFinite(simulationHours) ||
    !Number.isFinite(slaMinutes) ||
    lambda <= 0 ||
    mu <= 0 ||
    simulationHours <= 0 ||
    slaMinutes < 0
  ) {
    throw new Error(
      "λ, μ, and simulation time must be positive; SLA must be non-negative."
    );
  }

  if (!Number.isFinite(bins) || bins < 5) {
    bins = 20;
    binsInput.value = 20;
  }

  bins = Math.min(bins, 100);

  return {
    lambda,
    mu,
    simulationHours,
    slaMinutes,
    bins,
    scenarios: parseScenarios(scenariosInput.value),
    seedText: seedInput.value.trim() || null
  };
}

function parseScenarios(text) {
  const values = String(text)
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);

  if (
    values.length === 0 ||
    values.some(value => !Number.isInteger(value) || value < 1)
  ) {
    throw new Error(
      'Server scenarios must be positive integers, for example "1 2 3".'
    );
  }

  return [...new Set(values)];
}

// ============================================================
// RUN SIMULATION THROUGH BACKEND
// ============================================================

runButton.addEventListener("click", runSimulation);

async function runSimulation() {
  try {
    setStatus("Sending inputs to the simulation backend...");
    stopAnimation();
    runButton.disabled = true;

    const inputs = parseInputs();
    const response = await apiRequest("/api/simulate", {
      method: "POST",
      body: JSON.stringify(inputs)
    });

    state.results = response.results;
    state.meta = response.meta;

    updateSummaryTable();
    updateCharts();
    initializeAnimationControls();

    exportCsvButton.disabled = false;
    exportVideoButtonLeft.disabled = false;
    openTab("chartsTab");

    const warningText = response.warnings?.length
      ? ` Warning: ${response.warnings.join(" ")}`
      : "";

    setStatus(
      `Done. ${state.meta.N} arrivals simulated across ${state.results.length} scenarios.${warningText}`,
      response.warnings?.length ? "warning" : "success"
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    runButton.disabled = false;
  }
}

// ============================================================
// SUMMARY TABLE
// ============================================================

function updateSummaryTable() {
  summaryBody.innerHTML = "";

  for (const result of state.results) {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${result.c}</td>
      <td>${result.N}</td>
      <td>${formatNumber(result.avgWaitMin)}</td>
      <td>${formatNumber(result.p95WaitMin)}</td>
      <td>${formatNumber(result.avgSystemMin)}</td>
      <td>${result.maxQueueLength}</td>
      <td>${formatNumber(result.utilizationPercent)}%</td>
      <td>${formatNumber(result.slaViolPct)}%</td>
      <td>${formatNumber(result.slaMeetPct)}%</td>
    `;

    summaryBody.appendChild(row);
  }
}

// ============================================================
// CHARTS
// ============================================================

function destroyChart(name) {
  if (charts[name]) {
    charts[name].destroy();
    charts[name] = null;
  }
}

function updateCharts() {
  updateHistogramChart();
  updateWaitBarChart();
  updateSlaChart();
}

function updateHistogramChart() {
  destroyChart("histogram");

  const allWaits = state.results.flatMap(result => result.waitMinutes);
  let minimum = Math.min(...allWaits);
  let maximum = Math.max(...allWaits);

  if (minimum === maximum) {
    minimum -= 0.5;
    maximum += 0.5;
  }

  const bins = state.meta.bins;
  const binWidth = (maximum - minimum) / bins;
  const centers = Array.from(
    { length: bins },
    (_, index) => minimum + (index + 0.5) * binWidth
  );

  const datasets = state.results.map(result => {
    const counts = histogramCounts(
      result.waitMinutes,
      minimum,
      maximum,
      bins
    );

    return {
      type: "line",
      label: `c=${result.c}`,
      data: centers.map((center, index) => ({ x: center, y: counts[index] })),
      stepped: "middle",
      pointRadius: 0,
      borderWidth: 2
    };
  });

  const maxCount = Math.max(
    1,
    ...datasets.flatMap(dataset => dataset.data.map(point => point.y))
  );

  datasets.push({
    type: "line",
    label: `SLA ${state.meta.slaMinutes} min`,
    data: [
      { x: state.meta.slaMinutes, y: 0 },
      { x: state.meta.slaMinutes, y: maxCount }
    ],
    pointRadius: 0,
    borderDash: [7, 5],
    borderWidth: 1.5
  });

  charts.histogram = new Chart(document.getElementById("histogramChart"), {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Waiting time (min)" }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "Number of trucks" },
          ticks: { precision: 0 }
        }
      }
    }
  });
}

function updateWaitBarChart() {
  destroyChart("waitBar");

  charts.waitBar = new Chart(document.getElementById("waitBarChart"), {
    type: "bar",
    data: {
      labels: state.results.map(result => `c=${result.c}`),
      datasets: [
        {
          label: "Mean wait",
          data: state.results.map(result => result.avgWaitMin)
        },
        {
          label: "P95 wait",
          data: state.results.map(result => result.p95WaitMin)
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { title: { display: true, text: "Number of servers" } },
        y: {
          beginAtZero: true,
          title: { display: true, text: "Waiting time (min)" }
        }
      }
    }
  });
}

function updateSlaChart() {
  destroyChart("sla");

  charts.sla = new Chart(document.getElementById("slaChart"), {
    type: "line",
    data: {
      labels: state.results.map(result => `c=${result.c}`),
      datasets: [{
        label: `% wait > ${state.meta.slaMinutes} min`,
        data: state.results.map(result => result.slaViolPct),
        pointRadius: 4,
        borderWidth: 2,
        tension: 0.15
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { title: { display: true, text: "Number of servers" } },
        y: {
          beginAtZero: true,
          suggestedMax: 100,
          title: { display: true, text: "SLA violations (%)" }
        }
      }
    }
  });
}

function histogramCounts(values, minimum, maximum, bins) {
  const counts = new Array(bins).fill(0);
  const width = (maximum - minimum) / bins;

  for (const value of values) {
    let index = Math.floor((value - minimum) / width);
    if (index >= bins) index = bins - 1;
    if (index < 0) index = 0;
    counts[index]++;
  }

  return counts;
}

// ============================================================
// ANIMATION INITIALIZATION
// ============================================================

function initializeAnimationControls() {
  scenarioSelect.innerHTML = "";

  state.results.forEach((result, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `Scenario c=${result.c}`;
    scenarioSelect.appendChild(option);
  });

  scenarioSelect.disabled = false;
  playButton.disabled = false;
  resetButton.disabled = false;
  stepButton.disabled = false;
  speedSlider.disabled = false;
  state.animation.ready = true;
  state.animation.scenarioIndex = 0;

  prepareAnimationScenario(0);
  openTab("animationTab");
}

scenarioSelect.addEventListener("change", () => {
  prepareAnimationScenario(Number(scenarioSelect.value));
});

function prepareAnimationScenario(index) {
  stopAnimation();
  state.animation.scenarioIndex = index;
  state.animation.time = 0;
  state.animation.series = buildTimeSeries(state.results[index]);
  state.animation.dtMin = state.animation.series.dtMin;

  autoSetAnimationSpeed(
    state.animation.series.time[state.animation.series.time.length - 1]
  );

  buildTimeSeriesChart();
  renderAnimation(0);
  playButton.textContent = "Play";
  animationInfo.textContent = `dt=${formatNumber(state.animation.dtMin)} min`;
}

function autoSetAnimationSpeed(maxTime) {
  let speed = 1;

  if (maxTime > 360) speed = 3;
  else if (maxTime > 180) speed = 2;
  else if (maxTime > 60) speed = 1.5;

  speedSlider.value = speed;
  speedValue.textContent = `${Number(speed).toFixed(2)}×`;
}

// ============================================================
// TIME SERIES FOR ANIMATION
// ============================================================

function buildTimeSeries(result) {
  const maximumTime = Math.max(1, ...result.endMinutes);
  const targetPoints = 1000;
  const dtMin = Math.max(0.02, Math.min(0.5, maximumTime / targetPoints));
  const time = [];

  for (let value = 0; value <= maximumTime + dtMin / 2; value += dtMin) {
    time.push(value);
  }

  const arrived = cumulativeCountsAtTimes(result.arrivalMinutes, time);
  const started = cumulativeCountsAtTimes(result.startMinutes, time);
  const departed = cumulativeCountsAtTimes(result.endMinutes, time);
  const inService = started.map((value, index) => value - departed[index]);
  const inQueue = arrived.map(
    (value, index) => Math.max(0, value - departed[index] - inService[index])
  );

  return { dtMin, time, arrived, inQueue, inService, departed };
}

function cumulativeCountsAtTimes(eventTimes, grid) {
  const sorted = [...eventTimes].sort((a, b) => a - b);
  const counts = new Array(grid.length).fill(0);
  let eventIndex = 0;

  for (let gridIndex = 0; gridIndex < grid.length; gridIndex++) {
    while (
      eventIndex < sorted.length &&
      sorted[eventIndex] <= grid[gridIndex]
    ) {
      eventIndex++;
    }

    counts[gridIndex] = eventIndex;
  }

  return counts;
}

// ============================================================
// ANIMATION CONTROLS
// ============================================================

playButton.addEventListener("click", () => {
  if (!state.animation.ready) return;

  state.animation.playing = !state.animation.playing;
  playButton.textContent = state.animation.playing ? "Pause" : "Play";
  state.animation.previousTimestamp = null;

  if (state.animation.playing) {
    state.animation.frameRequest = requestAnimationFrame(animationLoop);
  }
});

resetButton.addEventListener("click", () => {
  stopAnimation();
  state.animation.time = 0;
  playButton.textContent = "Play";
  renderAnimation(0);
});

stepButton.addEventListener("click", () => {
  stopAnimation();

  const maximumTime = getAnimationMaximumTime();
  const increment = state.animation.dtMin * Number(speedSlider.value);

  state.animation.time = Math.min(
    maximumTime,
    state.animation.time + increment
  );

  playButton.textContent = "Play";
  renderAnimation(state.animation.time);
});

speedSlider.addEventListener("input", () => {
  speedValue.textContent = `${Number(speedSlider.value).toFixed(2)}×`;
});

function stopAnimation() {
  state.animation.playing = false;
  state.animation.previousTimestamp = null;

  if (state.animation.frameRequest) {
    cancelAnimationFrame(state.animation.frameRequest);
    state.animation.frameRequest = null;
  }

  playButton.textContent = "Play";
}

function animationLoop(timestamp) {
  if (!state.animation.playing) return;

  if (state.animation.previousTimestamp === null) {
    state.animation.previousTimestamp = timestamp;
  }

  const elapsed = timestamp - state.animation.previousTimestamp;
  state.animation.previousTimestamp = timestamp;
  const speed = Number(speedSlider.value);

  state.animation.time += elapsed / 30 * state.animation.dtMin * speed;
  const maximumTime = getAnimationMaximumTime();

  if (state.animation.time >= maximumTime) {
    state.animation.time = maximumTime;
    state.animation.playing = false;
    playButton.textContent = "Play";
  }

  renderAnimation(state.animation.time);

  if (state.animation.playing) {
    state.animation.frameRequest = requestAnimationFrame(animationLoop);
  }
}

function getAnimationMaximumTime() {
  const series = state.animation.series;
  return series ? series.time[series.time.length - 1] : 0;
}

// ============================================================
// SCENE DRAWING
// ============================================================

function renderAnimation(timeMinutes) {
  drawScene(timeMinutes);
  updateTimeSeriesMarker(timeMinutes);
  animationInfo.textContent =
    `dt=${formatNumber(state.animation.dtMin)} | t=${formatNumber(timeMinutes)} min`;
}

function drawScene(timeMinutes) {
  const result = state.results[state.animation.scenarioIndex];
  const context = sceneContext;
  const width = sceneCanvas.width;
  const height = sceneCanvas.height;

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  const entry = { x: 30, y: height * 0.40, w: 130, h: 95 };
  const queue = { x: 205, y: height * 0.28, w: 535, h: 210 };
  const servers = { x: 795, y: height * 0.15, w: 235, h: 340 };
  const exit = { x: 1060, y: height * 0.40, w: 110, h: 95 };

  drawBox(context, entry, "Entry", "#eef2ff");
  drawBox(context, queue, "Queue", "#fff7ed");
  drawBox(context, servers, "Servers", "#ecfdf3");
  drawBox(context, exit, "Exit", "#eff6ff");

  drawArrow(context, entry.x + entry.w, entry.y + entry.h / 2, queue.x, queue.y + queue.h / 2);
  drawArrow(context, queue.x + queue.w, queue.y + queue.h / 2, servers.x, servers.y + servers.h / 2);
  drawArrow(context, servers.x + servers.w, servers.y + servers.h / 2, exit.x, exit.y + exit.h / 2);

  const serverPositions = createServerPositions(result.c, servers);

  serverPositions.forEach((position, index) => {
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#16a34a";
    context.lineWidth = 1.4;
    context.beginPath();
    context.arc(position.x, position.y, 27, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#166534";
    context.font = "bold 15px Arial";
    context.textAlign = "center";
    context.fillText(`S${index + 1}`, position.x, position.y + 5);
  });

  const maximumVisible = Math.min(result.N, 120);
  const waitingIds = [];

  for (let index = 0; index < maximumVisible; index++) {
    if (
      result.arrivalMinutes[index] <= timeMinutes &&
      timeMinutes < result.startMinutes[index]
    ) {
      waitingIds.push(index);
    }
  }

  waitingIds.sort(
    (a, b) => result.arrivalMinutes[a] - result.arrivalMinutes[b]
  );

  const queuePositions = createQueuePositions(Math.max(40, maximumVisible), queue);
  let arrivedCount = 0;
  let queueCount = 0;
  let serviceCount = 0;
  let departedCount = 0;

  for (let index = 0; index < result.N; index++) {
    const arrival = result.arrivalMinutes[index];
    const start = result.startMinutes[index];
    const end = result.endMinutes[index];

    if (arrival <= timeMinutes) arrivedCount++;

    if (arrival <= timeMinutes && timeMinutes < start) queueCount++;
    else if (start <= timeMinutes && timeMinutes < end) serviceCount++;
    else if (end <= timeMinutes) departedCount++;
  }

  for (let index = 0; index < maximumVisible; index++) {
    const arrival = result.arrivalMinutes[index];
    const start = result.startMinutes[index];
    const end = result.endMinutes[index];

    if (timeMinutes < arrival) continue;

    let position;
    let color;

    if (timeMinutes < start) {
      const queueIndex = waitingIds.indexOf(index);
      position = queuePositions[
        Math.min(queueIndex, queuePositions.length - 1)
      ];
      color = "#f59e0b";
    } else if (timeMinutes < end) {
      const serverId = result.serverIds[index] - 1;
      position = serverPositions[
        Math.max(0, Math.min(serverPositions.length - 1, serverId))
      ];
      color = "#22c55e";
    } else {
      position = { x: exit.x + exit.w / 2, y: exit.y + exit.h / 2 };
      color = "#3b82f6";
    }

    drawTruckDot(context, position.x, position.y, color, index + 1);
  }

  context.fillStyle = "#0f172a";
  context.font = "bold 17px Arial";
  context.textAlign = "right";

  const statsX = width - 20;
  let statsY = 30;

  [
    `Scenario: c=${result.c}`,
    `Time: ${formatNumber(timeMinutes)} min`,
    `Arrived: ${arrivedCount}`,
    `Queue: ${queueCount}`,
    `In service: ${serviceCount}`,
    `Departed: ${departedCount}`
  ].forEach(line => {
    context.fillText(line, statsX, statsY);
    statsY += 24;
  });
}

function drawBox(context, box, label, fillColor) {
  context.fillStyle = fillColor;
  context.strokeStyle = "#64748b";
  context.lineWidth = 2;
  context.fillRect(box.x, box.y, box.w, box.h);
  context.strokeRect(box.x, box.y, box.w, box.h);
  context.fillStyle = "#0f172a";
  context.font = "bold 18px Arial";
  context.textAlign = "center";
  context.fillText(label, box.x + box.w / 2, box.y - 10);
}

function drawArrow(context, x1, y1, x2, y2) {
  const headLength = 10;
  const angle = Math.atan2(y2 - y1, x2 - x1);

  context.strokeStyle = "#64748b";
  context.fillStyle = "#64748b";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(
    x2 - headLength * Math.cos(angle - Math.PI / 6),
    y2 - headLength * Math.sin(angle - Math.PI / 6)
  );
  context.lineTo(
    x2 - headLength * Math.cos(angle + Math.PI / 6),
    y2 - headLength * Math.sin(angle + Math.PI / 6)
  );
  context.closePath();
  context.fill();
}

function createServerPositions(count, box) {
  const positions = [];

  for (let index = 0; index < count; index++) {
    const y = count === 1
      ? box.y + box.h / 2
      : box.y + 45 + index * (box.h - 90) / (count - 1);

    positions.push({ x: box.x + box.w / 2, y });
  }

  return positions;
}

function createQueuePositions(count, box) {
  const positions = [];
  const columns = 12;
  const rows = Math.max(1, Math.ceil(count / columns));
  const xSpacing = (box.w - 50) / Math.max(columns - 1, 1);
  const ySpacing = (box.h - 70) / Math.max(rows - 1, 1);

  for (let index = 0; index < count; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);

    positions.push({
      x: box.x + box.w - 25 - column * xSpacing,
      y: box.y + 38 + row * ySpacing
    });
  }

  return positions;
}

function drawTruckDot(context, x, y, color, id) {
  context.fillStyle = color;
  context.strokeStyle = "#334155";
  context.lineWidth = 1;
  context.beginPath();
  context.arc(x, y, 8, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  if (id <= 40) {
    context.fillStyle = "#0f172a";
    context.font = "9px Arial";
    context.textAlign = "center";
    context.fillText(String(id), x, y - 11);
  }
}

// ============================================================
// ANIMATION TIME-SERIES CHART
// ============================================================

function buildTimeSeriesChart() {
  destroyChart("timeSeries");
  const series = state.animation.series;

  charts.timeSeries = new Chart(document.getElementById("timeSeriesChart"), {
    type: "line",
    data: {
      datasets: [
        createSeriesDataset("Arrived", series.time, series.arrived),
        createSeriesDataset("Queue", series.time, series.inQueue),
        createSeriesDataset("In service", series.time, series.inService),
        createSeriesDataset("Departed", series.time, series.departed),
        createMarkerDataset("Arrived marker"),
        createMarkerDataset("Queue marker"),
        createMarkerDataset("Service marker"),
        createMarkerDataset("Departed marker")
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { timeMarker: { value: 0 } },
      scales: {
        x: { type: "linear", title: { display: true, text: "Time (min)" } },
        y: {
          beginAtZero: true,
          title: { display: true, text: "Count" },
          ticks: { precision: 0 }
        }
      }
    }
  });
}

function createSeriesDataset(label, time, values) {
  return {
    label,
    data: time.map((x, index) => ({ x, y: values[index] })),
    pointRadius: 0,
    borderWidth: 1.8,
    tension: 0
  };
}

function createMarkerDataset(label) {
  return {
    type: "scatter",
    label,
    data: [{ x: 0, y: 0 }],
    pointRadius: 5,
    showLine: false
  };
}

function updateTimeSeriesMarker(timeMinutes) {
  if (!charts.timeSeries) return;

  const series = state.animation.series;
  const values = [
    previousValueAtTime(series.time, series.arrived, timeMinutes),
    previousValueAtTime(series.time, series.inQueue, timeMinutes),
    previousValueAtTime(series.time, series.inService, timeMinutes),
    previousValueAtTime(series.time, series.departed, timeMinutes)
  ];

  for (let index = 0; index < 4; index++) {
    charts.timeSeries.data.datasets[index + 4].data = [{
      x: timeMinutes,
      y: values[index]
    }];
  }

  charts.timeSeries.options.plugins.timeMarker.value = timeMinutes;
  charts.timeSeries.update("none");
}

function previousValueAtTime(time, values, target) {
  let low = 0;
  let high = time.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (time[middle] <= target) low = middle + 1;
    else high = middle - 1;
  }

  return values[Math.max(0, high)];
}

// ============================================================
// CSV EXPORT
// ============================================================

exportCsvButton.addEventListener("click", exportCsvLogs);

async function exportCsvLogs() {
  try {
    if (state.results.length === 0) {
      throw new Error("Run the simulation before exporting.");
    }

    if (typeof JSZip === "undefined") {
      throw new Error("The ZIP export library could not be loaded.");
    }

    const zip = new JSZip();
    zip.file("summary.csv", buildSummaryCsv());

    for (const result of state.results) {
      zip.file(`truck_log_scenario_${result.c}.csv`, buildTruckLogCsv(result));
    }

    zip.file("simulation_parameters.csv", buildParametersCsv());

    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, `queue_simulation_logs_${timestamp()}.zip`);
    setStatus("CSV logs exported in a ZIP archive.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function buildSummaryCsv() {
  const headers = [
    "c", "N", "MeanWait_min", "P95Wait_min", "MeanSystem_min",
    "QueueMax", "Utilization_percent", "SLA_Violation_percent",
    "SLA_Meet_percent"
  ];

  const rows = state.results.map(result => [
    result.c,
    result.N,
    result.avgWaitMin,
    result.p95WaitMin,
    result.avgSystemMin,
    result.maxQueueLength,
    result.utilizationPercent,
    result.slaViolPct,
    result.slaMeetPct
  ]);

  return rowsToCsv(headers, rows);
}

function buildTruckLogCsv(result) {
  const headers = [
    "TruckID", "ArrivalTime_hr", "StartService_hr", "EndService_hr",
    "Wait_min", "TotalSystem_min", "SLA_Violate", "ServerID"
  ];

  const rows = result.truckLog.map(record =>
    headers.map(header => record[header])
  );

  return rowsToCsv(headers, rows);
}

function buildParametersCsv() {
  const rows = [
    ["Parameter", "Value"],
    ["lambda_trucks_per_hour", state.meta.lambda],
    ["mu_trucks_per_hour_per_server", state.meta.mu],
    ["simulation_hours", state.meta.simulationHours],
    ["sla_limit_minutes", state.meta.slaMinutes],
    ["histogram_bins", state.meta.bins],
    ["server_scenarios", state.meta.scenarios.join(" ")],
    ["number_of_arrivals", state.meta.N],
    ["random_seed", state.meta.resolvedSeed]
  ];

  return rows.map(row => row.map(csvEscape).join(",")).join("\n");
}

function rowsToCsv(headers, rows) {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map(row => row.map(csvEscape).join(","))
  ].join("\n");
}

function csvEscape(value) {
  const text = String(value ?? "");

  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

// ============================================================
// VIDEO EXPORT
// ============================================================

exportVideoButtonLeft.addEventListener("click", exportAnimationVideo);

async function exportAnimationVideo() {
  try {
    if (!state.animation.ready) {
      throw new Error("Run the simulation before exporting video.");
    }

    if (typeof MediaRecorder === "undefined") {
      throw new Error("This browser does not support MediaRecorder.");
    }

    stopAnimation();
    exportVideoButtonLeft.disabled = true;
    runButton.disabled = true;

    const oldTime = state.animation.time;
    const maximumTime = getAnimationMaximumTime();
    const fps = 25;
    const mimeType = chooseVideoMimeType();
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const recordingCanvas = document.createElement("canvas");

    recordingCanvas.width = 1280;
    recordingCanvas.height = 720;

    const recordingContext = recordingCanvas.getContext("2d");
    const stream = recordingCanvas.captureStream(fps);
    const recorder = new MediaRecorder(
      stream,
      mimeType
        ? { mimeType, videoBitsPerSecond: 5_000_000 }
        : undefined
    );
    const chunks = [];

    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const stopped = new Promise(resolve => {
      recorder.onstop = resolve;
    });

    recorder.start();

    const frameCount = Math.min(
      750,
      Math.max(
        100,
        Math.ceil(maximumTime / Math.max(state.animation.dtMin, 0.02))
      )
    );

    for (let frame = 0; frame < frameCount; frame++) {
      const time = maximumTime * frame / Math.max(frameCount - 1, 1);
      state.animation.time = time;
      renderAnimation(time);
      drawRecordingFrame(recordingContext, recordingCanvas);

      if (frame % fps === 0 || frame === frameCount - 1) {
        setStatus(`Exporting video: ${frame + 1}/${frameCount} frames`);
      }

      await sleep(1000 / fps);
    }

    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mimeType || "video/webm" });
    downloadBlob(blob, `queue_animation_${timestamp()}.${extension}`);
    state.animation.time = oldTime;
    renderAnimation(oldTime);
    setStatus(`Animation video exported as ${extension.toUpperCase()}.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    exportVideoButtonLeft.disabled = state.results.length === 0;
    runButton.disabled = false;
  }
}

function chooseVideoMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }

  return "";
}

function drawRecordingFrame(context, canvas) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111827";
  context.font = "bold 24px Arial";
  context.textAlign = "left";
  context.fillText("Queue Simulation M/M/c + SLA", 20, 32);
  context.drawImage(sceneCanvas, 20, 50, 1240, 455);

  if (charts.timeSeries && charts.timeSeries.canvas) {
    context.drawImage(charts.timeSeries.canvas, 20, 520, 1240, 180);
  }
}

// ============================================================
// GENERIC HELPERS
// ============================================================

function formatNumber(value) {
  if (!Number.isFinite(value)) return "NaN";

  const absolute = Math.abs(value);

  if (absolute !== 0 && (absolute >= 100000 || absolute < 0.0001)) {
    return value.toExponential(4);
  }

  return value.toFixed(3);
}

function timestamp() {
  const date = new Date();

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "_",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// ============================================================
// INITIAL DISPLAY
// ============================================================

drawInitialScene();
checkBackend();

function drawInitialScene() {
  sceneContext.fillStyle = "#ffffff";
  sceneContext.fillRect(0, 0, sceneCanvas.width, sceneCanvas.height);
  sceneContext.fillStyle = "#667085";
  sceneContext.font = "22px Arial";
  sceneContext.textAlign = "center";
  sceneContext.fillText(
    "Run the simulation to initialize animation.",
    sceneCanvas.width / 2,
    sceneCanvas.height / 2
  );
}

/* Server selector: Auto / Home / Render (config.js reads ?api=) */
async function oseServerName() {
  const base = String(await window.OSE_API_READY || window.OSE_API_BASE || "");
  if (base.includes("onrender.com")) return "Render";
  if (base.includes("127.0.0.1") || base.includes("localhost")) return "Local";
  return "Home server";
}
(function initServerSelect() {
  const sel = document.getElementById("backendSelect");
  if (!sel) return;
  if (["localhost", "127.0.0.1"].includes(location.hostname)) { sel.hidden = true; return; }
  let pinned = new URLSearchParams(location.search).get("api");
  try { pinned = pinned || localStorage.getItem("ose_api"); } catch (e) {}
  sel.value = ["home", "render"].includes(pinned) ? pinned : "auto";
  sel.addEventListener("change", () => {
    const u = new URL(location.href); u.searchParams.set("api", sel.value); location.href = u.toString();
  });
})();
