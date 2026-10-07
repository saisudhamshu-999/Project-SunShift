// Browser PV model: same chain as the pvlib backend (position -> POA -> cell temperature
// -> PVWatts DC -> PVWatts inverter), with simpler published sub-models.
import type { FeederDef, LocationDef } from './scenario'
import { FEEDER } from './scenario'

const RAD = Math.PI / 180
const DEG = 180 / Math.PI
export const IST_OFFSET_MIN = 330

export interface SunPosition {
  zenith: number // degrees
  azimuth: number // degrees clockwise from north
  elevation: number
}

/** NOAA solar position algorithm (accurate to ~0.01° for 1950-2050). */
export function solarPosition(utc: Date, lat: number, lon: number): SunPosition {
  const jd = utc.getTime() / 86400000 + 2440587.5
  const t = (jd - 2451545) / 36525
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289
  const trueLong = l0 + c
  const omega = 125.04 - 1934.136 * t
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD)
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD)
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG
  const y = Math.tan((eps / 2) * RAD) ** 2
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD))
  const minutes = utc.getUTCHours() * 60 + utc.getUTCMinutes() + utc.getUTCSeconds() / 60
  const trueSolarTime = (((minutes + eqTime + 4 * lon) % 1440) + 1440) % 1440
  let hourAngle = trueSolarTime / 4 - 180
  if (hourAngle < -180) hourAngle += 360
  const cosZ =
    Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(hourAngle * RAD)
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZ))) * DEG
  const az =
    Math.acos(
      Math.max(
        -1,
        Math.min(1, (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(decl * RAD)) / (Math.cos(lat * RAD) * Math.sin(zenith * RAD))),
      ),
    ) * DEG
  const azimuth = hourAngle > 0 ? (az + 180) % 360 : (540 - az) % 360
  return { zenith, azimuth, elevation: 90 - zenith }
}

/** UTC instant for a local IST clock time on an ISO date. */
export function istToUtc(isoDate: string, minutesOfDay: number): Date {
  const base = Date.parse(`${isoDate}T00:00:00Z`)
  return new Date(base + (minutesOfDay - IST_OFFSET_MIN) * 60000)
}

export function slotMidUtc(isoDate: string, slot: number, feeder: FeederDef = FEEDER): Date {
  return istToUtc(isoDate, feeder.day_start_hour * 60 + (slot + 0.5) * feeder.slot_minutes)
}

const I0 = 1366.1

export function extraterrestrialNormal(doy: number): number {
  const b = (2 * Math.PI * doy) / 365
  return I0 * (1.00011 + 0.034221 * Math.cos(b) + 0.00128 * Math.sin(b) + 0.000719 * Math.cos(2 * b) + 0.000077 * Math.sin(2 * b))
}

/** Ineichen-Perez clear sky with a fixed Linke turbidity typical of hazy Indian skies. */
export function clearSky(zenith: number, altitude: number, doy: number, linke = 4.2) {
  if (zenith >= 90) return { ghi: 0, dni: 0, dhi: 0 }
  const cosz = Math.cos(zenith * RAD)
  const am = 1 / (cosz + 0.50572 * (96.07995 - zenith) ** -1.6364)
  const fh1 = Math.exp(-altitude / 8000)
  const fh2 = Math.exp(-altitude / 1250)
  const cg1 = 5.09e-5 * altitude + 0.868
  const cg2 = 3.92e-5 * altitude + 0.0387
  const i0 = extraterrestrialNormal(doy)
  const ghi = Math.max(0, cg1 * i0 * cosz * Math.exp(-cg2 * am * (fh1 + fh2 * (linke - 1))) * Math.exp(0.01 * am ** 1.8))
  const b = 0.664 + 0.163 / fh1
  const dni = Math.max(0, Math.min(b * i0 * Math.exp(-0.09 * am * (linke - 1)), ghi / Math.max(cosz, 0.01)))
  const dhi = Math.max(0, ghi - dni * cosz)
  return { ghi, dni, dhi }
}

/** Erbs decomposition of GHI into beam and diffuse. */
export function erbs(ghi: number, zenith: number, doy: number) {
  const cosz = Math.cos(zenith * RAD)
  if (cosz <= 0.065 || ghi <= 0) return { dni: 0, dhi: Math.max(0, ghi) }
  const kt = Math.min(1, ghi / (extraterrestrialNormal(doy) * cosz))
  let df: number
  if (kt <= 0.22) df = 1 - 0.09 * kt
  else if (kt <= 0.8) df = 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4
  else df = 0.165
  const dhi = df * ghi
  return { dni: (ghi - dhi) / cosz, dhi }
}

