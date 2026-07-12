/**
 * FR24 gRPC-web transport.
 *
 * FR24 has migrated its live data from the flaky JSON `feed.js` / `clickhandler`
 * endpoints to a gRPC-web Feed service at `data-feed.flightradar24.com`. The
 * gRPC service is dramatically more reliable (it does not return the empty
 * `{full_count, stats}` stub that the JSON feed serves under load), works
 * anonymously, and returns route/registration/type inline.
 *
 * This module implements just enough of protobuf + the gRPC-web framing to call
 * two methods — `LiveFeed` (bounding-box query, optionally for specific flight
 * ids) and `FlightDetails` — and decode their responses. Protobuf field numbers
 * mirror the schema reverse-engineered by github.com/abc8747/fr24 (see
 * `proto/_common.proto`, `_live_feed.proto`, `_flight_details.proto`).
 *
 * No codegen: the messages we need are small and stable, so we hand-encode
 * requests and walk the wire format for responses.
 */

const GRPC_BASE = 'https://data-feed.flightradar24.com/fr24.feed.api.v1.Feed'

const GRPC_HEADERS: Record<string, string> = {
  'content-type': 'application/grpc-web+proto',
  accept: 'application/grpc-web+proto',
  'x-user-agent': 'grpc-web-javascript/0.1',
  'x-grpc-web': '1',
  'fr24-platform': 'web-25.061.0929',
  'fr24-device-id': 'web-000000000-000000000000000000000',
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
  origin: 'https://www.flightradar24.com',
  referer: 'https://www.flightradar24.com/',
}

// ── protobuf wire encoding ──────────────────────────────────────────

class Writer {
  private bytes: number[] = []

  private varint(n: number): void {
    let v = n >>> 0 === n ? n : n // keep as JS number; values here fit in 53 bits
    let big = BigInt(v)
    while (big > 127n) {
      this.bytes.push(Number((big & 127n) | 128n))
      big >>= 7n
    }
    this.bytes.push(Number(big))
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire)
  }

  varintField(field: number, value: number): this {
    this.tag(field, 0)
    this.varint(value)
    return this
  }

  boolField(field: number, value: boolean): this {
    return this.varintField(field, value ? 1 : 0)
  }

  floatField(field: number, value: number): this {
    this.tag(field, 5)
    const buf = new ArrayBuffer(4)
    new DataView(buf).setFloat32(0, value, true)
    for (const b of new Uint8Array(buf)) this.bytes.push(b)
    return this
  }

  fixed32Field(field: number, value: number): this {
    this.tag(field, 5)
    const buf = new ArrayBuffer(4)
    new DataView(buf).setUint32(0, value >>> 0, true)
    for (const b of new Uint8Array(buf)) this.bytes.push(b)
    return this
  }

  stringField(field: number, value: string): this {
    return this.bytesField(field, new TextEncoder().encode(value))
  }

  bytesField(field: number, value: Uint8Array | number[]): this {
    this.tag(field, 2)
    this.varint(value.length)
    for (const b of value) this.bytes.push(b)
    return this
  }

  messageField(field: number, inner: Writer): this {
    return this.bytesField(field, inner.finish())
  }

  packedVarint(field: number, values: number[]): this {
    const inner = new Writer()
    for (const v of values) inner.varint(v)
    return this.bytesField(field, inner.finish())
  }

  finish(): number[] {
    return this.bytes
  }
}

// ── protobuf wire decoding ──────────────────────────────────────────

export interface DecodedField {
  wire: number
  /** varint value (wire 0) */
  int?: bigint
  /** raw bytes (wire 2) or 4/8-byte fixed (wire 5/1) */
  bytes?: Uint8Array
}

/** Decode a protobuf message into a map of field number → occurrences. */
export function decode(buf: Uint8Array): Map<number, DecodedField[]> {
  const out = new Map<number, DecodedField[]>()
  let p = 0
  const readVarint = (): bigint => {
    let shift = 0n
    let res = 0n
    let b: number
    do {
      b = buf[p++]
      res |= BigInt(b & 127) << shift
      shift += 7n
    } while (b & 128)
    return res
  }
  while (p < buf.length) {
    const key = readVarint()
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    let entry: DecodedField
    if (wire === 0) {
      entry = { wire, int: readVarint() }
    } else if (wire === 5) {
      entry = { wire, bytes: buf.subarray(p, p + 4) }
      p += 4
    } else if (wire === 1) {
      entry = { wire, bytes: buf.subarray(p, p + 8) }
      p += 8
    } else if (wire === 2) {
      const len = Number(readVarint())
      entry = { wire, bytes: buf.subarray(p, p + len) }
      p += len
    } else {
      throw new Error(`unsupported wire type ${wire}`)
    }
    const arr = out.get(field)
    if (arr) arr.push(entry)
    else out.set(field, [entry])
  }
  return out
}

