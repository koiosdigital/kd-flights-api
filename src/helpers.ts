import { Flight } from 'flightradarapi'
import airlinesRaw from '../data/airlines.csv'
import airportsRaw from '../data/airports-slim.csv'
import runwaysRaw from '../data/runways-slim.csv'
import { haversine } from './geojson'

const LOGO_BASE = 'https://flightaware.com/images/airline_logos/90p'

interface Airline {
  name: string
  iata: string | null
  icao: string
}

interface Runway {
  ident: string        // e.g. "09L"
  heading: number      // true heading in degrees
  lengthFt: number | null
  surface: string | null
}

interface RunwayResult {
  runway: string         // e.g. "09L"
  heading: number        // runway true heading
  headingDelta: number   // degrees off from aircraft heading
  lengthFt: number | null
  surface: string | null
  reciprocal: string     // the other end, e.g. "27R"
}

// ICAO code → Airline info
let airlinesByIcao: Map<string, Airline> | null = null
// Airport code (IATA/ICAO) → OurAirports ident
let airportCodeToIdent: Map<string, string> | null = null
// OurAirports ident → list of runway ends
let runwaysByAirport: Map<string, { le: Runway; he: Runway }[]> | null = null

function parseAirlinesCsv(csv: string): Map<string, Airline> {
  const map = new Map<string, Airline>()

  for (const line of csv.split('\n')) {
    if (!line.trim()) continue

    // CSV fields: id, name, alias, iata, icao, callsign, country, active
    // Values are quoted with double quotes, \N means null
    const fields = parseCsvLine(line)
    if (fields.length < 8) continue

    const name = fields[1]
    const iata = fields[3] === '\\N' || fields[3] === '' || fields[3] === '-' ? null : fields[3]
    const icao = fields[4] === '\\N' || fields[4] === '' || fields[4] === 'N/A' ? null : fields[4]

    if (!icao) continue

    map.set(icao, { name, iata, icao })
  }

  return map
}

function parseCsvLine(rawLine: string): string[] {
  const line = rawLine.replace(/\r$/, '')
  const fields: string[] = []
  let i = 0

  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      i++
      let value = ''
      while (i < line.length) {
        if (line[i] === '"' && i + 1 < line.length && line[i + 1] === '"') {
          value += '"'
          i += 2
        } else if (line[i] === '"') {
          i++ // closing quote
          break
        } else {
          value += line[i]
          i++
        }
      }
      fields.push(value)
      if (i < line.length && line[i] === ',') i++ // skip comma
    } else {
      // Unquoted field
      let value = ''
      while (i < line.length && line[i] !== ',') {
        value += line[i]
        i++
      }
      fields.push(value)
      if (i < line.length && line[i] === ',') i++
    }
  }

  return fields
}

function getAirlines(): Map<string, Airline> {
  if (!airlinesByIcao) {
    airlinesByIcao = parseAirlinesCsv(airlinesRaw)
  }
  return airlinesByIcao
}

function parseAirportsCsv(csv: string): Map<string, string> {
  const map = new Map<string, string>()
  const lines = csv.split('\n')

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    // Columns: ident, icao_code, iata_code
    const fields = parseCsvLine(line)
    if (fields.length < 3) continue

    const ident = fields[0]
    const icao = fields[1]
    const iata = fields[2]

    // Map both IATA and ICAO codes to the ident used in runways.csv
    if (iata) map.set(iata.toUpperCase(), ident)
    if (icao) map.set(icao.toUpperCase(), ident)
    // ident itself is often the ICAO code, map it too
    map.set(ident.toUpperCase(), ident)
  }

  return map
}

function headingFromDesignator(designator: string): number | null {
  // Extract numeric part: "09L" → 9, "27" → 27, "36" → 36
  const match = designator.match(/^(\d{1,2})/)
  if (!match) return null
  const num = parseInt(match[1], 10)
  if (num < 1 || num > 36) return null
  return num === 36 ? 360 : num * 10
}

