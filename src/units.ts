export type UnitSystem = 'imperial' | 'metric'
export type SpeedUnit = 'knots' | 'miles' | 'kilometers'

export interface UnitOptions {
  system: UnitSystem
  speedUnit: SpeedUnit
}

export interface UnitsMeta {
  system: UnitSystem
  altitude: 'ft' | 'm'
  speed: 'kn' | 'mph' | 'km/h'
  verticalSpeed: 'ft/min' | 'm/min'
  distance: 'nm' | 'km' | 'mi'
}

export function resolveUnitOptions(
  unitParam: string | undefined,
  speedParam: string | undefined,
): UnitOptions {
  const system: UnitSystem = unitParam === 'metric' ? 'metric' : 'imperial'
  let speedUnit: SpeedUnit
  if (speedParam === 'knots' || speedParam === 'miles' || speedParam === 'kilometers') {
    speedUnit = speedParam
  } else {
    speedUnit = system === 'metric' ? 'kilometers' : 'knots'
  }
  return { system, speedUnit }
}

export function buildUnitsMeta(opts: UnitOptions): UnitsMeta {
  const isMetric = opts.system === 'metric'
  return {
    system: opts.system,
    altitude: isMetric ? 'm' : 'ft',
    speed: opts.speedUnit === 'knots' ? 'kn'
      : opts.speedUnit === 'miles' ? 'mph'
        : 'km/h',
    verticalSpeed: isMetric ? 'm/min' : 'ft/min',
    distance: opts.speedUnit === 'miles' ? 'mi'
      : isMetric ? 'km'
        : 'nm',
  }
}

// --- Conversion primitives ---

function feetToMeters(ft: number): number {
  return ft * 0.3048
}

function knotsToKmh(kn: number): number {
  return kn * 1.852
}

function knotsToMph(kn: number): number {
  return kn * 1.15078
}

function kmToNm(km: number): number {
  return km / 1.852
}

function kmToMiles(km: number): number {
  return km * 0.621371
}

// --- Field-level converters ---

export function convertAltitude(ft: number | null, opts: UnitOptions): number | null {
  if (ft === null) return null
  return opts.system === 'metric' ? Math.round(feetToMeters(ft)) : ft
}

export function convertSpeed(knots: number | null, opts: UnitOptions): number | null {
  if (knots === null) return null
  switch (opts.speedUnit) {
    case 'kilometers': return Math.round(knotsToKmh(knots))
    case 'miles': return Math.round(knotsToMph(knots))
    default: return knots
  }
}

export function convertVerticalSpeed(ftPerMin: number | null, opts: UnitOptions): number | null {
  if (ftPerMin === null) return null
  return opts.system === 'metric' ? Math.round(feetToMeters(ftPerMin)) : ftPerMin
}

export function convertDistanceFromKm(km: number, opts: UnitOptions): number {
  const meta = buildUnitsMeta(opts)
  switch (meta.distance) {
    case 'nm': return Math.round(kmToNm(km) * 10) / 10
    case 'mi': return Math.round(kmToMiles(km) * 10) / 10
    default: return Math.round(km * 10) / 10
  }
}

export function formatAltitudeWithUnits(altFt: number, opts: UnitOptions): string {
  if (altFt >= 18000) return `FL${Math.round(altFt / 100)}`
  if (opts.system === 'metric') {
    return `${Math.round(feetToMeters(altFt)).toLocaleString()} m`
  }
  return `${altFt.toLocaleString()} ft`
}

// --- Post-processing ---

export function convertFlightResult(result: any, opts: UnitOptions): any {
  // Telemetry
  if (result.telemetry) {
    result.telemetry.altitude = convertAltitude(result.telemetry.altitude, opts)
    result.telemetry.groundSpeed = convertSpeed(result.telemetry.groundSpeed, opts)
    result.telemetry.verticalSpeed = convertVerticalSpeed(result.telemetry.verticalSpeed, opts)
  }

  // Route airports
  for (const key of ['origin', 'destination'] as const) {
    const airport = result.route?.[key]
    if (airport?.position) {
      // Handle legacy cache entries that still have altitudeFt
      if (airport.position.altitudeFt !== undefined && airport.position.altitude === undefined) {
        airport.position.altitude = airport.position.altitudeFt
        delete airport.position.altitudeFt
      }
      airport.position.altitude = convertAltitude(airport.position.altitude, opts)
    }
  }

  // Phase label regeneration
  if (result.phase?.altitudeRaw != null) {
    const altFt = result.phase.altitudeRaw
    const formattedAlt = formatAltitudeWithUnits(altFt, opts)

    switch (result.phase.state) {
      case 'climbing':
        result.phase.label = `Climbing, ${formattedAlt}`
        break
      case 'descending':
        result.phase.label = `Descending, ${formattedAlt}`
        break
      case 'cruising':
        result.phase.label = `Cruising, ${formattedAlt}`
        break
    }
  }
  delete result.phase?.altitudeRaw

  return result
}