// typed accessors over a decoded message
const first = (m: Map<number, DecodedField[]>, f: number): DecodedField | undefined =>
  m.get(f)?.[0]

export const getInt = (m: Map<number, DecodedField[]>, f: number): number => {
  const v = first(m, f)
  return v?.int !== undefined ? Number(v.int) : 0
}
export const getBool = (m: Map<number, DecodedField[]>, f: number): boolean =>
  getInt(m, f) !== 0
export const getFloat = (m: Map<number, DecodedField[]>, f: number): number => {
  const v = first(m, f)
  if (!v?.bytes) return 0
  return new DataView(v.bytes.buffer, v.bytes.byteOffset, 4).getFloat32(0, true)
}
export const getString = (m: Map<number, DecodedField[]>, f: number): string => {
  const v = first(m, f)
  return v?.bytes ? new TextDecoder().decode(v.bytes) : ''
}
export const getMessage = (
  m: Map<number, DecodedField[]>,
  f: number,
): Map<number, DecodedField[]> | null => {
  const v = first(m, f)
  return v?.bytes ? decode(v.bytes) : null
}
export const getRepeated = (m: Map<number, DecodedField[]>, f: number): DecodedField[] =>
  m.get(f) ?? []

// ── gRPC-web framing ────────────────────────────────────────────────

function frame(msg: number[]): Uint8Array {
  const out = new Uint8Array(5 + msg.length)
  out[0] = 0 // no compression
  new DataView(out.buffer).setUint32(1, msg.length, false) // big-endian length
  out.set(msg, 5)
  return out
}

/** Extract the first DATA frame (flag 0x00) from a gRPC-web response body. */
function unframe(buf: Uint8Array): Uint8Array | null {
  let p = 0
  while (p + 5 <= buf.length) {
    const flag = buf[p]
    const len = new DataView(buf.buffer, buf.byteOffset + p + 1, 4).getUint32(0, false)
    const payload = buf.subarray(p + 5, p + 5 + len)
    p += 5 + len
    if (flag === 0) return payload // DATA frame; flag 0x80 is trailers
  }
  return null
}

export class GrpcError extends Error {}

async function callFeed(method: string, msg: number[]): Promise<Uint8Array | null> {
  const res = await fetch(`${GRPC_BASE}/${method}`, {
    method: 'POST',
    headers: GRPC_HEADERS,
    body: frame(msg),
  })
  if (res.status !== 200) {
    throw new GrpcError(`${method} HTTP ${res.status}`)
  }
  const grpcStatus = res.headers.get('grpc-status')
  if (grpcStatus && grpcStatus !== '0') {
    throw new GrpcError(`${method} grpc-status ${grpcStatus}`)
  }
  const body = new Uint8Array(await res.arrayBuffer())
  return unframe(body)
}

// ── LiveFeed ────────────────────────────────────────────────────────

export interface BoundingBox {
  north: number
  south: number
  west: number
  east: number
}

/** One flight as returned by LiveFeed (subset of `_common.Flight`). */
export interface LiveFlight {
  flightid: number
  hexId: string
  lat: number
  lon: number
  track: number
  alt: number
  speed: number
  onGround: boolean
  callsign: string
  timestampMs: number
  reg: string
  type: string
  from: string
  to: string
  vspeed: number
  eta: number
}

function parseFlight(m: Map<number, DecodedField[]>): LiveFlight {
  // _common.Flight
  const flightid = getInt(m, 1)
  const extra = getMessage(m, 13) // ExtraFlightInfo
  let reg = '', type = '', from = '', to = '', vspeed = 0, eta = 0
  if (extra) {
    reg = getString(extra, 2)
    type = getString(extra, 4)
    vspeed = getInt(extra, 6)
    const route = getMessage(extra, 3)
    if (route) {
      from = getString(route, 1)
      to = getString(route, 2)
    }
    const schedule = getMessage(extra, 9)
    if (schedule) eta = getInt(schedule, 5)
  }
  // timestamp_ms is field 15 (uint64); fall back to timestamp (9, seconds)
  const tsMs = getInt(m, 15) || getInt(m, 9) * 1000
  return {
    flightid,
    hexId: (flightid >>> 0).toString(16),
    lat: getFloat(m, 2),
    lon: getFloat(m, 3),
    track: getInt(m, 4),
    alt: getInt(m, 5),
    speed: getInt(m, 6),
    onGround: getBool(m, 10),
    callsign: getString(m, 11),
    timestampMs: tsMs,
    reg,
    type,
    from,
    to,
    vspeed,
    eta,
  }
}

