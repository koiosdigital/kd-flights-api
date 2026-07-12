/**
 * OSM airport surface data — named taxiway centerlines and gate stands — for
 * ground-phase labels ("Taxiing on B", "Holding on N", "At gate H16").
 *
 * FR24's FlightDetails only carries the ARRIVAL gate (schedule_info fields
 * 11/12); there is no departure-gate field in the schema, and taxiway names
 * exist in no aviation dataset we bundle. OpenStreetMap has both:
 * `way[aeroway=taxiway][ref]` centerlines and `node[aeroway=gate][ref]`
 * stands. Bundling them globally is impractical, so airports are fetched from
 * Overpass on demand and cached in KV for 30 days. The fetch runs in the
 * background (waitUntil): the first request for an airport serves unenriched
 * labels and the next poll picks up the names.
 */

import type { KVNamespace, ExecutionContext } from '@cloudflare/workers-types'
import { haversine } from './geojson'

interface TaxiwayWay {
  ref: string
  pts: [number, number][] // [lat, lng]
}

interface GateNode {
  ref: string
  lat: number
  lng: number
}

export interface AirportSurface {
  taxiways: TaxiwayWay[]
  gates: GateNode[]
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const SURFACE_TTL = 30 * 86400 // seconds — OSM airport layouts change rarely
const FETCH_LOCK_TTL = 300     // seconds — rate-limit Overpass attempts per airport
const SEARCH_RADIUS_M = 6000   // from airport reference point; covers the largest fields

const surfaceKey = (icao: string) => `surface:v1:${icao}`
const lockKey = (icao: string) => `surface-fetch:${icao}`

const round5 = (n: number) => Math.round(n * 1e5) / 1e5

async function fetchSurface(lat: number, lng: number): Promise<AirportSurface | null> {
  const query =
    `[out:json][timeout:15];` +
    `(way[aeroway=taxiway][ref](around:${SEARCH_RADIUS_M},${lat},${lng});` +
    `node[aeroway=gate][ref](around:${SEARCH_RADIUS_M},${lat},${lng}););out geom;`
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      // Overpass rejects UA-less requests (406) and its usage policy asks for
      // an identifying agent. Workers send no default User-Agent.
      'user-agent': 'koios-flights-api/1.0 (https://flights-api.koiosdigital.net)',
    },
    body: `data=${encodeURIComponent(query)}`,
  })
  if (!res.ok) {
    console.log(`overpass HTTP ${res.status}`)
    return null
  }
  const json = await res.json() as {
    elements?: {
      type: string
      lat?: number
      lon?: number
      geometry?: { lat: number; lon: number }[]
      tags?: { ref?: string }
    }[]
  }
  if (!Array.isArray(json.elements)) return null

  const taxiways: TaxiwayWay[] = []
  const gates: GateNode[] = []
  for (const el of json.elements) {
    const ref = el.tags?.ref
    if (!ref) continue
    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      taxiways.push({ ref, pts: el.geometry.map((p) => [round5(p.lat), round5(p.lon)]) })
    } else if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      gates.push({ ref, lat: round5(el.lat), lng: round5(el.lon) })
    }
  }
  return { taxiways, gates }
}

/**
 * Cached surface data for an airport, or null when not yet available. A miss
 * kicks off a background Overpass fetch (guarded by a short-lived lock key so
 * bursts don't hammer the API); callers just render without names until the
 * cache is warm.
 */
export async function getAirportSurface(
  kv: KVNamespace,
  icao: string,
  lat: number,
  lng: number,
  ctx: ExecutionContext,
): Promise<AirportSurface | null> {
  const cached = await kv.get(surfaceKey(icao), 'json') as AirportSurface | null
  if (cached) return cached

  ctx.waitUntil((async () => {
    if (await kv.get(lockKey(icao))) return // a recent attempt is in flight / just failed
    await kv.put(lockKey(icao), '1', { expirationTtl: FETCH_LOCK_TTL })
    const surface = await fetchSurface(lat, lng).catch((e) => {
      console.log(`surface fetch threw for ${icao}:`, String(e))
      return null
    })
    if (surface) {
      console.log(`surface cached for ${icao}: ${surface.taxiways.length} taxiways, ${surface.gates.length} gates`)
      await kv.put(surfaceKey(icao), JSON.stringify(surface), { expirationTtl: SURFACE_TTL })
    }
  })())
  return null
}

