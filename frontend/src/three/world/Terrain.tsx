import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  BufferAttribute,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Object3D,
  PlaneGeometry,
  RingGeometry,
} from 'three'
import type { Tier } from '@/lib/device'
import { FEEDER_LINES, PLOTS, SOLAR_PLANT, SUBSTATION, rng } from './layout'

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi)
  const b = hash(xi + 1, yi)
  const c = hash(xi, yi + 1)
  const d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
export function fbm(x: number, y: number) {
  let f = 0
  let amp = 0.5
  let fr = 1
  for (let i = 0; i < 4; i++) {
    f += amp * vnoise(x * fr, y * fr)
    fr *= 2.03
    amp *= 0.5
  }
  return f
}
const smooth = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Ground height: flat across the farms, low Deccan hills and granite outcrops far out. */
export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x * 0.85, z)
  const rise = smooth(125, 260, r)
  const hills = (fbm(x * 0.009 + 3.1, z * 0.009 - 2.3) - 0.5) * 10
  const ridge = Math.max(0, fbm(x * 0.0045 + 9.7, z * 0.0045 + 1.3) - 0.47) * 150
  return rise * (hills + ridge)
}

function inFeederCore(x: number, z: number, margin = 0) {
  return x > -58 - margin && x < 54 + margin && z > -44 - margin && z < 42 + margin
}

function nearLine(x: number, z: number, d: number) {
  for (const line of FEEDER_LINES) {
    for (let i = 0; i < line.length - 1; i++) {
      const [a, b] = [line[i], line[i + 1]]
      const dx = b[0] - a[0]
      const dz = b[1] - a[1]
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)))
      if (Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz)) < d) return true
    }
  }
  return false
}

function inPlot(x: number, z: number, margin: number) {
  return PLOTS.some((p) => Math.abs(x - p.center[0]) < p.size[0] / 2 + margin && Math.abs(z - p.center[1]) < p.size[1] / 2 + margin)
}

export function Terrain({ tier }: { tier: Tier }) {
  const geometry = useMemo(() => {
    const seg = tier === 'low' ? 90 : 150
    const g = new PlaneGeometry(760, 760, seg, seg)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position
    const colors = new Float32Array(pos.count * 3)
    const c = new Color()
    const earth = new Color('#b39466')
    const grass = new Color('#9f9a64')
    const granite = new Color('#8f877c')
    const dark = new Color('#94784f')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const y = groundHeight(x, z)
      pos.setY(i, y)
      const n = fbm(x * 0.045, z * 0.045)
      c.copy(earth).lerp(grass, Math.min(1, n * 0.9))
      if (fbm(x * 0.12 + 40, z * 0.12) > 0.62) c.lerp(dark, 0.5)
      if (y > 6) c.lerp(granite, Math.min(1, (y - 6) / 18))
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    g.setAttribute('color', new BufferAttribute(colors, 3))
    g.computeVertexNormals()
    return g
  }, [tier])
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors flatShading roughness={1} metalness={0} />
    </mesh>
  )
}

const PARCEL_COLORS = ['#a98c5f', '#b49d6d', '#7f8d4c', '#93a05a', '#8a7650', '#c1aa76', '#9c8a5c', '#6f8546']