function parseRunwaysCsv(csv: string): Map<string, { le: Runway; he: Runway }[]> {
  const map = new Map<string, { le: Runway; he: Runway }[]>()
  const lines = csv.split('\n')

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    // Columns: airport_ident, length_ft, surface, closed, le_ident, le_heading_degT, he_ident, he_heading_degT
    const fields = parseCsvLine(line)
    if (fields.length < 8) continue

    const airportIdent = fields[0]
    const lengthFt = fields[1] ? parseInt(fields[1], 10) || null : null
    const surface = fields[2] || null
    const leIdent = fields[4]
    const leHeadingRaw = fields[5] ? parseFloat(fields[5]) : null
    const heIdent = fields[6]
    const heHeadingRaw = fields[7] ? parseFloat(fields[7]) : null

    if (!leIdent && !heIdent) continue

    const leHeading = leHeadingRaw ?? headingFromDesignator(leIdent)
    const heHeading = heHeadingRaw ?? headingFromDesignator(heIdent)

    if (leHeading === null && heHeading === null) continue

    const pair = {
      le: {
        ident: leIdent,
        heading: leHeading ?? ((heHeading! + 180) % 360),
        lengthFt,
        surface,
      },
      he: {
        ident: heIdent,
        heading: heHeading ?? ((leHeading! + 180) % 360),
        lengthFt,
        surface,
      },
    }

    const list = map.get(airportIdent)
    if (list) list.push(pair)
    else map.set(airportIdent, [pair])
  }

  return map
}

function getAirportLookup(): Map<string, string> {
  if (!airportCodeToIdent) {
    airportCodeToIdent = parseAirportsCsv(airportsRaw)
  }
  return airportCodeToIdent
}

function getRunways(): Map<string, { le: Runway; he: Runway }[]> {
  if (!runwaysByAirport) {
    runwaysByAirport = parseRunwaysCsv(runwaysRaw)
  }
  return runwaysByAirport
}

function headingDelta(a: number, b: number): number {
  let diff = ((a - b) % 360 + 360) % 360
  if (diff > 180) diff = 360 - diff
  return diff
}

/**
 * Takes an airport code (IATA like "JFK" or ICAO like "KJFK"),
 * an aircraft heading in degrees, and optionally coordinates,
 * and returns the most probable runway.
 */
export function lookupRunway(
  airportCode: string,
  heading: number,
): RunwayResult | null {
  if (!airportCode) return null

  const airports = getAirportLookup()
  const ident = airports.get(airportCode.toUpperCase())
  if (!ident) return null

  const runways = getRunways()
  const pairs = runways.get(ident)
  if (!pairs || pairs.length === 0) return null

  let best: RunwayResult | null = null
  let bestDelta = 360

  for (const pair of pairs) {
    for (const end of [pair.le, pair.he] as const) {
      const delta = headingDelta(heading, end.heading)
      if (delta < bestDelta) {
        bestDelta = delta
        const reciprocal = end === pair.le ? pair.he : pair.le
        best = {
          runway: end.ident,
          heading: Math.round(end.heading),
          headingDelta: Math.round(delta),
          lengthFt: end.lengthFt,
          surface: end.surface,
          reciprocal: reciprocal.ident,
        }
      }
    }
  }

  return best
}

export type FlightPhase =
  | 'at_gate'
  | 'taxiing'
  | 'taking_off'
  | 'climbing'
  | 'cruising'
  | 'descending'
  | 'approaching'
  | 'final'
  | 'landed'

export interface FlightPhaseResult {
  phase: FlightPhase
  // Present for approaching & final
  runway?: RunwayResult
  // Present for cruising (from optional schedule inputs)
  departureTime?: number
  arrivalTime?: number
  delayed?: boolean
  delayMinutes?: number
}

