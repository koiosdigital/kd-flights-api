import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  type CloudflareBindings,
  type GeoJSONFeatureCollection,
} from './types'
import { transformFlightDetail, computeObserver, airlineIcaosForIata } from './helpers'
import { enrichGroundPhase } from './taxiways'
import { buildRawDetail, buildRawFromLive } from './adapt'
import { pointInPolygon, haversine } from './geojson'
import { resolveUnitOptions, buildUnitsMeta, convertFlightResult, convertDistanceFromKm } from './units'
import { verifySignature } from './signing'
import {
  liveFeed,
  flightDetails,
  searchFlights,
  liveFlightsByAirline,
  type BoundingBox,
  type LiveFlight,
  type FlightDetailsResult,
} from './grpc'
import { lookupAirport } from './airports'
import openApiSpec from './openapi.yaml'

const CACHE_TTL = 60          // seconds — shared "fresh" cache (KV minimum is 60)
const LAST_GOOD_TTL = 86400   // seconds — stale-while-error fallback window
const WORLD: BoundingBox = { north: 90, south: -90, west: -180, east: 180 }

const app = new Hono<{ Bindings: CloudflareBindings }>()

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowHeaders: ['X-Request-Signature', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'OPTIONS']
}))

// HMAC-SHA256 request signing: clients must sign each /flights request with the
// shared secret and pass the hex digest in X-Request-Signature. Enforcement is
// gated on the ENFORCE_SIGNATURE var — anything but "true" lets requests
// through unverified.
app.use('/flights/*', async (c, next) => {
  if (String(c.env.ENFORCE_SIGNATURE).toLowerCase() !== 'true') {
    return next()
  }

  const secret = c.env.REQUEST_SIGNING_SECRET
  if (!secret) {
    return c.json({ error: 'Request signing is not configured' }, 500)
  }

  // Never verify the CORS preflight — it carries no signature header.
  if (c.req.method === 'OPTIONS') {
    return next()
  }

  const provided = c.req.header('X-Request-Signature')
  if (!provided) {
    return c.json({ error: 'Missing X-Request-Signature header' }, 401)
  }

  const url = new URL(c.req.url)
  const pathWithQuery = url.pathname + url.search
  // Reading the body here caches it, so the route handler's c.req.json() still works.
  const body = c.req.method === 'GET' ? '' : await c.req.text()

  const valid = await verifySignature(secret, provided, c.req.method, pathWithQuery, body)
  if (!valid) {
    return c.json({ error: 'Invalid request signature' }, 401)
  }

  return next()
})

// Global error handler
app.onError((err, c) => {
  return c.text("Oops, something went wrong!", 500)
})

app.get('/', (c) => c.redirect('https://koiosdigital.net/products/matrx?utm_source=flights-api'))

app.get('/swagger.yaml', (c) => {
  return c.body(openApiSpec, 200, { 'Content-Type': 'text/yaml' })
})

app.get('/health', (c) => c.json({ status: 'ok' }))

/**
 * FR24 tracks airport ops/follow-me trucks as pseudo-flights with aircraft
 * type "GRND" (some carry airline-flight-lookalike callsigns such as `AA22`
 * at ORD). Never search, list, or follow them.
 */
const isGroundVehicle = (f: { type?: string | null }) => f.type === 'GRND'

/**
 * Coalesce concurrent upstream rebuilds of the same cache key within this
 * isolate: after a TTL expiry every in-flight request would otherwise fire its
 * own FR24 fetch (cache stampede). First caller runs `fn`; the rest await it.
 */
const inflight = new Map<string, Promise<unknown>>()
function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const p = fn().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Retry an async op a few times; returns null if every attempt throws/empties. */
async function withRetry<T>(fn: () => Promise<T | null>, attempts = 3): Promise<T | null> {
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn()
      if (r !== null) return r
    } catch (e) {
      lastErr = e
    }
  }
  if (lastErr) console.log('withRetry exhausted:', String(lastErr))
  return null
}

/**
 * Airline fleet list for the typeahead's prefix search. Successive keystrokes
 * (`UA9` → `UA96` → `UA962`) all need the same fleet, so cache it per ICAO —
 * each keystroke then costs a KV read plus an in-memory prefix filter instead
 * of a full upstream fleet pull.
 */
async function cachedFleet(kv: KVNamespace, ctx: ExecutionContext, icao: string): Promise<LiveFlight[]> {
  const key = `fleet:${icao}`
  const cached = await kv.get(key, 'json') as LiveFlight[] | null
  if (cached) return cached
  const fleet = await coalesce(key, () => liveFlightsByAirline(icao))
  if (fleet.length > 0) {
    ctx.waitUntil(kv.put(key, JSON.stringify(fleet), { expirationTtl: CACHE_TTL }))
  }
  return fleet
}