/** Background fields, trees, the village (with its overhead water tank), the village tank and roads. */
export function Surroundings({ tier }: { tier: Tier }) {
  const parcels = useRef<InstancedMesh>(null)
  const trunks = useRef<InstancedMesh>(null)
  const canopies = useRef<InstancedMesh>(null)
  const houses = useRef<InstancedMesh>(null)
  const boulders = useRef<InstancedMesh>(null)

  const data = useMemo(() => {
    const r = rng(42)
    const parcelList: { x: number; z: number; w: number; d: number; rot: number; color: string }[] = []
    const cell = 12.5
    for (let gx = -11; gx <= 11; gx++) {
      for (let gz = -11; gz <= 11; gz++) {
        const x = gx * cell + (r() - 0.5) * 3
        const z = gz * cell + (r() - 0.5) * 3
        if (Math.hypot(x * 0.85, z) > 135 || inFeederCore(x, z, 2)) continue
        if (Math.hypot(x - 78, z + 58) < 30 || Math.hypot(x - 8, z - 64) < 18) continue
        parcelList.push({ x, z, w: cell * (0.62 + r() * 0.3), d: cell * (0.62 + r() * 0.3), rot: (r() - 0.5) * 0.12, color: PARCEL_COLORS[Math.floor(r() * PARCEL_COLORS.length)] })
      }
    }
    const treeCount = tier === 'low' ? 120 : tier === 'mid' ? 220 : 340
    const trees: { x: number; z: number; s: number; h: number }[] = []
    let guard = 0
    while (trees.length < treeCount && guard++ < 6000) {
      const x = (r() - 0.5) * 320
      const z = (r() - 0.5) * 300
      if (groundHeight(x, z) > 5) continue
      const core = inFeederCore(x, z)
      if (core && (inPlot(x, z, 1.2) || nearLine(x, z, 2.2) || r() > 0.18)) continue
      if (Math.abs(x - SOLAR_PLANT.center[0]) < 10 && Math.abs(z - SOLAR_PLANT.center[1]) < 15) continue
      if (Math.hypot(x - SUBSTATION[0], z - SUBSTATION[1]) < 5) continue
      if (Math.hypot(x - 78, z + 58) < 24) continue
      trees.push({ x, z, s: 0.8 + r() * 1.1, h: 1.4 + r() * 1.4 })
    }
    for (let i = 0; i < 14; i++) {
      // a ring of big neem trees around the village
      const a = (i / 14) * Math.PI * 2
      trees.push({ x: 8 + Math.cos(a) * 19, z: 64 + Math.sin(a) * 14, s: 1.9 + r() * 0.8, h: 2.4 + r() })
    }
    const houseList: { x: number; z: number; w: number; d: number; h: number; rot: number; color: string }[] = []
    const houseColors = ['#ece5d7', '#ddd0b8', '#e6d9c1', '#cdbda2', '#f1ebe0', '#d9c3a3', '#c9d1cf']
    for (let i = 0; i < (tier === 'low' ? 30 : 56); i++) {
      const a = r() * Math.PI * 2
      const rad = Math.sqrt(r()) * 13
      houseList.push({ x: 8 + Math.cos(a) * rad, z: 64 + Math.sin(a) * rad * 0.75, w: 1.6 + r() * 1.6, d: 1.4 + r() * 1.3, h: 1.0 + r() * 1.2, rot: Math.round(r() * 4) * (Math.PI / 2) + (r() - 0.5) * 0.2, color: houseColors[Math.floor(r() * houseColors.length)] })
    }
    const boulderList: { x: number; z: number; s: number }[] = []
    for (let i = 0; i < (tier === 'low' ? 60 : 160); i++) {
      const a = r() * Math.PI * 2
      const rad = 150 + r() * 160
      const x = Math.cos(a) * rad
      const z = Math.sin(a) * rad
      const y = groundHeight(x, z)
      if (y < 3) continue
      boulderList.push({ x, z, s: 1.5 + r() * 4.5 })
    }
    return { parcelList, trees, houseList, boulderList }
  }, [tier])

  useLayoutEffect(() => {
    const o = new Object3D()
    const c = new Color()
    if (parcels.current) {
      data.parcelList.forEach((p, i) => {
        o.position.set(p.x, groundHeight(p.x, p.z) + 0.03, p.z)
        o.rotation.set(-Math.PI / 2, 0, p.rot)
        o.scale.set(p.w, p.d, 1)
        o.updateMatrix()
        parcels.current!.setMatrixAt(i, o.matrix)
        parcels.current!.setColorAt(i, c.set(p.color))
      })
      parcels.current.instanceMatrix.needsUpdate = true
      if (parcels.current.instanceColor) parcels.current.instanceColor.needsUpdate = true
    }
    if (trunks.current && canopies.current) {
      data.trees.forEach((t, i) => {
        const y = groundHeight(t.x, t.z)
        o.rotation.set(0, i * 1.7, 0)
        o.position.set(t.x, y + t.h * 0.5, t.z)
        o.scale.set(t.s, t.h, t.s)
        o.updateMatrix()
        trunks.current!.setMatrixAt(i, o.matrix)
        o.position.set(t.x, y + t.h + t.s * 0.55, t.z)
        o.scale.set(t.s * 1.25, t.s * 0.95, t.s * 1.25)
        o.updateMatrix()
        canopies.current!.setMatrixAt(i, o.matrix)
        canopies.current!.setColorAt(i, c.set(['#4d7433', '#5c8338', '#45692d', '#6a8a3c'][i % 4]))
      })
      trunks.current.instanceMatrix.needsUpdate = true
      canopies.current.instanceMatrix.needsUpdate = true
      if (canopies.current.instanceColor) canopies.current.instanceColor.needsUpdate = true
    }
    if (houses.current) {
      data.houseList.forEach((hh, i) => {
        o.position.set(hh.x, hh.h / 2, hh.z)
        o.rotation.set(0, hh.rot, 0)
        o.scale.set(hh.w, hh.h, hh.d)
        o.updateMatrix()
        houses.current!.setMatrixAt(i, o.matrix)
        houses.current!.setColorAt(i, c.set(hh.color))
      })
      houses.current.instanceMatrix.needsUpdate = true
      if (houses.current.instanceColor) houses.current.instanceColor.needsUpdate = true
    }
    if (boulders.current) {
      data.boulderList.forEach((b, i) => {
        o.position.set(b.x, groundHeight(b.x, b.z) + b.s * 0.3, b.z)
        o.rotation.set(i, i * 2.3, i * 0.7)
        o.scale.setScalar(b.s)
        o.updateMatrix()
        boulders.current!.setMatrixAt(i, o.matrix)
      })
      boulders.current.instanceMatrix.needsUpdate = true
    }
  }, [data])

  const geo = useMemo(() => {
    const parcel = new PlaneGeometry(1, 1)
    const trunk = new CylinderGeometry(0.09, 0.13, 1, 5)
    const canopy = new IcosahedronGeometry(1, 0)
    const house = new BoxGeometry(1, 1, 1)
    const boulder = new DodecahedronGeometry(1, 0)
    const tank = new CircleGeometry(1, 40)
    const bank = new RingGeometry(1, 1.12, 40)
    return { parcel, trunk, canopy, house, boulder, tank, bank }
  }, [])

  const roads = useMemo(
    () => [
      { x: 0, z: 47, w: 420, d: 2.6, rot: 0 },
      { x: -60, z: 0, w: 2.4, d: 420, rot: 0 },
      { x: 30, z: -48, w: 260, d: 1.6, rot: 0.04 },
      { x: 58, z: 0, w: 1.6, d: 140, rot: -0.03 },
    ],
    [],
  )

  return (
    <group>
      <instancedMesh ref={parcels} args={[geo.parcel, undefined, data.parcelList.length]} receiveShadow>
        <meshStandardMaterial roughness={1} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
      </instancedMesh>
      <instancedMesh ref={trunks} args={[geo.trunk, undefined, data.trees.length]} castShadow>
        <meshStandardMaterial color="#6b5238" roughness={1} />
      </instancedMesh>
      <instancedMesh ref={canopies} args={[geo.canopy, undefined, data.trees.length]} castShadow receiveShadow>
        <meshStandardMaterial flatShading roughness={0.95} />
      </instancedMesh>
      <instancedMesh ref={houses} args={[geo.house, undefined, data.houseList.length]} castShadow receiveShadow>
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={boulders} args={[geo.boulder, undefined, Math.max(1, data.boulderList.length)]} castShadow>
        <meshStandardMaterial color="#9a9184" flatShading roughness={1} />
      </instancedMesh>
      {/* village overhead water tank */}
      <group position={[8, 0, 64]}>
        {[[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]].map(([x, z], i) => (
          <mesh key={i} position={[x, 3, z]} castShadow>
            <boxGeometry args={[0.18, 6, 0.18]} />
            <meshStandardMaterial color="#d8d1c3" />
          </mesh>
        ))}
        <mesh position={[0, 6.8, 0]} castShadow>
          <cylinderGeometry args={[1.8, 1.4, 1.8, 16]} />
          <meshStandardMaterial color="#e9e4da" roughness={0.8} />
        </mesh>
      </group>
      {/* village tank (cheruvu) */}
      <mesh geometry={geo.tank} position={[78, 0.05, -58]} rotation={[-Math.PI / 2, 0, 0.3]} scale={[28, 15, 1]}>
        <meshStandardMaterial color="#7da3bd" roughness={0.12} metalness={0.15} />
      </mesh>
      <mesh geometry={geo.bank} position={[78, 0.04, -58]} rotation={[-Math.PI / 2, 0, 0.3]} scale={[28, 15, 1]}>
        <meshStandardMaterial color="#8f835f" roughness={1} />
      </mesh>
      {roads.map((rd, i) => (
        <mesh key={i} position={[rd.x, 0.06, rd.z]} rotation={[-Math.PI / 2, 0, rd.rot]} receiveShadow>
          <planeGeometry args={[rd.w, rd.d]} />
          <meshStandardMaterial color="#cbb791" roughness={1} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      ))}
    </group>
  )
}