export interface FlightPhaseInput {
  heading: number            // degrees
  latitude: number
  longitude: number
  altitude: number           // feet
  groundSpeed: number        // knots
  onGround: boolean
  verticalSpeed: number      // ft/min
  originAirportIata: string
  destinationAirportIata: string
  // Optional schedule data (unix timestamps) from FR24 detail API
  scheduledDeparture?: number | null
  actualDeparture?: number | null
  scheduledArrival?: number | null
  estimatedArrival?: number | null
}

export function inferFlightPhase(input: FlightPhaseInput): FlightPhaseResult {
  const {
    heading, altitude, groundSpeed, onGround, verticalSpeed,
    destinationAirportIata,
    scheduledDeparture, actualDeparture, scheduledArrival, estimatedArrival,
  } = input

  // --- On ground ---
  if (onGround) {
    if (groundSpeed >= 30) {
      // High-speed ground roll — takeoff or landing rollout.
      // If climbing or speed still increasing it's takeoff;
      // otherwise treat as landed (rollout).
      if (verticalSpeed > 0) {
        return { phase: 'taking_off' }
      }
      return { phase: 'landed' }
    }
    return { phase: 'taxiing' }
  }

  // --- Airborne ---

  // Check for final approach first (most specific)
  if (altitude <= 3000 && verticalSpeed < 0 && destinationAirportIata) {
    const runway = lookupRunway(destinationAirportIata, heading)
    if (runway && runway.headingDelta <= 30) {
      return { phase: 'final', runway }
    }
  }

  // Low altitude, descending toward destination
  if (altitude <= 10000 && verticalSpeed < -300 && destinationAirportIata) {
    const runway = lookupRunway(destinationAirportIata, heading)
    return { phase: 'approaching', ...(runway ? { runway } : {}) }
  }

  // Initial climb just after takeoff
  if (altitude < 10000 && verticalSpeed > 300) {
    return { phase: 'taking_off' }
  }

  // Climbing
  if (verticalSpeed > 300) {
    return { phase: 'climbing' }
  }

  // Descending from cruise
  if (verticalSpeed < -300) {
    return { phase: 'descending' }
  }

  // Cruising — stable altitude, include schedule info
  const result: FlightPhaseResult = { phase: 'cruising' }

  const dep = actualDeparture ?? scheduledDeparture
  const arr = estimatedArrival ?? scheduledArrival
  if (dep) result.departureTime = dep
  if (arr) result.arrivalTime = arr

  if (scheduledArrival && estimatedArrival && estimatedArrival > scheduledArrival) {
    result.delayed = true
    result.delayMinutes = Math.round((estimatedArrival - scheduledArrival) / 60)
  } else if (scheduledDeparture && actualDeparture && actualDeparture > scheduledDeparture) {
    result.delayed = true
    result.delayMinutes = Math.round((actualDeparture - scheduledDeparture) / 60)
  } else {
    result.delayed = false
  }

  return result
}

/**
 * Takes a callsign like "AAL1234" and returns the airline name,
 * flight number, and carrier logo URL.
 */
export function lookupCallsign(flight: Flight): {
  airlineName: string
  flightNumber: string
  logoUrl: string
} | null {
  const callsign = flight.callsign?.trim()
  if (!callsign || callsign.length < 4) return null

  // ICAO callsigns: 3-letter airline prefix + numeric flight number
  const icao = flight.airlineIcao;

  const airlines = getAirlines()
  const airline = airlines.get(icao)

  if (!airline) return {
    airlineName: icao,
    flightNumber: callsign,
    logoUrl: `${LOGO_BASE}/generic.png`,
  }

  // Strip ICAO prefix from callsign to get the numeric flight number part
  const flightNumPart = callsign.slice(icao.length)
  const flightNumber = `${airline.name} ${flightNumPart}`

  return {
    airlineName: airline.name,
    flightNumber,
    logoUrl: `${LOGO_BASE}/${icao.toUpperCase()}.png`,
  }
}

// ── Trail analysis ──────────────────────────────────────────────────

