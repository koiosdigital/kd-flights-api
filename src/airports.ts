/**
 * IATA airport lookup.
 *
 * The gRPC `FlightDetails` response identifies airports only by FR24-internal
 * numeric ids, but the `LiveFeed` route field carries plain IATA codes. We
 * resolve those to ICAO/name/position from a compact table derived from the
 * public-domain OurAirports dataset (`data/airports-geo.csv`, columns:
 * `iata,icao,name,lat,lon`).
 */

import airportsGeoRaw from '../data/airports-geo.csv'

export interface AirportGeo {
  iata: string
  icao: string | null
  name: string | null
  lat: number | null
  lon: number | null
}

let byIata: Map<string, AirportGeo> | null = null

function build(): Map<string, AirportGeo> {
  const map = new Map<string, AirportGeo>()
  const lines = airportsGeoRaw.split('\n')
  // header: iata,icao,name,lat,lon (name is pre-sanitised to contain no commas)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const f = line.split(',')
    if (f.length < 5) continue
    const iata = f[0]
    if (!iata) continue
    map.set(iata, {
      iata,
      icao: f[1] || null,
      name: f[2] || null,
      lat: f[3] ? Number(f[3]) : null,
      lon: f[4] ? Number(f[4]) : null,
    })
  }
  return map
}

export function lookupAirport(iata: string | null | undefined): AirportGeo | null {
  if (!iata) return null
  if (!byIata) byIata = build()
  return byIata.get(iata.toUpperCase()) ?? null
}