/**
 * Live prefix matching for the typeahead. FR24's `flights_list`/`callsigns_list`
 * filters are exact-match only, so for partial input (`UA96`) we parse off the
 * airline designator, pull that airline's live fleet via the airline filter, and
 * prefix-match here — against the IATA number for `UA96`-style queries (which
 * also catches regional feeders like `SKW5328` = `UA5328`) and against the
 * callsign for `UAL96`-style queries.
 */
async function prefixSearchLive(q: string, limit: number, kv: KVNamespace, ctx: ExecutionContext): Promise<LiveFlight[]> {
  const m = q.match(/^([A-Z0-9]{2}|[A-Z]{3})(\d{0,4}[A-Z]?)$/)
  if (!m || /^\d+$/.test(m[1])) return []
  const code = m[1]
  const icaos = code.length === 3 ? [code] : airlineIcaosForIata(code)
  if (icaos.length === 0) return []

  const fleets = await Promise.all(icaos.map((icao) => cachedFleet(kv, ctx, icao).catch(() => [])))
  const matches = fleets.flat().filter(
    (f) => f.flightNumber.startsWith(q) || f.callsign.startsWith(q),
  )
  // Shortest flight number first so UA96 ranks before UA960 while typing
  matches.sort((a, b) => {
    const ka = a.flightNumber || a.callsign
    const kb = b.flightNumber || b.callsign
    return ka.length - kb.length || ka.localeCompare(kb)
  })
  return matches.slice(0, limit)
}

/**
 * Normalize a picker query: trim, uppercase, and strip separators so `ua 962` /
 * `UA-962` match feed values. Also handles a selected flight — the config host
 * then stores the whole option (`{display, text, value}`) and echoes that JSON
 * back as the query, so we extract `value` first (before upper-casing, to keep
 * the JSON keys intact).
 */
function normalizeSearchQuery(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as { value?: unknown }
      if (typeof o.value === 'string') s = o.value
    } catch {
      // not JSON — treat as raw typed text
    }
  }
  return s.trim().toUpperCase().replace(/[\s-]+/g, '')
}

/**
 * Flight-number search for the config picker/typeahead. `query` accepts an IATA
 * flight number (`UA962`) or ICAO callsign (`UAL962`), full or partial. Returns
 * currently-live matches shaped for a picker: `{ value, display, callsign,
 * route }`, where `value` is the callsign the client tracks.
 */
app.get('/flights/search', async (c) => {
  const query = normalizeSearchQuery(c.req.query('query') ?? c.req.query('q') ?? '')
  if (query.length < 2) {
    return c.json({ results: [] })
  }

  // Typeahead fires per keystroke across many devices, so cache the finished
  // result list per normalized query.
  const kv = c.env.CACHE
  const cacheKey = `search:${query}`
  const cachedResults = await kv.get(cacheKey, 'json')
  if (cachedResults) {
    return c.json({ results: cachedResults })
  }

  // Exact filter search catches anything the prefix path can't parse
  const [exact, prefix] = await Promise.all([
    searchFlights(query, 20).catch(() => []),
    prefixSearchLive(query, 20, kv, c.executionCtx).catch(() => []),
  ])
  const seen = new Set<number>()
  const matches = [...exact, ...prefix]
    .filter((f) => !isGroundVehicle(f))
    .filter((f) => (seen.has(f.flightid) ? false : (seen.add(f.flightid), true)))
    .slice(0, 20)
  console.log(`search(${query}): ${exact.length} exact + ${prefix.length} prefix -> ${matches.length}`)
  const results = matches
    .filter((f) => f.callsign) // skip anonymous/blocked entries
    .map((f) => {
      const from = lookupAirport(f.from)
      const to = lookupAirport(f.to)
      const route = f.from && f.to ? `${f.from} → ${f.to}` : ''
      const title = f.flightNumber && f.flightNumber !== f.callsign
        ? `${f.flightNumber} (${f.callsign})`
        : f.callsign
      const parts = [title]
      if (route) parts.push(route)
      if (f.type) parts.push(f.type)
      return {
        // `value` is the stable callsign the client stores and re-searches each
        // render (the hex `id` changes per flight instance / day).
        value: f.callsign,
        display: parts.join('  ·  '),
        callsign: f.callsign,
        flightNumber: f.flightNumber || null,
        id: f.hexId,
        registration: f.reg || null,
        type: f.type || null,
        route: {
          origin: f.from || null,
          originName: from?.name ?? null,
          destination: f.to || null,
          destName: to?.name ?? null,
        },
      }
    })

  c.executionCtx.waitUntil(kv.put(cacheKey, JSON.stringify(results), { expirationTtl: CACHE_TTL }))
  return c.json({ results })
})