export interface TrailPoint {
  lat: number
  lng: number
  alt: number   // feet
  spd: number   // knots ground speed
  ts: number    // unix timestamp
  hd: number    // heading degrees
}

interface TrailAnalysis {
  verticalSpeed: number            // ft/min, computed from recent trail
  acceleration: number             // knots/sec
  headingStable: boolean           // heading std dev < 5° over recent ground points
  stabilizedHeading: number | null // circular mean if stable
  takeoffHeading: number | null    // heading during takeoff roll (if detectable)
  current: TrailPoint
}

function circularMean(headings: number[]): number {
  let sinSum = 0, cosSum = 0
  for (const h of headings) {
    const r = h * Math.PI / 180
    sinSum += Math.sin(r)
    cosSum += Math.cos(r)
  }
  return ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360
}

function headingStdDev(headings: number[]): number {
  if (headings.length < 2) return 0
  let sinSum = 0, cosSum = 0
  for (const h of headings) {
    const r = h * Math.PI / 180
    sinSum += Math.sin(r)
    cosSum += Math.cos(r)
  }
  const R = Math.sqrt(sinSum ** 2 + cosSum ** 2) / headings.length
  if (R >= 1) return 0
  return Math.sqrt(-2 * Math.log(R)) * 180 / Math.PI
}

export function analyzeTrail(trail: TrailPoint[]): TrailAnalysis | null {
  if (!trail || trail.length === 0) return null

  const current = trail[0] // newest point

  // Compute VS and acceleration from the 2 most recent points
  let verticalSpeed = 0
  let acceleration = 0
  if (trail.length >= 2) {
    const prev = trail[1]
    const dtSec = current.ts - prev.ts
    if (dtSec > 0) {
      verticalSpeed = ((current.alt - prev.alt) / dtSec) * 60 // ft/min
      acceleration = (current.spd - prev.spd) / dtSec          // kts/sec
    }
  }

  // Smooth VS over a wider window (up to 5 points, ~2.5 min) for stability
  if (trail.length >= 5) {
    const older = trail[4]
    const dtSec = current.ts - older.ts
    if (dtSec > 0) {
      verticalSpeed = ((current.alt - older.alt) / dtSec) * 60
    }
  }

  // Heading stability: check recent ground-level points
  const groundHeadings: number[] = []
  for (let i = 0; i < Math.min(20, trail.length); i++) {
    if (trail[i].alt === 0 && trail[i].spd >= 20) {
      groundHeadings.push(trail[i].hd)
    }
  }
  const headingStable = groundHeadings.length >= 3 && headingStdDev(groundHeadings) < 5
  const stabilizedHeading = headingStable ? circularMean(groundHeadings) : null

  // Takeoff detection: find the alt 0→non-zero transition (scan full trail)
  let takeoffHeading: number | null = null
  for (let i = 0; i < trail.length - 1; i++) {
    if (trail[i].alt > 0 && trail[i + 1].alt === 0) {
      // Found the transition. Collect the accelerating ground roll headings.
      const rollHeadings: number[] = []
      for (let j = i + 1; j < Math.min(i + 20, trail.length); j++) {
        if (trail[j].alt === 0 && trail[j].spd >= 30) {
          rollHeadings.push(trail[j].hd)
        }
      }
      if (rollHeadings.length >= 2) {
        takeoffHeading = circularMean(rollHeadings)
      } else if (trail[i].alt > 0 && trail[i].alt < 5000) {
        // Use the heading right after liftoff
        takeoffHeading = trail[i].hd
      }
      break
    }
  }

  return {
    verticalSpeed: Math.round(verticalSpeed),
    acceleration,
    headingStable,
    stabilizedHeading: stabilizedHeading !== null ? Math.round(stabilizedHeading) : null,
    takeoffHeading: takeoffHeading !== null ? Math.round(takeoffHeading) : null,
    current,
  }
}

// ── Bearing & direction ─────────────────────────────────────────────

export function computeBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => d * Math.PI / 180
  const dLng = toRad(lng2 - lng1)
  const y = Math.sin(dLng) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
          - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}