/** Meters east/north of (lat0, lng0) — flat-earth, fine at airport scale. */
function metersXY(lat0: number, lng0: number, lat: number, lng: number): [number, number] {
  const x = (lng - lng0) * Math.cos(lat0 * Math.PI / 180) * 111320
  const y = (lat - lat0) * 111132
  return [x, y]
}

/** Named taxiway whose centerline passes within `maxM` of the position. */
export function nearestTaxiway(
  surface: AirportSurface,
  lat: number,
  lng: number,
  maxM = 40,
): string | null {
  let best: string | null = null
  let bestD = maxM
  for (const w of surface.taxiways) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const [ax, ay] = metersXY(lat, lng, w.pts[i][0], w.pts[i][1])
      const [bx, by] = metersXY(lat, lng, w.pts[i + 1][0], w.pts[i + 1][1])
      const dx = bx - ax
      const dy = by - ay
      const l2 = dx * dx + dy * dy
      let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(ax + t * dx, ay + t * dy)
      if (d < bestD) {
        bestD = d
        best = w.ref
      }
    }
  }
  return best
}

/**
 * Named gate stand within `maxM` of the parked position. OSM gate nodes sit at
 * the jet bridge / terminal wall while the ADS-B position is the aircraft's
 * GPS antenna, so the own-gate distance runs 40–90 m for large types; 100 m
 * keeps those matched while nearest-node still separates adjacent gates.
 */
export function nearestGate(
  surface: AirportSurface,
  lat: number,
  lng: number,
  maxM = 100,
): string | null {
  let best: string | null = null
  let bestD = maxM
  for (const g of surface.gates) {
    const [x, y] = metersXY(lat, lng, g.lat, g.lng)
    const d = Math.hypot(x, y)
    if (d < bestD) {
      bestD = d
      best = g.ref
    }
  }
  return best
}

/**
 * Upgrade ground-phase labels on a transformed flight result, in place:
 *  - parked without a known gate  → "At gate H16" (nearest OSM stand)
 *  - "Taxiing" / "Holding"        → "Taxiing on B" / "Holding on N"
 * Also sets `phase.gate` / `phase.taxiway` so clients can use the raw values.
 * No-op until the airport's surface data is cached (see getAirportSurface).
 */
export async function enrichGroundPhase(
  result: any,
  kv: KVNamespace,
  ctx: ExecutionContext,
): Promise<void> {
  const phase = result?.phase
  const t = result?.telemetry
  if (!phase || !t?.onGround) return

  const label: string = phase.label ?? ''
  const wantsGate = phase.state === 'parked' && !/^At gate .+/.test(label)
  const wantsTaxiway = phase.state === 'taxiing' && (label === 'Taxiing' || label === 'Holding')
  if (!wantsGate && !wantsTaxiway) return

  // The airport the aircraft is physically at (route endpoints both carry
  // positions; taxiing at neither means diverted or bad data — skip).
  let airport: { icao: string; lat: number; lng: number } | null = null
  for (const ap of [result.route?.origin, result.route?.destination]) {
    const lat = ap?.position?.lat
    const lng = ap?.position?.lng
    if (ap?.icao && typeof lat === 'number' && typeof lng === 'number'
      && haversine(lat, lng, t.latitude, t.longitude) < 10) {
      airport = { icao: ap.icao, lat, lng }
      break
    }
  }
  if (!airport) return

  const surface = await getAirportSurface(kv, airport.icao, airport.lat, airport.lng, ctx)
  if (!surface) return

  if (wantsGate) {
    const gate = nearestGate(surface, t.latitude, t.longitude)
    if (gate) {
      phase.gate = gate
      phase.label = `At gate ${gate}`
    }
  } else {
    const ref = nearestTaxiway(surface, t.latitude, t.longitude)
    if (ref) {
      phase.taxiway = ref
      phase.label = label === 'Holding' ? `Holding on ${ref}` : `Taxiing on ${ref}`
    }
  }
}