app.get('/flights/:id', async (c) => {
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: 'Missing id parameter' }, 400)
  }

  // FR24 flight ids are hex; the gRPC API wants the base-10 fixed32.
  const flightIdNum = parseInt(id, 16)
  if (!Number.isFinite(flightIdNum) || flightIdNum <= 0) {
    return c.json({ error: 'Invalid flight id' }, 400)
  }

  // Optional observer coordinates for bearing/distance computation
  const latParam = c.req.query('lat')
  const lngParam = c.req.query('lng')
  const observerLat = latParam ? parseFloat(latParam) : undefined
  const observerLng = lngParam ? parseFloat(lngParam) : undefined

  if ((observerLat !== undefined) !== (observerLng !== undefined)) {
    return c.json({ error: 'Both lat and lng must be provided' }, 400)
  }
  if (observerLat !== undefined && (isNaN(observerLat) || isNaN(observerLng!))) {
    return c.json({ error: 'lat and lng must be valid numbers' }, 400)
  }

  const unitOpts = resolveUnitOptions(c.req.query('unit'), c.req.query('speed_unit'))

  const kv = c.env.CACHE
  const key = `flight:${id}`
  const lastGoodKey = `flight-lg:${id}`

  // Full upstream rebuild, coalesced so concurrent misses share one FR24
  // fetch. Writes both cache tiers before resolving; returns null when the
  // flight isn't found upstream.
  const rebuild = () => coalesce(key, async () => {
    const fresh = await withRetry(async () => {
      // FlightDetails carries everything except the plain IATA origin/destination
      // codes; a selected-id LiveFeed query is the only source for those.
      const [detail, feed] = await Promise.all([
        flightDetails(flightIdNum),
        liveFeed({ bbox: WORLD, selectedIds: [flightIdNum] }),
      ])
      const route: LiveFlight | null = feed.selected[0] ?? null
      if (detail) {
        const raw = buildRawDetail(id, detail as FlightDetailsResult, route)
        return transformFlightDetail(raw)
      }
      // No FlightDetails (e.g. general-aviation aircraft) — fall back to the live
      // position so the display shows reg/type/telemetry instead of blanking.
      if (route) {
        return transformFlightDetail(buildRawFromLive(id, route))
      }
      return null
    })

    if (fresh) {
      // OSM gate/taxiway names for ground phases ("At gate H16", "Taxiing on
      // B"). No-op until the airport's surface cache is warm, so an unenriched
      // result may get cached — the 60s TTL self-heals on the next rebuild.
      await enrichGroundPhase(fresh, kv, c.executionCtx)
      await Promise.all([
        kv.put(key, JSON.stringify(fresh), { expirationTtl: CACHE_TTL }),
        kv.put(lastGoodKey, JSON.stringify(fresh), { expirationTtl: LAST_GOOD_TTL }),
      ])
    }
    return fresh
  })

  // Base result (without observer) is shared across all users/units.
  let result = await kv.get(key, 'json') as any
  if (!result) {
    // Stale-while-revalidate: serve the last good detail immediately and
    // refresh in the background, so a TTL expiry never blocks the request.
    // The same copy doubles as stale-while-error when FR24 is down.
    result = await kv.get(lastGoodKey, 'json') as any
    if (result) {
      c.executionCtx.waitUntil(rebuild())
    } else {
      // First sight of this flight — nothing to serve until FR24 answers.
      result = await rebuild()
      if (!result) {
        return c.json({ error: 'Flight not found or not live' }, 404)
      }
    }
  }

  // Ground vehicles are never followable, even by direct id (covers fresh,
  // cached, and stale-while-error results alike).
  if (isGroundVehicle({ type: result.aircraft?.typeCode })) {
    return c.json({ error: 'Flight not found or not live' }, 404)
  }

  // Per-request observer data on top of the shared base result
  if (observerLat !== undefined && observerLng !== undefined && result.telemetry) {
    result = {
      ...result,
      ...computeObserver(observerLat, observerLng, result.telemetry.latitude, result.telemetry.longitude, unitOpts),
    }
  }

  // Unit conversion + units metadata
  result = convertFlightResult(result, unitOpts)
  result.units = buildUnitsMeta(unitOpts)

  return c.json(result)
})