function cardinalDirection(bearing: number): string {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                'S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(bearing / 22.5) % 16]
}

export function computeObserver(
  observerLat: number,
  observerLng: number,
  flightLat: number,
  flightLng: number,
) {
  const bearing = computeBearing(observerLat, observerLng, flightLat, flightLng)
  const distKm = haversine(observerLat, observerLng, flightLat, flightLng)
  return {
    observer: {
      bearingFromObserver: Math.round(bearing * 10) / 10,
      distanceKm: Math.round(distKm * 10) / 10,
      distanceNm: Math.round((distKm / 1.852) * 10) / 10,
      cardinalDirection: cardinalDirection(bearing),
    },
  }
}

// ── Enhanced state machine ──────────────────────────────────────────

export type EnhancedFlightPhase =
  | 'parked'
  | 'taxiing'
  | 'takeoff_roll'
  | 'climbing'
  | 'cruising'
  | 'descending'
  | 'approach'
  | 'final_approach'
  | 'landed'

export interface EnhancedPhaseResult {
  state: EnhancedFlightPhase
  label: string
  runway?: RunwayResult
  departureRunway?: RunwayResult
}

function formatAltitude(alt: number): string {
  if (alt >= 18000) return `FL${Math.round(alt / 100)}`
  return `${alt.toLocaleString()} ft`
}

export function inferPhaseFromTrail(
  analysis: TrailAnalysis,
  originIata: string,
  destIata: string,
): EnhancedPhaseResult {
  const { current, verticalSpeed, acceleration, headingStable, stabilizedHeading, takeoffHeading } = analysis
  const { alt, spd, hd } = current
  const onGround = alt === 0

  // Departure runway (retroactive, from trail)
  let departureRunway: RunwayResult | undefined
  if (takeoffHeading !== null && originIata) {
    const rwy = lookupRunway(originIata, takeoffHeading)
    if (rwy && rwy.headingDelta <= 20) departureRunway = rwy
  }

  // ── Ground states ──
  if (onGround) {
    if (spd <= 2) {
      return { state: 'parked', label: 'Parked at gate', departureRunway }
    }
    if (spd >= 30 && acceleration > 0.5 && headingStable) {
      const rwy = lookupRunway(originIata, stabilizedHeading ?? hd)
      const label = rwy && rwy.headingDelta <= 20
        ? `Taking off from runway ${rwy.runway}`
        : 'Taking off'
      return { state: 'takeoff_roll', label, runway: rwy ?? undefined, departureRunway }
    }
    if (spd >= 30 && acceleration <= 0) {
      const rwy = lookupRunway(destIata, hd)
      const label = rwy && rwy.headingDelta <= 20
        ? `Landed on runway ${rwy.runway}`
        : 'Landed'
      return { state: 'landed', label, runway: rwy ?? undefined, departureRunway }
    }
    if (spd >= 30) {
      // Edge case: high speed but ambiguous acceleration
      return verticalSpeed > 0
        ? { state: 'takeoff_roll', label: 'Taking off', departureRunway }
        : { state: 'landed', label: 'Landed', departureRunway }
    }
    return { state: 'taxiing', label: 'Taxiing', departureRunway }
  }

  // ── Airborne states ──

  // Final approach: low, descending, aligned with destination runway
  if (alt <= 3000 && verticalSpeed < 0 && destIata) {
    const rwy = lookupRunway(destIata, hd)
    if (rwy && rwy.headingDelta <= 30) {
      return {
        state: 'final_approach',
        label: `On final for runway ${rwy.runway}`,
        runway: rwy,
        departureRunway,
      }
    }
  }

  // Approach: below 10k, descending toward destination
  if (alt <= 10000 && verticalSpeed < -300 && destIata) {
    const rwy = lookupRunway(destIata, hd)
    return {
      state: 'approach',
      label: `Approaching ${destIata}`,
      ...(rwy ? { runway: rwy } : {}),
      departureRunway,
    }
  }

  // Initial climb (below 10k, climbing)
  if (alt < 10000 && verticalSpeed > 300) {
    return {
      state: 'climbing',
      label: `Climbing through ${formatAltitude(alt)}`,
      departureRunway,
    }
  }

  // Climbing
  if (verticalSpeed > 300) {
    return {
      state: 'climbing',
      label: `Climbing through ${formatAltitude(alt)}`,
      departureRunway,
    }
  }

  // Descending
  if (verticalSpeed < -300) {
    return {
      state: 'descending',
      label: `Descending through ${formatAltitude(alt)}`,
      departureRunway,
    }
  }

  // Cruising
  return {
    state: 'cruising',
    label: `Cruising at ${formatAltitude(alt)}`,
    departureRunway,
  }
}

