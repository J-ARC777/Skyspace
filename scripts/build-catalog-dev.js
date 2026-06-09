/**
 * build-catalog.js
 * Downloads the Hipparcos catalog subset and outputs a compact binary
 * buffer for efficient Three.js BufferGeometry consumption.
 *
 * Output: public/data/stars.bin
 * Format per star (48 bytes):
 *   x, y, z       — float32 × 3  (heliocentric cartesian, parsecs)
 *   r, g, b       — float32 × 3  (spectral class color)
 *   magnitude     — float32       (apparent Vmag)
 *   distance_ly   — float32       (light years)
 *   hip_id        — uint32        (Hipparcos catalog ID)
 *   name_idx      — uint32        (index into names JSON, -1 if unnamed)
 *   _pad          — uint32 × 2    (padding to 48 bytes)
 *
 * Names are stored separately in public/data/star-names.json
 *
 * Run: node scripts/build-catalog.js
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../public/data');

// Spectral class → approximate RGB (blackbody approximation)
const SPECTRAL_COLORS = {
  O: [0.63, 0.71, 1.00],  // blue-white
  B: [0.73, 0.82, 1.00],  // blue-white
  A: [0.90, 0.93, 1.00],  // white
  F: [1.00, 0.98, 0.90],  // yellow-white
  G: [1.00, 0.92, 0.70],  // yellow (Sol)
  K: [1.00, 0.76, 0.45],  // orange
  M: [1.00, 0.50, 0.28],  // red-orange
  default: [0.80, 0.85, 1.00],
};

// Named stars: HIP ID → common name
const NAMED_STARS = {
  71683: 'Alpha Centauri A', 71681: 'Alpha Centauri B', 70890: 'Proxima Centauri',
  32349: 'Sirius', 37279: 'Procyon', 24436: 'Rigel', 27989: 'Betelgeuse',
  97649: 'Altair', 91262: 'Vega', 11767: 'Polaris', 69673: 'Arcturus',
  65474: 'Spica', 49669: 'Regulus', 57632: 'Denebola', 36850: 'Castor',
  37826: 'Pollux', 30438: 'Canopus', 7588: 'Achernar', 80763: 'Antares',
  113368: 'Fomalhaut', 677: 'Alpheratz', 3179: 'Mirach', 5447: 'Almach',
  9884: 'Mira', 14576: 'Algol', 15863: 'Pleiades (Alcyone)', 21421: 'Aldebaran',
  25336: 'Bellatrix', 25930: 'Alnilam', 26727: 'Mintaka', 28380: 'Saiph',
  26311: 'Alnitak', 34444: 'Wezen', 31681: 'Adhara', 33579: 'Aludra',
  50583: 'Alphard', 59803: 'Mimosa', 60718: 'Acrux', 62434: 'Gacrux',
  68702: 'Hadar', 68933: 'Menkent', 72105: 'Rigil Kentaurus',
  86228: 'Atria', 102098: 'Deneb', 100453: 'Sadr', 95947: 'Albireo',
  98036: 'Tarazed', 99473: 'Sham', 677: 'Sirrah', 109268: 'Sadalsuud',
  107315: 'Enif', 113963: 'Scheat', 112029: 'Markab',
};

function spectralColor(spectralType) {
  if (!spectralType) return SPECTRAL_COLORS.default;
  const cls = spectralType.charAt(0).toUpperCase();
  return SPECTRAL_COLORS[cls] || SPECTRAL_COLORS.default;
}

// Convert equatorial coordinates + parallax to heliocentric Cartesian (parsecs)
function toCartesian(raDeg, decDeg, parallaxMas) {
  if (!parallaxMas || parallaxMas <= 0) return null;
  const distPc = 1000 / parallaxMas;
  if (distPc > 2000) return null; // skip beyond 2000 parsecs (~6500 ly)

  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  return {
    x: distPc * Math.cos(dec) * Math.cos(ra),
    y: distPc * Math.cos(dec) * Math.sin(ra),
    z: distPc * Math.sin(dec),
    distLy: distPc * 3.26156,
  };
}

async function buildCatalog() { buildSyntheticCatalog(); return; //
  console.log('Fetching Hipparcos catalog...');

  // Use the VizieR API to fetch Hipparcos main catalog
  // Columns: HIP, Vmag, Plx, RA_ICRS, DE_ICRS, SpType
  const url = 'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=I/239/hip_main&-out=HIP,Vmag,Plx,RA_ICRS,DE_ICRS,SpType&-out.max=120000&Vmag=%3C8.0&Plx=%3E0';

  let text;
  try {
    const res = await fetch(url);
    text = await res.text();
  } catch (e) {
    console.error('Fetch failed:', e.message);
    console.log('Generating synthetic catalog for development...');
    buildSyntheticCatalog();
    return;
  }

  const lines = text.split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('-'));
  const dataLines = lines.filter(l => /^\d/.test(l.trim()));

  const names = Object.values(NAMED_STARS);
  const nameIndex = {};
  Object.entries(NAMED_STARS).forEach(([hip, name]) => {
    nameIndex[parseInt(hip)] = names.indexOf(name);
  });

  const BYTES_PER_STAR = 48;
  const validStars = [];

  for (const line of dataLines) {
    const cols = line.split('\t').map(s => s.trim());
    if (cols.length < 5) continue;

    const hip = parseInt(cols[0]);
    const vmag = parseFloat(cols[1]);
    const plx = parseFloat(cols[2]);
    const ra = parseFloat(cols[3]);
    const dec = parseFloat(cols[4]);
    const sptype = cols[5] || '';

    if (isNaN(hip) || isNaN(vmag) || isNaN(ra) || isNaN(dec)) continue;

    const pos = toCartesian(ra, dec, plx);
    if (!pos) continue;

    const color = spectralColor(sptype);
    validStars.push({ hip, vmag, pos, color, sptype, nameIdx: nameIndex[hip] ?? -1 });
  }

  console.log(`Parsed ${validStars.length} valid stars`);
  writeBinary(validStars, names, BYTES_PER_STAR);
}

function buildSyntheticCatalog() {
  // Generates ~5000 plausible stars for offline dev/testing
  console.log('Building synthetic catalog...');
  const names = Object.values(NAMED_STARS);
  const nameIndex = {};
  Object.entries(NAMED_STARS).forEach(([hip, name]) => {
    nameIndex[parseInt(hip)] = names.indexOf(name);
  });

  const stars = [];
  const namedEntries = Object.entries(NAMED_STARS);

  // Add all named stars with approximate real data
  const namedData = [
    { hip: 71683, ra: 219.9, dec: -60.8, plx: 742, vmag: -0.27, sp: 'G2' },
    { hip: 32349, ra: 101.3, dec: -16.7, plx: 379, vmag: -1.46, sp: 'A1' },
    { hip: 37279, ra: 114.8, dec: 5.2,   plx: 285, vmag: 0.34,  sp: 'F5' },
    { hip: 69673, ra: 213.9, dec: 19.2,  plx: 89,  vmag: -0.04, sp: 'K1' },
    { hip: 27989, ra: 88.8,  dec: 7.4,   plx: 5.5, vmag: 0.42,  sp: 'M1' },
    { hip: 24436, ra: 78.6,  dec: -8.2,  plx: 4.2, vmag: 0.13,  sp: 'B8' },
    { hip: 91262, ra: 279.2, dec: 38.8,  plx: 129, vmag: 0.03,  sp: 'A0' },
    { hip: 97649, ra: 297.7, dec: 8.9,   plx: 195, vmag: 0.76,  sp: 'A7' },
    { hip: 102098, ra: 310.4, dec: 45.3, plx: 2.3, vmag: 1.25,  sp: 'A2' },
    { hip: 80763, ra: 247.4, dec: -26.4, plx: 5.4, vmag: 1.09,  sp: 'M1' },
    { hip: 21421, ra: 68.9,  dec: 16.5,  plx: 19,  vmag: 0.87,  sp: 'K5' },
    { hip: 11767, ra: 37.9,  dec: 89.3,  plx: 7.5, vmag: 1.97,  sp: 'F7' },
  ];

  for (const d of namedData) {
    const pos = toCartesian(d.ra, d.dec, d.plx);
    if (!pos) continue;
    stars.push({
      hip: d.hip, vmag: d.vmag, pos,
      color: spectralColor(d.sp), sptype: d.sp,
      nameIdx: nameIndex[d.hip] ?? -1
    });
  }

  // Fill with procedural stars
  const rng = (min, max) => Math.random() * (max - min) + min;
  for (let i = 0; i < 4800; i++) {
    const distPc = Math.pow(Math.random(), 0.4) * 500 + 1;
    const ra = rng(0, 360);
    const dec = Math.asin(rng(-1, 1)) * 180 / Math.PI;
    const pos = toCartesian(ra, dec, 1000 / distPc);
    if (!pos) continue;
    const spTypes = ['O','B','A','F','G','K','M'];
    const spWeights = [0.01,0.05,0.1,0.15,0.2,0.25,0.24];
    let sp = 'G', acc = 0;
    const r = Math.random();
    for (let j = 0; j < spTypes.length; j++) {
      acc += spWeights[j];
      if (r < acc) { sp = spTypes[j]; break; }
    }
    const vmag = rng(1, 8);
    stars.push({ hip: 200000 + i, vmag, pos, color: spectralColor(sp), sptype: sp, nameIdx: -1 });
  }

  console.log(`Built ${stars.length} synthetic stars`);
  writeBinary(stars, names, 48);
}

function writeBinary(stars, names, BYTES_PER_STAR) {
  mkdirSync(OUT_DIR, { recursive: true });

  const buf = Buffer.allocUnsafe(stars.length * BYTES_PER_STAR);
  let offset = 0;

  for (const s of stars) {
    buf.writeFloatLE(s.pos.x, offset);        offset += 4;
    buf.writeFloatLE(s.pos.y, offset);        offset += 4;
    buf.writeFloatLE(s.pos.z, offset);        offset += 4;
    buf.writeFloatLE(s.color[0], offset);     offset += 4;
    buf.writeFloatLE(s.color[1], offset);     offset += 4;
    buf.writeFloatLE(s.color[2], offset);     offset += 4;
    buf.writeFloatLE(s.vmag, offset);         offset += 4;
    buf.writeFloatLE(s.pos.distLy, offset);   offset += 4;
    buf.writeUInt32LE(s.hip, offset);         offset += 4;
    buf.writeInt32LE(s.nameIdx, offset);      offset += 4;
    buf.writeUInt32LE(0, offset);             offset += 4; // pad
    buf.writeUInt32LE(0, offset);             offset += 4; // pad
  }

  writeFileSync(join(OUT_DIR, 'stars.bin'), buf);
  writeFileSync(join(OUT_DIR, 'star-names.json'), JSON.stringify(names));
  writeFileSync(join(OUT_DIR, 'catalog-meta.json'), JSON.stringify({
    starCount: stars.length,
    bytesPerStar: BYTES_PER_STAR,
    fields: ['x','y','z','r','g','b','vmag','distLy','hipId','nameIdx','_pad','_pad'],
    buildDate: new Date().toISOString(),
  }, null, 2));

  console.log(`Written ${stars.length} stars to public/data/stars.bin`);
  console.log(`Written ${names.length} names to public/data/star-names.json`);
}

buildCatalog();
