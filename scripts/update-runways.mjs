// Regenerate data/runways-slim.csv from the OurAirports runways dataset.
// Keeps length/width/surface/closed plus per-end ident, true heading, and
// threshold coordinates (used for position-based runway occupancy tests).
//
//   node scripts/update-runways.mjs
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv'
const OUT = fileURLToPath(new URL('../data/runways-slim.csv', import.meta.url))

function parseCsvLine(rawLine) {
  const line = rawLine.replace(/\r$/, '')
  const fields = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      i++
      let value = ''
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { value += '"'; i += 2 }
        else if (line[i] === '"') { i++; break }
        else { value += line[i]; i++ }
      }
      fields.push(value)
      if (line[i] === ',') i++
    } else {
      let value = ''
      while (i < line.length && line[i] !== ',') { value += line[i]; i++ }
      fields.push(value)
      if (line[i] === ',') i++
    }
  }
  return fields
}

const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
const raw = await res.text()

const lines = raw.split('\n')
const header = parseCsvLine(lines[0])
const col = Object.fromEntries(header.map((h, i) => [h, i]))

const q = (s) => (s.includes(',') || s.includes('"')) ? `"${s.replace(/"/g, '""')}"` : s
const coord = (s) => {
  if (!s) return ''
  const n = parseFloat(s)
  return Number.isFinite(n) ? String(Math.round(n * 1e5) / 1e5) : ''
}

const out = ['airport_ident,length_ft,width_ft,surface,closed,le_ident,le_heading_degT,le_latitude_deg,le_longitude_deg,he_ident,he_heading_degT,he_latitude_deg,he_longitude_deg']
let rows = 0, withCoords = 0
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue
  const f = parseCsvLine(lines[i])
  const g = (name) => f[col[name]] ?? ''
  const row = [
    q(g('airport_ident')),
    g('length_ft'),
    g('width_ft'),
    q(g('surface')),
    g('closed'),
    q(g('le_ident')),
    g('le_heading_degT'),
    coord(g('le_latitude_deg')),
    coord(g('le_longitude_deg')),
    q(g('he_ident')),
    g('he_heading_degT'),
    coord(g('he_latitude_deg')),
    coord(g('he_longitude_deg')),
  ]
  out.push(row.join(','))
  rows++
  if (row[7] && row[8] && row[11] && row[12]) withCoords++
}
writeFileSync(OUT, out.join('\n') + '\n')
console.log(`wrote ${OUT}: ${rows} runways, ${withCoords} with both-end coordinates`)