// ── Flight detail transformer ───────────────────────────────────────

function extractAirport(ap: any) {
  if (!ap) return null
  return {
    iata: ap.code?.iata ?? null,
    icao: ap.code?.icao ?? null,
    name: ap.name ?? null,
    city: ap.position?.region?.city ?? null,
    country: ap.position?.country?.name ?? null,
    position: {
      lat: ap.position?.latitude ?? null,
      lng: ap.position?.longitude ?? null,
      altitudeFt: ap.position?.altitude ?? null,
    },
    timezone: ap.timezone?.name ?? null,
    gate: ap.info?.gate ?? null,
    terminal: ap.info?.terminal ?? null,
  }
}

export function transformFlightDetail(
  raw: any,
  observerLat?: number,
  observerLng?: number,
) {
  // ── Identification ──
  const callsign = raw.identification?.callsign ?? null
  const flightNumber = raw.identification?.number?.default ?? null
  const airlineData = raw.airline ?? {}
  const icao = airlineData.code?.icao ?? ''
  const iata = airlineData.code?.iata ?? ''
  const airlineName = airlineData.name ?? icao

  // Format display name: "UA845" → "United 845"
  let displayName = flightNumber
  if (flightNumber && iata && flightNumber.startsWith(iata)) {
    displayName = `${airlineName} ${flightNumber.slice(iata.length)}`
  }

  // ── Aircraft ──
  const aircraft = raw.aircraft ?? {}
  const mediumImages = aircraft.images?.medium
  const imageUrl = Array.isArray(mediumImages) && mediumImages.length > 0
    ? mediumImages[0].src
    : null

  // ── Route ──
  const origin = extractAirport(raw.airport?.origin)
  const destination = extractAirport(raw.airport?.destination)
  const originIata = origin?.iata ?? ''
  const destIata = destination?.iata ?? ''

  // ── Trail analysis ──
  const trail: TrailPoint[] = raw.trail ?? []
  const analysis = analyzeTrail(trail)

  // ── Telemetry ──
  const current = analysis?.current ?? trail[0]
  const telemetry = current ? {
    latitude: current.lat,
    longitude: current.lng,
    altitude: current.alt,
    groundSpeed: current.spd,
    heading: current.hd,
    verticalSpeed: analysis?.verticalSpeed ?? 0,
    onGround: current.alt === 0,
    timestamp: current.ts,
  } : null

  // ── Observer ──
  let observer: any = undefined
  if (observerLat !== undefined && observerLng !== undefined && current) {
    const bearing = computeBearing(observerLat, observerLng, current.lat, current.lng)
    const distKm = haversine(observerLat, observerLng, current.lat, current.lng)
    observer = {
      bearingFromObserver: Math.round(bearing * 10) / 10,
      distanceKm: Math.round(distKm * 10) / 10,
      distanceNm: Math.round((distKm / 1.852) * 10) / 10,
      cardinalDirection: cardinalDirection(bearing),
    }
  }

  // ── Timing ──
  const time = raw.time ?? {}
  const scheduledDep = time.scheduled?.departure ?? null
  const scheduledArr = time.scheduled?.arrival ?? null
  const actualDep = time.real?.departure ?? null
  const actualArr = time.real?.arrival ?? null
  const estimatedDep = time.estimated?.departure ?? null
  const estimatedArr = time.estimated?.arrival ?? null

  const depDelayMin = (actualDep && scheduledDep && actualDep > scheduledDep)
    ? Math.round((actualDep - scheduledDep) / 60)
    : null
  const arrDelayMin = (estimatedArr && scheduledArr)
    ? Math.round((estimatedArr - scheduledArr) / 60)
    : (actualArr && scheduledArr)
      ? Math.round((actualArr - scheduledArr) / 60)
      : null
  const isDelayed = (depDelayMin !== null && depDelayMin > 0) || (arrDelayMin !== null && arrDelayMin > 0)

  // ── Progress ──
  const dep = actualDep ?? scheduledDep
  const arr = estimatedArr ?? scheduledArr
  const now = current?.ts ?? Math.floor(Date.now() / 1000)
  let fraction = 0
  let elapsedSeconds: number | null = null
  let remainingSeconds: number | null = null

  if (dep && arr && arr > dep) {
    elapsedSeconds = Math.max(0, now - dep)
    remainingSeconds = Math.max(0, arr - now)
    fraction = Math.min(1, Math.max(0, elapsedSeconds / (arr - dep)))
  } else if (origin && destination && current) {
    // Distance-based fallback
    const totalDist = haversine(
      origin.position.lat, origin.position.lng,
      destination.position.lat, destination.position.lng,
    )
    const flownDist = haversine(
      origin.position.lat, origin.position.lng,
      current.lat, current.lng,
    )
    if (totalDist > 0) {
      fraction = Math.min(1, Math.max(0, flownDist / totalDist))
    }
  }

  // ── Phase ──
  let phase: EnhancedPhaseResult = { state: 'cruising', label: 'Unknown' }
  if (analysis) {
    phase = inferPhaseFromTrail(analysis, originIata, destIata)
  }

  return {
    identification: {
      id: raw.identification?.id ?? null,
      callsign,
      flightNumber,
      displayName,
      airline: {
        name: airlineName,
        iata: iata || null,
        icao: icao || null,
        logoUrl: icao ? `${LOGO_BASE}/${icao.toUpperCase()}.png` : `${LOGO_BASE}/generic.png`,
      },
    },
    aircraft: {
      model: aircraft.model?.text ?? null,
      typeCode: aircraft.model?.code ?? null,
      registration: aircraft.registration ?? null,
      hex: aircraft.hex ?? null,
      imageUrl,
    },
    route: { origin, destination },
    telemetry,
    ...(observer ? { observer } : {}),
    timing: {
      scheduled: { departure: scheduledDep, arrival: scheduledArr },
      actual: { departure: actualDep, arrival: actualArr },
      estimated: { departure: estimatedDep, arrival: estimatedArr },
      delay: {
        isDelayed,
        departureDelayMinutes: depDelayMin,
        arrivalDelayMinutes: arrDelayMin,
      },
    },
    progress: {
      fraction: Math.round(fraction * 1000) / 1000,
      percent: Math.round(fraction * 100),
      elapsedSeconds,
      remainingSeconds,
    },
    phase: {
      state: phase.state,
      label: phase.label,
      ...(phase.departureRunway ? {
        departureRunway: {
          designator: phase.departureRunway.runway,
          heading: phase.departureRunway.heading,
          headingDelta: phase.departureRunway.headingDelta,
          reciprocal: phase.departureRunway.reciprocal,
        },
      } : {}),
      ...(phase.runway ? {
        runway: {
          designator: phase.runway.runway,
          heading: phase.runway.heading,
          headingDelta: phase.runway.headingDelta,
          reciprocal: phase.runway.reciprocal,
        },
      } : {}),
    },
    status: {
      live: raw.status?.live ?? false,
      text: raw.status?.text ?? null,
    },
  }
}
