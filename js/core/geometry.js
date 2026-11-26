// Well geometry for a vertical well (MD = TVD).
// Units: ft, in, bbl. Capacity factor: ID^2 / 1029.4 = bbl/ft.

export const capacity = (id) => (id * id) / 1029.4;
export const annCapacity = (outer, inner) => (outer * outer - inner * inner) / 1029.4;

/**
 * Build geometry from a well description.
 * well = { td, shoe:{depth,id}, hole, dp:{od,id}, hw:{od,id,len}, dc:{od,id,len}, bitDepth, surfLine }
 */
export function buildGeometry(well) {
  const bit = well.bitDepth ?? well.td;
  const dcLen = Math.min(well.dc.len, bit);
  const hwLen = Math.min(well.hw.len, bit - dcLen);
  const dpLen = bit - dcLen - hwLen;

  // String sections, surface -> bit
  const string = [
    { name: 'DP', top: 0, bot: dpLen, cap: capacity(well.dp.id), od: well.dp.od },
    { name: 'HWDP', top: dpLen, bot: dpLen + hwLen, cap: capacity(well.hw.id), od: well.hw.od },
    { name: 'DC', top: dpLen + hwLen, bot: bit, cap: capacity(well.dc.id), od: well.dc.od },
  ].filter((s) => s.bot - s.top > 0.01);

  // Annulus intervals by depth (top -> bottom). Outer = casing ID above shoe, hole below.
  const breaks = new Set([0, well.shoe.depth, well.td, bit]);
  for (const s of string) { breaks.add(s.top); breaks.add(s.bot); }
  const pts = [...breaks].filter((d) => d >= 0 && d <= well.td).sort((a, b) => a - b);
  const ann = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const top = pts[i], bot = pts[i + 1];
    if (bot - top < 0.01) continue;
    const mid = (top + bot) / 2;
    const outer = mid < well.shoe.depth ? well.shoe.id : well.hole;
    const sec = string.find((s) => mid >= s.top && mid < s.bot);
    const inner = sec ? sec.od : 0;
    ann.push({ top, bot, cap: annCapacity(outer, inner), outer, inner, cased: mid < well.shoe.depth });
  }
  // Cumulative volume from surface for annulus
  let v = 0;
  for (const a of ann) { a.v0 = v; v += a.cap * (a.bot - a.top); a.v1 = v; }
  const annVol = v;
  let sv = 0;
  for (const s of string) { s.v0 = sv; sv += s.cap * (s.bot - s.top); s.v1 = sv; }
  const strVol = sv;

  const volBelowBit = ann.filter((a) => a.top >= bit).reduce((t, a) => t + a.cap * (a.bot - a.top), 0);

  return {
    well, td: well.td, bit, shoe: well.shoe.depth, string, ann, annVol, strVol,
    volBelowBit, surfLine: well.surfLine ?? 0,
    /** depth (ft) at a given annulus volume measured from surface */
    annDepthFromTop(u) {
      if (u <= 0) return 0;
      for (const a of ann) if (u <= a.v1) return a.top + (u - a.v0) / a.cap;
      return well.td;
    },
    annVolFromTop(d) {
      if (d <= 0) return 0;
      for (const a of ann) if (d <= a.bot) return a.v0 + (d - a.top) * a.cap;
      return annVol;
    },
    annCapAt(d) {
      for (const a of ann) if (d <= a.bot) return a.cap;
      return ann[ann.length - 1].cap;
    },
    strDepthFromTop(u) {
      if (u <= 0) return 0;
      for (const s of string) if (u <= s.v1) return s.top + (u - s.v0) / s.cap;
      return bit;
    },
  };
}

/** Kill-sheet style volume breakdown (used by kill sheet + checker). */
export function volumeBreakdown(well) {
  const g = buildGeometry({ ...well, bitDepth: well.td });
  const dpLen = g.string.find((s) => s.name === 'DP')?.bot ?? 0;
  const hwLen = well.hw.len, dcLen = well.dc.len;
  const dpCap = capacity(well.dp.id), hwCap = capacity(well.hw.id), dcCap = capacity(well.dc.id);
  const ohDc = annCapacity(well.hole, well.dc.od);
  const ohDp = annCapacity(well.hole, well.dp.od);
  const csgDp = annCapacity(well.shoe.id, well.dp.od);
  const dcTop = well.td - dcLen;
  // open hole section above DC up to shoe (DP/HWDP same OD assumed)
  const ohDpLen = Math.max(0, dcTop - well.shoe.depth);
  const csgDpLen = well.shoe.depth;
  return {
    dpLen, hwLen, dcLen, dpCap, hwCap, dcCap, ohDc, ohDp, csgDp,
    dpVol: dpLen * dpCap, hwVol: hwLen * hwCap, dcVol: dcLen * dcCap,
    ohDcVol: dcLen * ohDc, ohDpVol: ohDpLen * ohDp, csgDpVol: csgDpLen * csgDp,
    ohDpLen, csgDpLen,
  };
}
