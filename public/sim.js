"use strict";
/*
 * M/M/c + SLA discrete-event simulation engine — runs entirely in the browser.
 * Replaces the former FastAPI backend (POST /api/simulate). Same input and output shape:
 *   MMC.simulate({ lambda, mu, simulationHours, slaMinutes, bins, scenarios, seedText })
 *     -> { meta, results: [...], warnings: [...] }
 * Errors are thrown with the same messages the backend returned.
 *
 * Model: Poisson arrivals (rate λ, shared by every scenario = common random numbers),
 * exponential service (rate μ per server, separate stream per c), FCFS, unlimited queue.
 * An arriving truck takes the lowest-numbered idle server, otherwise the server that
 * becomes free first.
 */
(function () {
  const VERSION = "2.0.0";
  const MAX_ARRIVALS = 200000;

  // ---------- seeded PRNG: cyrb128 hash -> sfc32 ----------
  function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }

  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return t >>> 0;
    };
  }

  // Uniform in [0, 1) with 53-bit resolution
  function makeRng(seedText, stream) {
    const next = sfc32(...cyrb128(`${seedText}|${stream}`));
    for (let i = 0; i < 15; i++) next(); // warm-up
    return () => ((next() >>> 5) * 67108864 + (next() >>> 6)) / 9007199254740992;
  }

  // T = −ln(U)/rate with U in (0, 1]
  const exponential = (rng, rate) => -Math.log(1 - rng()) / rate;

  function randomSeed() {
    const bytes = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------- statistics ----------
  function percentile(values, p) { // numpy default (linear interpolation)
    const s = Float64Array.from(values).sort();
    const h = (s.length - 1) * p;
    const lo = Math.floor(h), hi = Math.ceil(h);
    return s[lo] + (s[hi] - s[lo]) * (h - lo);
  }

  function maxQueue(arrivals, starts) { // both arrays sorted; at equal times a start leaves before an arrival joins
    let i = 0, j = 0, q = 0, best = 0;
    while (i < arrivals.length) {
      if (j < starts.length && starts[j] <= arrivals[i]) { q--; j++; }
      else { q++; i++; if (q > best) best = q; }
    }
    return best;
  }

  // ---------- one scenario ----------
  function runScenario(arrHr, c, mu, T, sla, seedText) {
    const N = arrHr.length;
    const rng = makeRng(seedText, `service|c=${c}`);
    const free = new Float64Array(c);          // time (h) each server becomes free
    const startHr = new Float64Array(N), endHr = new Float64Array(N);
    const serverIds = new Array(N);

    for (let k = 0; k < N; k++) {
      const a = arrHr[k];
      let s = -1, earliest = 0;
      for (let j = 0; j < c; j++) {
        if (free[j] <= a) { s = j; break; }     // lowest-numbered idle server
        if (j === 0 || free[j] < free[earliest]) earliest = j;
      }
      if (s < 0) s = earliest;
      const start = Math.max(a, free[s]);
      const end = start + exponential(rng, mu);
      free[s] = end;
      startHr[k] = start; endHr[k] = end; serverIds[k] = s + 1;
    }

    const arrivalMinutes = new Array(N), startMinutes = new Array(N), endMinutes = new Array(N);
    const waitMinutes = new Array(N), truckLog = new Array(N);
    let sumWait = 0, sumSystem = 0, busy = 0, violations = 0;

    for (let k = 0; k < N; k++) {
      const a = arrHr[k] * 60, s = startHr[k] * 60, e = endHr[k] * 60;
      const w = s - a, sys = e - a, viol = w > sla ? 1 : 0;
      arrivalMinutes[k] = a; startMinutes[k] = s; endMinutes[k] = e; waitMinutes[k] = w;
      sumWait += w; sumSystem += sys; violations += viol;
      busy += Math.max(0, Math.min(endHr[k], T) - Math.min(startHr[k], T));
      truckLog[k] = {
        TruckID: k + 1,
        ArrivalTime_hr: arrHr[k],
        StartService_hr: startHr[k],
        EndService_hr: endHr[k],
        Wait_min: w,
        TotalSystem_min: sys,
        SLA_Violate: viol,
        ServerID: serverIds[k]
      };
    }

    const sortedStarts = Float64Array.from(startMinutes).sort();
    const slaViolPct = violations / N * 100;

    return {
      c,
      N,
      avgWaitMin: sumWait / N,
      p95WaitMin: percentile(waitMinutes, 0.95),
      avgSystemMin: sumSystem / N,
      maxQueueLength: maxQueue(arrivalMinutes, sortedStarts),
      utilizationPercent: busy / (c * T) * 100,
      slaViolPct,
      slaMeetPct: 100 - slaViolPct,
      stable: null,                // filled by simulate()
      trafficIntensityPercent: null,
      arrivalMinutes, startMinutes, endMinutes, waitMinutes, serverIds, truckLog
    };
  }

  // ---------- public entry ----------
  function simulate(inputs) {
    const lambda = Number(inputs.lambda);
    const mu = Number(inputs.mu);
    const T = Number(inputs.simulationHours);
    const sla = Number(inputs.slaMinutes);
    const bins = Math.min(100, Math.max(5, Math.floor(Number(inputs.bins) || 20)));
    const scenarios = [...new Set((inputs.scenarios || []).map(Number))];

    if (![lambda, mu, T, sla].every(Number.isFinite) || lambda <= 0 || mu <= 0 || T <= 0 || sla < 0) {
      throw new Error("λ, μ, and simulation time must be positive; SLA must be non-negative.");
    }
    if (scenarios.length === 0 || scenarios.some(c => !Number.isInteger(c) || c < 1)) {
      throw new Error('Server scenarios must be positive integers, for example "1 2 3".');
    }

    const seedText = inputs.seedText == null || String(inputs.seedText).trim() === ""
      ? null : String(inputs.seedText).trim();
    const resolvedSeed = seedText ?? randomSeed();

    // Arrivals (hours), shared by all scenarios
    const rngA = makeRng(resolvedSeed, "arrivals");
    const arrHr = [];
    for (let t = exponential(rngA, lambda); t <= T; t += exponential(rngA, lambda)) {
      arrHr.push(t);
      if (arrHr.length > MAX_ARRIVALS) {
        throw new Error("The simulation generated more than 200,000 arrivals. Reduce λ or the simulation horizon.");
      }
    }
    if (arrHr.length === 0) {
      throw new Error("No arrivals occurred. Increase λ or the simulation horizon.");
    }

    const warnings = [];
    const results = scenarios.map(c => {
      const r = runScenario(arrHr, c, mu, T, sla, resolvedSeed);
      r.stable = lambda < c * mu;
      r.trafficIntensityPercent = lambda / (c * mu) * 100;
      if (!r.stable) warnings.push(`Scenario c=${c}: λ ≥ cμ, so the theoretical M/M/c system is unstable.`);
      return r;
    });

    return {
      meta: {
        N: arrHr.length,
        bins,
        lambda,
        mu,
        resolvedSeed,
        scenarios,
        seedText,
        simulationHours: T,
        slaMinutes: sla,
        version: VERSION
      },
      results,
      warnings
    };
  }

  window.MMC = { VERSION, simulate };
})();
