import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef, type RefObject } from 'react'
import { CatmullRomCurve3, PerspectiveCamera, Vector3 } from 'three'
import type { CropKey } from '@/api/types'
import type { Tier } from '@/lib/device'
import { useDynamics } from '../world/dynamics'
import { SOIL_FACE } from '../world/Effects'
import { PLOTS, SOLAR_PLANT, SUBSTATION } from '../world/layout'
import { sunAt } from '../world/sun'
import { World } from '../world/World'

/**
 * Scroll-driven flight: soil -> crops -> solar plant -> feeder -> every farm.
 * `progress` is a mutable 0..1 value written by ScrollTrigger (no React re-renders).
 */
export function HeroScene({
  progress,
  tier,
  date,
  alive = false,
  crops,
  das,
  schedule,
}: {
  progress: RefObject<number>
  tier: Tier
  date: string
  alive?: boolean
  crops?: Record<number, CropKey>
  das?: Record<number, number>
  schedule?: Record<number, number[]>
}) {
  const dyn = useDynamics()
  const { camera, size } = useThree()
  const fx = SOIL_FACE.x
  const fz = SOIL_FACE.z
  const [sx, sz] = SOLAR_PLANT.center
  const [bx, bz] = SUBSTATION

  const { posCurve, lookCurve } = useMemo(() => {
    const P = (x: number, y: number, z: number) => new Vector3(x, y, z)
    const pos = [
      P(fx + 0.6, -1.25, fz + 3.1), // facing the soil profile
      P(fx + 0.3, -0.6, fz + 2.6),
      P(fx - 0.5, 0.55, fz + 1.4), // breaking the surface
      P(fx - 1.2, 1.6, fz + 2.8), // among the crop rows
      P(fx - 6, 7.5, fz + 15), // pulling back over the farms
      P(sx + 22, 9, sz + 22), // towards the solar plant
      P(sx + 16, 6.5, sz + 13),
      P(bx + 9, 5.5, bz + 9), // the substation and feeder
      P(bx + 30, 9, bz + 15), // along the trunk
      P(14, 44, 64), // aerial: the whole feeder
      P(6, 56, 70),
    ]
    const look = [
      P(fx + 0.2, -1.35, fz),
      P(fx, -0.9, fz - 0.6),
      P(fx, 0.15, fz - 4),
      P(fx + 0.5, 0.4, fz - 9),
      P(fx - 4, 0, fz - 10),
      P(sx, 0.8, sz),
      P(sx + 1, 0.8, sz - 1),
      P(bx, 2.2, bz),
      P(bx + 46, 1.5, bz),
      P(6, 0, -2),
      P(4, 0, -2),
    ]
    return { posCurve: new CatmullRomCurve3(pos, false, 'centripetal'), lookCurve: new CatmullRomCurve3(look, false, 'centripetal') }
  }, [fx, fz, sx, sz, bx, bz])

  const look = useRef(new Vector3())
  const smooth = useRef(0)
  const tmp = useMemo(() => new Vector3(), [])

  useFrame((state, delta) => {
    const d = dyn.current
    const target = progress.current ?? 0
    smooth.current += (target - smooth.current) * Math.min(1, delta * 4.5)
    const p = alive ? 1 : smooth.current
    const cam = camera as PerspectiveCamera
    // Equal scroll per keyframe (getPoint, not arc-length getPointAt): the short soil
    // shots get as much scroll as the long aerial moves.
    const t = Math.min(1, Math.max(0, p))
    if (alive) {
      // Finale: a slow orbit over the living feeder.
      const a = state.clock.elapsedTime * 0.035
      cam.position.set(6 + Math.sin(a) * 92, 54, -2 + Math.cos(a) * 92)
      look.current.set(6, 0, -2)
    } else {
      posCurve.getPoint(t, cam.position)
      lookCurve.getPoint(t, tmp)
      look.current.copy(tmp)
    }
    cam.lookAt(look.current)
    // On wide screens push the subject right so the statements own the left of the frame.
    const offset = !alive && size.width > 900 ? -Math.round(size.width * 0.14) : 0
    if ((cam.view?.offsetX ?? 0) !== offset) {
      if (offset) cam.setViewOffset(size.width, size.height, offset, 0, size.width, size.height)
      else cam.clearViewOffset()
    }
    const narrow = size.width < size.height
    const fov = (alive ? 38 : p < 0.15 ? 46 : 40) + (narrow ? 14 : 0)
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, delta * 3)
      cam.updateProjectionMatrix()
    }
    if (!d) return

    // Time of day: dawn to mid-morning across the flight; the finale runs a full day loop.
    const hour = alive ? 6.2 + ((state.clock.elapsedTime * 0.18) % 11.6) : 5.95 + p * 3.6
    d.sun = sunAt(date, hour)
    d.underground = Math.max(0, Math.min(1, -cam.position.y / 0.7))
    d.solarOutput = Math.max(0, Math.min(1, (d.sun.elevation - 2) / 45))
    if (alive && schedule) {
      const slot = Math.floor((hour - 6) * 4)
      d.active = new Set(Object.entries(schedule).filter(([, s]) => s.includes(slot)).map(([k]) => Number(k)))
      d.illuminate = 0
      d.overload = false
    } else {
      d.illuminate = Math.max(0, (p - 0.78) / 0.2)
      // as the aerial view opens, pumps start one after another on the sun
      const n = Math.floor(Math.max(0, (p - 0.84) / 0.16) * PLOTS.length)
      d.active = new Set(PLOTS.slice(0, n).filter((_, i) => i % 3 !== 1).map((pl) => pl.id))
    }
  })

  return <World dyn={dyn} tier={tier} crops={crops} das={das} soilProfile={!alive} shadows={tier === 'high'} />
}