/** Hay-Davies plane-of-array irradiance. */
export function planeOfArray(
  sun: SunPosition,
  ghi: number,
  dni: number,
  dhi: number,
  doy: number,
  tiltDeg: number,
  surfaceAzimuthDeg: number,
  albedo = 0.25,
): number {
  if (sun.zenith >= 90) return 0
  const tilt = tiltDeg * RAD
  const cosAoi =
    Math.cos(sun.zenith * RAD) * Math.cos(tilt) +
    Math.sin(sun.zenith * RAD) * Math.sin(tilt) * Math.cos((sun.azimuth - surfaceAzimuthDeg) * RAD)
  const beam = dni * Math.max(0, cosAoi)
  const ai = dni / extraterrestrialNormal(doy)
  const rb = Math.max(0, cosAoi) / Math.max(0.01745, Math.cos(sun.zenith * RAD))
  const sky = dhi * (ai * rb + (1 - ai) * ((1 + Math.cos(tilt)) / 2))
  const ground = ghi * albedo * ((1 - Math.cos(tilt)) / 2)
  return Math.max(0, beam + sky + ground)
}

export function cellTemperature(poa: number, tAir: number, wind: number): number {
  return tAir + poa / (25 + 6.84 * wind) // Faiman
}

/** PVWatts DC + PVWatts inverter, returning AC kW. */
export function acPower(poa: number, tCell: number, feeder: FeederDef = FEEDER) {
  const pdc0 = feeder.pv_kwp * 1000
  const pdc = Math.max(0, (poa / 1000) * pdc0 * (1 + feeder.gamma_pdc * (tCell - 25)) * (1 - feeder.system_losses))
  const invPdc0 = (feeder.inverter_kw * 1000) / 0.96
  const zeta = Math.max(pdc / invPdc0, 1e-6)
  const eta = (0.96 / 0.9637) * (-0.0162 * zeta - 0.0059 / zeta + 0.9858)
  const pac = Math.max(0, Math.min(eta * pdc, feeder.inverter_kw * 1000))
  return { dcKw: pdc / 1000, acKw: pdc > 0 ? pac / 1000 : 0 }
}

export interface SlotIrradiance {
  ghi: number[]
  dni: number[]
  dhi: number[]
  temp: number[]
  wind10: number[]
}

export function pvProfile(day: string, loc: LocationDef, irr: SlotIrradiance, feeder: FeederDef = FEEDER) {
  const doy = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.UTC(new Date(`${day}T00:00:00Z`).getUTCFullYear(), 0, 0)) / 86400000)
  const out = { zenith: [] as number[], azimuth: [] as number[], elevation: [] as number[], ghi: [] as number[], poa: [] as number[], tcell: [] as number[], dcKw: [] as number[], acKw: [] as number[], clearSkyAcKw: [] as number[] }
  for (let s = 0; s < feeder.slots; s++) {
    const sun = solarPosition(slotMidUtc(day, s, feeder), loc.lat, loc.lon)
    const poa = planeOfArray(sun, irr.ghi[s], irr.dni[s], irr.dhi[s], doy, feeder.tilt_deg, feeder.azimuth_deg)
    const tc = cellTemperature(poa, irr.temp[s], irr.wind10[s])
    const { dcKw, acKw } = acPower(poa, tc, feeder)
    const cs = clearSky(sun.zenith, loc.elevation_m, doy)
    const poaCs = planeOfArray(sun, cs.ghi, cs.dni, cs.dhi, doy, feeder.tilt_deg, feeder.azimuth_deg)
    out.zenith.push(sun.zenith)
    out.azimuth.push(sun.azimuth)
    out.elevation.push(sun.elevation)
    out.ghi.push(irr.ghi[s])
    out.poa.push(poa)
    out.tcell.push(tc)
    out.dcKw.push(dcKw)
    out.acKw.push(acKw)
    out.clearSkyAcKw.push(acPower(poaCs, cellTemperature(poaCs, irr.temp[s], irr.wind10[s]), feeder).acKw)
  }
  const h = feeder.slot_minutes / 60
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  return {
    ...out,
    energyKwh: sum(out.acKw) * h,
    clearSkyEnergyKwh: sum(out.clearSkyAcKw) * h,
    peakKw: Math.max(...out.acKw),
  }
}