function buildLiveFeedRequest(opts: {
  bbox: BoundingBox
  limit?: number
  maxage?: number
  selectedIds?: number[]
}): number[] {
  const bounds = new Writer()
    .floatField(1, opts.bbox.north)
    .floatField(2, opts.bbox.south)
    .floatField(3, opts.bbox.west)
    .floatField(4, opts.bbox.east)

  // VisibilitySettings: all data sources (0..9), all services (0..11), ALL traffic
  const settings = new Writer()
    .packedVarint(1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    .packedVarint(2, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    .varintField(3, 3) // TrafficType.ALL

  // FieldMask: the 4 fields available to unauthenticated users
  const fieldMask = new Writer()
    .stringField(1, 'flight')
    .stringField(1, 'reg')
    .stringField(1, 'route')
    .stringField(1, 'type')

  const req = new Writer()
    .messageField(1, bounds)
    .messageField(2, settings)
    .varintField(7, opts.limit ?? 1500)
    .varintField(8, opts.maxage ?? 14400)
    .messageField(10, fieldMask)

  for (const id of opts.selectedIds ?? []) {
    req.fixed32Field(11, id) // selected_flight_ids_list
  }
  return req.finish()
}

export interface LiveFeedResult {
  flights: LiveFlight[]
  selected: LiveFlight[]
}

const WORLD: BoundingBox = { north: 90, south: -90, west: -180, east: 180 }

function searchWorldBase(): Writer[] {
  const bounds = new Writer()
    .floatField(1, WORLD.north)
    .floatField(2, WORLD.south)
    .floatField(3, WORLD.west)
    .floatField(4, WORLD.east)
  const settings = new Writer()
    .packedVarint(1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    .packedVarint(2, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    .varintField(3, 3)
  const fieldMask = new Writer()
    .stringField(1, 'flight')
    .stringField(1, 'reg')
    .stringField(1, 'route')
    .stringField(1, 'type')
  return [bounds, settings, fieldMask]
}

async function feedWithFilter(filter: Writer, limit: number): Promise<LiveFlight[]> {
  const [bounds, settings, fieldMask] = searchWorldBase()
  const req = new Writer()
    .messageField(1, bounds)
    .messageField(2, settings)
    .messageField(3, filter)
    .varintField(7, limit)
    .varintField(8, 14400)
    .messageField(10, fieldMask)
    .finish()
  const payload = await callFeed('LiveFeed', req)
  if (!payload) return []
  return getRepeated(decode(payload), 1).map((f) => parseFlight(decode(f.bytes!)))
}

/**
 * Search live flights by IATA flight number (`UA962`) or ICAO callsign
 * (`UAL962`). FR24's LiveFeed `Filter` matches `flights_list` (field 8) against
 * IATA numbers and `callsigns_list` (field 4) against ICAO callsigns — but
 * multiple filter fields are AND-ed, so we fire the two forms as separate
 * queries in parallel and merge, deduping by flight id.
 */
export async function searchFlights(query: string, limit = 20): Promise<LiveFlight[]> {
  const q = query.trim().toUpperCase()
  if (!q) return []

  const [byCallsign, byNumber] = await Promise.all([
    feedWithFilter(new Writer().stringField(4, q), limit).catch(() => []),
    feedWithFilter(new Writer().stringField(8, q), limit).catch(() => []),
  ])

  const seen = new Set<number>()
  const out: LiveFlight[] = []
  for (const flight of [...byCallsign, ...byNumber]) {
    if (!seen.has(flight.flightid)) {
      seen.add(flight.flightid)
      out.push(flight)
    }
  }
  return out.slice(0, limit)
}

export async function liveFeed(opts: {
  bbox: BoundingBox
  limit?: number
  maxage?: number
  selectedIds?: number[]
}): Promise<LiveFeedResult> {
  const payload = await callFeed('LiveFeed', buildLiveFeedRequest(opts))
  if (!payload) return { flights: [], selected: [] }
  const top = decode(payload)
  return {
    flights: getRepeated(top, 1).map((f) => parseFlight(decode(f.bytes!))),
    selected: getRepeated(top, 3).map((f) => parseFlight(decode(f.bytes!))),
  }
}

// ── FlightDetails ───────────────────────────────────────────────────

export interface TrailPointGrpc {
  ts: number
  lat: number
  lon: number
  alt: number
  spd: number
  heading: number
  vspd: number
}

export interface FlightDetailsResult {
  // aircraft_info
  hex: string
  reg: string
  type: string
  fullDescription: string
  registeredOwners: string
  imageUrl: string | null
  // schedule_info
  flightNumber: string
  scheduledDeparture: number
  scheduledArrival: number
  actualDeparture: number
  actualArrival: number
  arrTerminal: string
  arrGate: string
  // flight_progress
  eta: number
  flightStage: number
  progressPct: number
  // flight_info (current position)
  flightid: number
  lat: number
  lon: number
  track: number
  alt: number
  speed: number
  vspeed: number
  onGround: boolean
  callsign: string
  timestampMs: number
  // trail
  trail: TrailPointGrpc[]
}

function parseFlightDetails(payload: Uint8Array): FlightDetailsResult {
  const m = decode(payload)
  const ac = getMessage(m, 1) // AircraftInfo
  const sch = getMessage(m, 2) // ScheduleInfo
  const prog = getMessage(m, 3) // FlightProgress
  const info = getMessage(m, 4) // ExtendedFlightInfo

  let imageUrl: string | null = null
  if (ac) {
    const images = getRepeated(ac, 11)
    if (images[0]?.bytes) {
      const img = decode(images[0].bytes)
      imageUrl = getString(img, 4) || getString(img, 1) || null // medium || url
    }
  }

  const icaoAddr = ac ? getInt(ac, 1) : 0

  const trail: TrailPointGrpc[] = getRepeated(m, 6).map((t) => {
    const tp = decode(t.bytes!)
    return {
      ts: getInt(tp, 1),
      lat: getFloat(tp, 2),
      lon: getFloat(tp, 3),
      alt: getInt(tp, 4),
      spd: getInt(tp, 5),
      heading: getInt(tp, 6),
      vspd: getInt(tp, 7),
    }
  })

  return {
    hex: icaoAddr ? icaoAddr.toString(16).padStart(6, '0') : '',
    reg: ac ? getString(ac, 2) : '',
    type: ac ? getString(ac, 4) : '',
    fullDescription: ac ? getString(ac, 6) : '',
    registeredOwners: ac ? getString(ac, 15) : '',
    imageUrl,
    flightNumber: sch ? getString(sch, 1) : '',
    scheduledDeparture: sch ? getInt(sch, 7) : 0,
    scheduledArrival: sch ? getInt(sch, 8) : 0,
    actualDeparture: sch ? getInt(sch, 9) : 0,
    actualArrival: sch ? getInt(sch, 10) : 0,
    arrTerminal: sch ? getString(sch, 11) : '',
    arrGate: sch ? getString(sch, 12) : '',
    eta: prog ? getInt(prog, 5) : 0,
    flightStage: prog ? getInt(prog, 8) : 0,
    progressPct: prog ? getInt(prog, 10) : 0,
    flightid: info ? getInt(info, 1) : 0,
    lat: info ? getFloat(info, 2) : 0,
    lon: info ? getFloat(info, 3) : 0,
    track: info ? getInt(info, 4) : 0,
    alt: info ? getInt(info, 5) : 0,
    speed: info ? getInt(info, 6) : 0,
    vspeed: info ? getInt(info, 17) : 0,
    onGround: info ? getBool(info, 9) : false,
    callsign: info ? getString(info, 10) : '',
    timestampMs: info ? getInt(info, 8) : 0,
    trail,
  }
}

/** Returns null when the flight is not live (FR24 sends an empty DATA frame). */
export async function flightDetails(flightId: number): Promise<FlightDetailsResult | null> {
  const req = new Writer()
    .fixed32Field(1, flightId)
    .varintField(3, 1) // verbose
    .finish()
  const payload = await callFeed('FlightDetails', req)
  if (!payload || payload.length === 0) return null
  return parseFlightDetails(payload)
}