app.post('/flights/nearby', async (c) => {
  const unitOpts = resolveUnitOptions(c.req.query('unit'), c.req.query('speed_unit'))

  let body: GeoJSONFeatureCollection
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
    return c.json({ error: 'Expected a GeoJSON FeatureCollection' }, 400)
  }

  const polygonFeature = body.features.find(
    (f) => f.geometry?.type === 'Polygon' || f.properties?.role === 'polygon'
  )
  const pointFeature = body.features.find(
    (f) => f.geometry?.type === 'Point' && f.properties?.role === 'point'
  )

  if (!polygonFeature || polygonFeature.geometry.type !== 'Polygon') {
    return c.json({ error: 'Request must include a Polygon feature' }, 400)
  }

  const rings = polygonFeature.geometry.coordinates as number[][][]
  const outerRing = rings[0]

  // Bounding box from polygon [lng, lat] pairs
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  for (const [lng, lat] of outerRing) {
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
  }
  const bbox: BoundingBox = { north: maxLat, south: minLat, west: minLng, east: maxLng }

  // A single gRPC LiveFeed call covers the whole viewport (no tiling needed):
  // the endpoint returns up to `limit` flights and is reliable, unlike the old
  // JSON feed. Cache the raw flight list per bbox so bursts of device renders
  // share one upstream call, and keep a stale-while-error copy.
  const bboxKey = `feed:${maxLat.toFixed(2)}:${minLat.toFixed(2)}:${minLng.toFixed(2)}:${maxLng.toFixed(2)}`
  const lastGoodKey = `feed-lg:${bboxKey}`

  const kv = c.env.CACHE

  // Coalesced upstream rebuild — concurrent misses on the same bbox (a burst
  // of device renders after TTL expiry) share one FR24 fetch.
  const rebuild = () => coalesce(bboxKey, async () => {
    const feed = await withRetry(async () => {
      const r = await liveFeed({ bbox })
      return r.flights.length > 0 ? r.flights : null
    })
    if (feed) {
      await Promise.all([
        kv.put(bboxKey, JSON.stringify(feed), { expirationTtl: CACHE_TTL }),
        kv.put(lastGoodKey, JSON.stringify(feed), { expirationTtl: LAST_GOOD_TTL }),
      ])
    }
    return feed
  })

  let allFlights = await kv.get(bboxKey, 'json') as LiveFlight[] | null

  if (!allFlights) {
    // Stale-while-revalidate: serve the last good list and refresh in the
    // background; doubles as stale-while-error when FR24 is down.
    allFlights = await kv.get(lastGoodKey, 'json') as LiveFlight[] | null
    if (allFlights) {
      c.executionCtx.waitUntil(rebuild())
    } else {
      allFlights = await rebuild()
    }
  }

  if (!allFlights) return c.json([])

  // Filter to flights actually inside the polygon (cached lists may still
  // contain ground vehicles, so exclude them at read time)
  const flights = allFlights.filter(
    (f) => !isGroundVehicle(f) && pointInPolygon(f.lon, f.lat, outerRing),
  )

  // Blocked callsigns sort to the bottom
  const isBlocked = (cs: string | null) =>
    !cs || /^x{3,}$/i.test(cs) || /blocked/i.test(cs)

  if (pointFeature) {
    const [pLng, pLat] = pointFeature.geometry.coordinates as number[]
    flights.sort((a, b) => {
      const aBlocked = isBlocked(a.callsign)
      const bBlocked = isBlocked(b.callsign)
      if (aBlocked !== bBlocked) return aBlocked ? 1 : -1
      return haversine(pLat, pLng, a.lat, a.lon) - haversine(pLat, pLng, b.lat, b.lon)
    })
  } else {
    flights.sort((a, b) => {
      const aBlocked = isBlocked(a.callsign)
      const bBlocked = isBlocked(b.callsign)
      if (aBlocked !== bBlocked) return aBlocked ? 1 : -1
      return (a.callsign || '').localeCompare(b.callsign || '')
    })
  }

  return c.json(flights.map((f) => ({
    id: f.hexId,
    callsign: f.callsign,
    latitude: f.lat,
    longitude: f.lon,
    ...(pointFeature ? {
      distance: convertDistanceFromKm(
        haversine(
          (pointFeature.geometry.coordinates as number[])[1],
          (pointFeature.geometry.coordinates as number[])[0],
          f.lat,
          f.lon,
        ),
        unitOpts,
      ),
    } : {}),
  })))
})

export default app
