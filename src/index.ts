import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Flight, FlightRadar24API } from 'flightradarapi'
import {
  type CloudflareBindings,
  type GeoJSONFeatureCollection,
} from './types'
import { transformFlightDetail, computeObserver } from './helpers'
import { pointInPolygon, haversine } from './geojson'
import { resolveUnitOptions, buildUnitsMeta, convertFlightResult, convertDistanceFromKm } from './units'
import { verifySignature } from './signing'
import openApiSpec from './openapi.yaml'

const CACHE_TTL = 60  // seconds (KV minimum is 60)
const TILE_DEG = 5    // degrees per grid tile
const MAX_TILES = 12  // cap parallel FR24 calls for large viewports

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

app.get('/flights/:id', async (c) => {
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: 'Missing id parameter' }, 400)
  }

  // Optional observer coordinates for bearing computation
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

  // Unit options
  const unitOpts = resolveUnitOptions(c.req.query('unit'), c.req.query('speed_unit'))

  const kv = c.env.CACHE
  const key = `flight:${id}`

  // Cache the base response (without observer) so all users share the same entry
  let result = await kv.get(key, 'json') as any
  if (!result) {
    const api = new FlightRadar24API()
    const raw = await api.getFlightDetails({ id } as Flight)
    result = transformFlightDetail(raw)
    c.executionCtx.waitUntil(kv.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL }))
  }

  // Compute per-request observer data on top of the cached result
  if (observerLat !== undefined && observerLng !== undefined && result.telemetry) {
    result = {
      ...result,
      ...computeObserver(observerLat, observerLng, result.telemetry.latitude, result.telemetry.longitude, unitOpts),
    }
  }

  // Apply unit conversion and attach units metadata
  result = convertFlightResult(result, unitOpts)
  result.units = buildUnitsMeta(unitOpts)

  return c.json(result)
})

/**
 * Compute aligned grid tiles that cover the given bounding box.
 * Each tile is TILE_DEG × TILE_DEG degrees, snapped to a global grid.
 * Overlapping requests from different users share cached tiles.
 */
function tileBounds(north: number, south: number, west: number, east: number) {
  const tiles: { bounds: string; key: string }[] = []
  const latStart = Math.floor(south / TILE_DEG) * TILE_DEG
  const lngStart = Math.floor(west / TILE_DEG) * TILE_DEG

  for (let lat = latStart; lat < north; lat += TILE_DEG) {
    for (let lng = lngStart; lng < east; lng += TILE_DEG) {
      const n = lat + TILE_DEG
      const s = lat
      const w = lng
      const e = lng + TILE_DEG
      tiles.push({
        bounds: `${n},${s},${w},${e}`,
        key: `tile:${n}:${s}:${w}:${e}`,
      })
    }
  }
  return tiles
}

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

  // Compute bounding box from polygon [lng, lat] pairs
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  for (const [lng, lat] of outerRing) {
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
  }

  try {
    const kv = c.env.CACHE
    const api = new FlightRadar24API()
    const tiles = tileBounds(maxLat, minLat, minLng, maxLng)

    let allFlights: any[]

    if (tiles.length > MAX_TILES) {
      // Very large area — single uncached request to avoid excessive FR24 calls
      const bounds = `${maxLat},${minLat},${minLng},${maxLng}`
      allFlights = await api.getFlights(null, bounds)
    } else {
      // Fetch tiles in parallel, each independently cached
      const results = await Promise.all(
        tiles.map(async ({ bounds, key }) => {
          const cached = await kv.get(key, 'json') as any[] | null
          if (cached) return cached

          const flights = await api.getFlights(null, bounds)
          c.executionCtx.waitUntil(
            kv.put(key, JSON.stringify(flights), { expirationTtl: CACHE_TTL })
          )
          return flights
        })
      )

      // Merge + deduplicate flights across tile boundaries
      const seen = new Set<string>()
      allFlights = []
      for (const flights of results) {
        for (const f of flights as any[]) {
          if (!seen.has(f.id)) {
            seen.add(f.id)
            allFlights.push(f)
          }
        }
      }
    }

    // Filter to flights actually inside the polygon
    const flights = allFlights.filter((f: any) =>
      pointInPolygon(f.longitude, f.latitude, outerRing)
    )

    // Blocked callsigns sort to the bottom
    const isBlocked = (cs: string | null) =>
      !cs || /^x{3,}$/i.test(cs) || /blocked/i.test(cs)

    // Sort by distance to point if provided, otherwise by callsign
    if (pointFeature) {
      const [pLng, pLat] = pointFeature.geometry.coordinates as number[]
      flights.sort((a: any, b: any) => {
        const aBlocked = isBlocked(a.callsign)
        const bBlocked = isBlocked(b.callsign)
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1
        return haversine(pLat, pLng, a.latitude, a.longitude) - haversine(pLat, pLng, b.latitude, b.longitude)
      })
    } else {
      flights.sort((a: any, b: any) => {
        const aBlocked = isBlocked(a.callsign)
        const bBlocked = isBlocked(b.callsign)
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1
        return (a.callsign || '').localeCompare(b.callsign || '')
      })
    }

    return c.json(flights.map((f: any) => ({
      id: f.id,
      callsign: f.callsign,
      latitude: f.latitude,
      longitude: f.longitude,
      ...(pointFeature ? {
        distance: convertDistanceFromKm(
          haversine(
            (pointFeature.geometry.coordinates as number[])[1],
            (pointFeature.geometry.coordinates as number[])[0],
            f.latitude,
            f.longitude,
          ),
          unitOpts,
        ),
      } : {}),
    })))
  } catch (err) {
    return c.json(err, 500)
  }
})

export default app
