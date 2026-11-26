# Well Control Sim

Personal practice simulator for the IWCF Drilling Well Control Level 3/4 practical
(surface BOP, vertical well, field units). Installable as an offline PWA on an
Android tablet.

## What it does (Phase 1)

- **Drilling kick**: undeclared kick with drilling break, flow and pit gain. Hard
  shut-in with every step on the panel (rotary, pick up / space out, pumps, annular
  and rams, HCR, choke manifold line-up).
- **Tripping (swab) kick**: trip tank vs trip sheet, FOSV stab/close, top drive,
  BOP. Ends after shut-in and recorded pressures (off-bottom kill is Phase 3).
- **Mud system**: WBM (free gas: migration, steady expansion) or OBM/SBM (gas in
  solution: small pit gain, no migration while shut in, breakout near surface).
- **Influx**: gas or salt water. Optional float valve (bump the float to read SIDPP).
- **Kill**: method chosen after shut-in — Driller's Method or Wait & Weight. Choke
  A/B with % buttons and hold-to-move, two pumps, kill pit weight-up, suction line-up.
- **Equipment problems** during the kill (chosen or random/hidden): choke plugging,
  choke washout, nozzle plugged, string washout, pump failure, annular not sealing.
- **Kill sheet**: IWCF-style surface vertical sheet, line-by-line checking, worked
  solution, DP schedule built from your own numbers. Also a standalone trainer.
- **Coach mode**: procedure steps, live target on the gauges and a BHP-vs-formation
  indicator. Turn it off to practise reading the gauges alone.
- **Debrief**: what happened, when, why it matters and the correct action; BHP
  margin chart; history saved on the device (IndexedDB) with recurring issues.

## Physics model (short)

Implicit wellhead-pressure solve each 0.25 s step from an annulus volume balance:
liquid slugs + free gas (ideal gas, Z = 1, temperature gradient), mud/wellbore
compliance, choke flow (homogeneous mixture, choked gas limit), friction split
string/bit/annulus scaled from the SCR, gas slip/migration, OBM solubility with
under-saturation and breakout, reservoir inflow (PI) and shoe losses above
fracture pressure, and a pressure-wave delay to the standpipe gauge.

Rounding used on the kill sheet: KMW up to 0.1 ppg, maximum allowable mud density
down to 0.1 ppg, MAASP down to whole psi. Confirm with your course material.

## Run locally

```bash
npm test              # physics + kill sheet tests (Node 22)
npm run serve         # http://localhost:8080
```

## Install on the tablet

1. Enable GitHub Pages: repository **Settings → Pages → Source: GitHub Actions**.
2. Merge to `main` (the workflow tests, then deploys).
3. Open the Pages URL in Chrome on the tablet → menu → **Install app**.
4. Open it once while online; after that it works offline.

After an update, open the app twice while online to pick up the new version.
