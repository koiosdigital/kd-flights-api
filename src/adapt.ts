/**
 * Adapt FR24 gRPC responses into the legacy "clickhandler JSON" shape that
 * `transformFlightDetail()` consumes. Keeping this adapter — instead of
 * rewriting the transform — guarantees the public `/flights/:id` response shape
 * stays byte-for-byte identical to the pre-gRPC worker, so no client changes.
 */

import { airlineByIcao } from './helpers'
import { lookupAirport } from './airports'
import type { FlightDetailsResult, LiveFlight } from './grpc'

/** First 3 alpha chars of an ICAO callsign are the airline designator. */
function callsignIcao(callsign: string): string {
  const m = /^([A-Z]{3})/.exec(callsign.trim().toUpperCase())
  return m ? m[1] : ''
}

const nz = (n: number): number | null => (n ? n : null)

function airportRaw(
  iata: string,
  gate: string | null,
  terminal: string | null,
): unknown {
  if (!iata) return null
  const geo = lookupAirport(iata)
  return {
    code: { iata, icao: geo?.icao ?? null },
    name: geo?.name ?? null,
    position: {
      latitude: geo?.lat ?? null,
      longitude: geo?.lon ?? null,
      altitude: null,
      region: { city: null },
      country: { name: null },
    },
    timezone: { name: null },
    info: { gate, terminal },
  }
}

/**
 * Build the clickhandler-shaped `raw` object.
 *
 * @param detail  decoded `FlightDetails` response
 * @param route   the same flight from a `selected_flight_ids` LiveFeed query,
 *                which is the only place the plain IATA origin/destination codes
 *                appear (FlightDetails only carries numeric FR24 airport ids)
 */
export function buildRawDetail(
  hexId: string,
  detail: FlightDetailsResult,
  route: LiveFlight | null,
): unknown {
  const callsign = detail.callsign || route?.callsign || ''
  const icao = callsignIcao(callsign)
  const airline = airlineByIcao(icao)

  // Reconstruct the newest-first trail the transform expects, seeding it with
  // the authoritative current position from flight_info.
  const points = detail.trail.map((t) => ({
    lat: t.lat,
    lng: t.lon,
    alt: t.alt,
    spd: t.spd,
    ts: t.ts,
    hd: t.heading,
  }))
  if (detail.lat || detail.lon) {
    points.push({
      lat: detail.lat,
      lng: detail.lon,
      alt: detail.onGround ? 0 : detail.alt,
      spd: detail.speed,
      ts: Math.round(detail.timestampMs / 1000) || Math.floor(Date.now() / 1000),
      hd: detail.track,
    })
  }
  points.sort((a, b) => b.ts - a.ts) // newest first

  const fromIata = route?.from ?? ''
  const toIata = route?.to ?? ''
  const eta = detail.eta || route?.eta || 0

  return {
    identification: {
      id: hexId,
      callsign,
      number: { default: detail.flightNumber || null },
    },
    airline: {
      name: detail.registeredOwners || airline?.name || icao || null,
      code: { iata: airline?.iata ?? null, icao: icao || null },
    },
    aircraft: {
      model: {
        text: detail.fullDescription || null,
        code: detail.type || null,
      },
      registration: detail.reg || null,
      hex: detail.hex || null,
      images: detail.imageUrl ? { medium: [{ src: detail.imageUrl }] } : undefined,
    },
    airport: {
      origin: airportRaw(fromIata, null, null),
      destination: airportRaw(toIata, detail.arrGate || null, detail.arrTerminal || null),
    },
    trail: points,
    time: {
      scheduled: { departure: nz(detail.scheduledDeparture), arrival: nz(detail.scheduledArrival) },
      real: { departure: nz(detail.actualDeparture), arrival: nz(detail.actualArrival) },
      estimated: { departure: null, arrival: nz(eta) },
    },
    status: {
      live: true,
      text: null,
    },
  }
}

/**
 * Minimal `raw` built from a LiveFeed record alone, for flights that have no
 * `FlightDetails` (typically general-aviation / private aircraft: FR24 returns
 * an empty frame for them). Yields registration, type, live telemetry and route
 * if present — enough to render instead of blanking the display.
 */
export function buildRawFromLive(hexId: string, live: LiveFlight): unknown {
  const icao = callsignIcao(live.callsign)
  const airline = airlineByIcao(icao)
  const ts = Math.round(live.timestampMs / 1000) || Math.floor(Date.now() / 1000)

  return {
    identification: {
      id: hexId,
      callsign: live.callsign,
      number: { default: null },
    },
    airline: {
      name: airline?.name || (icao || null),
      code: { iata: airline?.iata ?? null, icao: icao || null },
    },
    aircraft: {
      model: { text: live.type || null, code: live.type || null },
      registration: live.reg || null,
      hex: null,
      images: undefined,
    },
    airport: {
      origin: airportRaw(live.from, null, null),
      destination: airportRaw(live.to, null, null),
    },
    trail: [{
      lat: live.lat,
      lng: live.lon,
      alt: live.onGround ? 0 : live.alt,
      spd: live.speed,
      ts,
      hd: live.track,
    }],
    time: {
      scheduled: { departure: null, arrival: null },
      real: { departure: null, arrival: null },
      estimated: { departure: null, arrival: nz(live.eta) },
    },
    status: { live: true, text: null },
  }
}
