import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  type CloudflareBindings,
  type GeoJSONFeatureCollection,
} from './types'
import { transformFlightDetail, computeObserver } from './helpers'
import { buildRawDetail, buildRawFromLive } from './adapt'
import { pointInPolygon, haversine } from './geojson'
import { resolveUnitOptions, buildUnitsMeta, convertFlightResult, convertDistanceFromKm } from './units'
import { verifySignature } from './signing'
import {
  liveFeed,
  flightDetails,
  type BoundingBox,
  type LiveFlight,
  type FlightDetailsResult,
} from './grpc'
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
// shared secret and pass the hex digest in X-Request-Signature.
app.use('/flights/*', async (c, next) => {
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

  // Base result (without observer) is shared across all users/units.
  let result = await kv.get(key, 'json') as any
  if (!result) {
    result = await withRetry(async () => {
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

    if (result) {
      c.executionCtx.waitUntil(Promise.all([
        kv.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL }),
        kv.put(lastGoodKey, JSON.stringify(result), { expirationTtl: LAST_GOOD_TTL }),
      ]))
    } else {
      // Stale-while-error: FR24 momentarily failed — serve the last good detail
      // rather than a 500, so the display never blanks for a live flight.
      result = await kv.get(lastGoodKey, 'json') as any
      if (!result) {
        return c.json({ error: 'Flight not found or not live' }, 404)
      }
    }
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
  let allFlights = await kv.get(bboxKey, 'json') as LiveFlight[] | null

  if (!allFlights) {
    const feed = await withRetry(async () => {
      const r = await liveFeed({ bbox })
      return r.flights.length > 0 ? r.flights : null
    })
    if (feed) {
      allFlights = feed
      c.executionCtx.waitUntil(Promise.all([
        kv.put(bboxKey, JSON.stringify(feed), { expirationTtl: CACHE_TTL }),
        kv.put(lastGoodKey, JSON.stringify(feed), { expirationTtl: LAST_GOOD_TTL }),
      ]))
    } else {
      // Stale-while-error rather than returning an empty list.
      allFlights = await kv.get(lastGoodKey, 'json') as LiveFlight[] | null
    }
  }

  if (!allFlights) return c.json([])

  // Filter to flights actually inside the polygon
  const flights = allFlights.filter((f) => pointInPolygon(f.lon, f.lat, outerRing))

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
