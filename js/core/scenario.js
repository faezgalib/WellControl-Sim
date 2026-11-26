// Scenario generation. All values in field units (ft, in, ppg, psi, bbl, spm).

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const between = (r, a, b) => a + (b - a) * r();
const round = (x, step) => Math.round(x / step) * step;

export const FAILURES = {
  chokePlug: { label: 'Choke plugging', hint: 'Choke starts to plug: casing and drill pipe pressure rise together.' },
  chokeWashout: { label: 'Choke washout', hint: 'Choke erodes: casing and drill pipe pressure fall together.' },
  nozzlePlug: { label: 'Bit nozzle plugged', hint: 'Drill pipe pressure jumps; casing pressure unchanged.' },
  stringWashout: { label: 'Drill string washout', hint: 'Drill pipe pressure falls slowly; casing pressure unchanged.' },
  pumpFailure: { label: 'Pump failure', hint: 'Pump stops; both pressures fall.' },
  annularLeak: { label: 'Annular fails to seal', hint: 'Well keeps flowing after the annular is closed.' },
};

export const BASE_OILS = {
  diesel: { label: 'Diesel', solub: 0.22 },
  mineral: { label: 'Mineral oil', solub: 0.2 },
  synthetic: { label: 'Synthetic (olefin)', solub: 0.18 },
};

/**
 * opts = { seed, mode:'drilling'|'tripping', mudType:'WBM'|'OBM', owr, baseOil,
 *          influx:'gas'|'water', floatValve, failures:[keys], randomFailure, weightUpMin,
 *          lineupCheck }
 */
export function makeScenario(opts = {}) {
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
  const r = rng(seed);
  const td = round(between(r, 8500, 12500), 50);
  const shoeDepth = round(td * between(r, 0.55, 0.7), 50);
  const casing = pick(r, [{ od: 9.625, id: 8.681, hole: 8.5 }, { od: 9.625, id: 8.835, hole: 8.5 }, { od: 13.375, id: 12.415, hole: 12.25 }]);
  const big = casing.hole > 10;
  const dp = { od: 5, id: 4.276 };
  const hw = { od: 5, id: 3.0, len: round(between(r, 300, 900), 30) };
  const dc = big ? { od: 8, id: 2.813, len: round(between(r, 400, 700), 30) } : { od: 6.5, id: 2.813, len: round(between(r, 400, 800), 30) };
  const omw = round(between(r, 9.6, 12.8), 0.1);
  const sidpp = round(between(r, 250, 750), 10);
  const pform = Math.round(0.052 * omw * td + sidpp);
  // Leak-off test at the shoe
  const testMw = round(omw - between(r, 0.2, 0.8), 0.1);
  const fracEmw = omw + between(r, 3.0, 4.2);
  const lotPsi = round((fracEmw - testMw) * 0.052 * shoeDepth, 10);
  const pumpOutput = big ? 0.119 : pick(r, [0.1, 0.105, 0.112]);
  const scrSpm = [30, 40];
  const scr30 = round(between(r, 420, 760) * (big ? 0.8 : 1), 10);
  const scr = scrSpm.map((spm) => ({ spm, psi: round(scr30 * Math.pow(spm / 30, 1.86), 10) }));
  // drilling rate chosen for ~2,800 psi pump pressure
  const drillSpm = Math.min(110, Math.round(30 * Math.pow(2800 / scr30, 1 / 1.86)));

  const mode = opts.mode ?? 'drilling';
  const scen = {
    seed, mode,
    name: `Well ${String(seed).slice(-4)}`,
    mud: {
      type: opts.mudType ?? 'WBM', rho: omw,
      owr: opts.owr ?? 80, baseOil: opts.baseOil ?? 'mineral',
    },
    influx: opts.influx ?? 'gas',
    floatValve: !!opts.floatValve,
    well: {
      td, hole: casing.hole, shoe: { depth: shoeDepth, id: casing.id, od: casing.od },
      dp, hw, dc, bitDepth: td, surfLine: round(between(r, 4, 9), 0.5),
    },
    pumpOutput, scr, drillSpm,
    lot: { psi: lotPsi, testMw },
    pform,
    fracShoePsi: Math.round(fracEmw * 0.052 * shoeDepth),
    pi: big ? 0.006 : 0.0045, // bbl/min/psi (reservoir productivity)
    migration: round(between(r, 700, 1300), 50), // ft/hr
    activePit: round(between(r, 380, 520), 5),
    killPitVol: 600,
    tripTank: 40,
    weightUpMin: opts.weightUpMin ?? 40,
    failures: [...(opts.failures ?? [])],
    randomFailure: !!opts.randomFailure,
    lineupCheck: opts.lineupCheck ?? true,
    kickStart: Math.round(between(r, 90, 200)), // s after start (drilling)
    drillingBreakRop: round(between(r, 90, 140), 5),
    normalRop: round(between(r, 30, 55), 5),
    tempSurfF: 80, tempGradF: 1.4,
  };
  if (scen.randomFailure) {
    const keys = mode === 'drilling' ? ['chokePlug', 'chokeWashout', 'nozzlePlug', 'stringWashout', 'pumpFailure'] : ['annularLeak'];
    scen.failures = [pick(r, keys)];
    scen.hiddenFailure = true;
  }
  // timing for failures that happen during the kill (fraction of first bottoms-up)
  scen.failureAt = between(r, 0.15, 0.55);
  if (mode === 'tripping') {
    // Static overbalance is small; swabbing while pulling starts the kick.
    // Bit already a few stands off bottom; influx enters below the bit.
    scen.well.bitDepth = td - 93 * Math.round(between(r, 3, 7));
    scen.pform = Math.round(0.052 * omw * td - between(r, 5, 15));
    scen.swabPsi = round(between(r, 80, 110), 5);
    scen.pi = scen.pi * 0.8;
    scen.standLen = 93;
    scen.standTime = 75; // s per stand
  }
  // Initial line-up: correct unless line-up check enabled (then 1-2 valves wrong)
  scen.lineup = { hcr: false, isoA: true, isoB: false, chokeA: 0, chokeB: 0 };
  if (scen.lineupCheck) {
    const wrong = pick(r, [['hcr'], ['isoA'], ['chokeA'], ['hcr', 'chokeA'], ['hcr', 'isoA']]);
    for (const w of wrong) {
      if (w === 'hcr') scen.lineup.hcr = true;
      if (w === 'isoA') scen.lineup.isoA = false;
      if (w === 'chokeA') scen.lineup.chokeA = round(between(r, 20, 60), 1);
    }
  }
  return scen;
}

export const CORRECT_LINEUP = { hcr: false, isoA: true, chokeA: 0 };
