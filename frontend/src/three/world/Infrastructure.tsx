import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
} from 'three'
import type { Tier } from '@/lib/device'
import type { Dynamics } from './dynamics'
import { SOLAR_PLANT, SUBSTATION, polePositions, wireSegments } from './layout'

const TILT = (15 * Math.PI) / 180

export function cellTexture() {
  // Dark glass with faint cell lines and a thin frame, so mipmaps stay dark at distance.
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#121b27'
  g.fillRect(0, 0, 64, 128)
  g.strokeStyle = '#26364a'
  g.lineWidth = 1
  for (let x = 10.6; x < 64; x += 10.6) {
    g.beginPath()
    g.moveTo(x, 0)
    g.lineTo(x, 128)
    g.stroke()
  }
  for (let y = 10.6; y < 128; y += 10.6) {
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(64, y)
    g.stroke()
  }
  g.strokeStyle = '#7d8a99'
  g.lineWidth = 1.5
  g.strokeRect(0.75, 0.75, 62.5, 126.5)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 8
  return t
}

export function SolarPlant({ dyn, tier }: { dyn: RefObject<Dynamics>; tier: Tier }) {
  const modules = useRef<InstancedMesh>(null)
  const legs = useRef<InstancedMesh>(null)
  const [cx, cz] = SOLAR_PLANT.center
  const [sx, sz] = SOLAR_PLANT.size
  const layout = useMemo(() => {
    const rows = 6
    const cols = tier === 'low' ? 8 : 12
    const pitch = (sx - 2.2) / (cols - 1)
    const tables: { x: number; z: number }[] = []
    for (let r = 0; r < rows; r++) {
      const z = cz - sz / 2 + 2.6 + r * ((sz - 5) / (rows - 1))
      for (let c = 0; c < cols; c++) tables.push({ x: cx - sx / 2 + 1.1 + c * pitch, z })
    }
    // Two modules per table, tilted 15 degrees to face south (+z): the north module sits higher.
    const items = tables.flatMap((t) =>
      [-0.82, 0.82].map((h) => ({ x: t.x, z: t.z + h * Math.cos(TILT), y: 1.0 - h * Math.sin(TILT) })),
    )
    return { tables, items, width: pitch - 0.08 }
  }, [cx, cz, sx, sz, tier])

  const geo = useMemo(() => ({ module: new BoxGeometry(1, 0.05, 1.6), leg: new BoxGeometry(0.07, 1, 0.07) }), [])
  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ color: '#ffffff', metalness: 0.1, roughness: 0.26, emissive: new Color('#1d3d66'), emissiveIntensity: 0.3 })
    if (tier !== 'low') m.map = cellTexture()
    else m.color.set('#1b2635')
    return m
  }, [tier])

  useLayoutEffect(() => {
    const o = new Object3D()
    layout.items.forEach((it, i) => {
      o.position.set(it.x, it.y, it.z)
      o.rotation.set(TILT, 0, 0)
      o.scale.set(layout.width, 1, 1)
      o.updateMatrix()
      modules.current!.setMatrixAt(i, o.matrix)
    })
    modules.current!.instanceMatrix.needsUpdate = true
    let j = 0
    for (const t of layout.tables) {
      for (const [dz, h] of [[-1.35, 1.5], [1.35, 0.6]] as const) {
        o.position.set(t.x, h / 2, t.z + dz)
        o.rotation.set(0, 0, 0)
        o.scale.set(1, h, 1)
        o.updateMatrix()
        legs.current!.setMatrixAt(j++, o.matrix)
      }
    }
    legs.current!.instanceMatrix.needsUpdate = true
  }, [layout])

  useFrame(() => {
    const d = dyn.current
    // producing panels read as glass lit by the sky, never warm
    if (d) material.emissiveIntensity = 0.22 + d.solarOutput * 0.35
  })

  const fence = useMemo(() => {
    const hx = sx / 2 + 0.8
    const hz = sz / 2 + 0.8
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute([cx - hx, 0.8, cz - hz, cx + hx, 0.8, cz - hz, cx + hx, 0.8, cz + hz, cx - hx, 0.8, cz + hz, cx - hx, 0.8, cz - hz], 3))
    return g
  }, [cx, cz, sx, sz])

  return (
    <group>
      <mesh position={[cx, 0.03, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[sx + 1.6, sz + 1.6]} />
        <meshStandardMaterial color="#d3cab6" roughness={1} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </mesh>
      <instancedMesh ref={modules} args={[geo.module, material, layout.items.length]} castShadow receiveShadow />
      <instancedMesh ref={legs} args={[geo.leg, undefined, layout.tables.length * 2]}>
        <meshStandardMaterial color="#9da3a6" metalness={0.6} roughness={0.4} />
      </instancedMesh>
      <line>
        <primitive object={fence} attach="geometry" />
        <lineBasicMaterial color="#8a8578" />
      </line>
      <mesh position={[cx + sx / 2 + 2.4, 0.6, cz + sz / 2 - 1.5]} castShadow>
        <boxGeometry args={[1.6, 1.2, 1.1]} />
        <meshStandardMaterial color="#e6e0d3" roughness={0.8} />
      </mesh>
    </group>
  )
}

export function Substation() {
  const [x, z] = SUBSTATION
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.15, 0]} receiveShadow castShadow>
        <boxGeometry args={[3.4, 0.3, 3.4]} />
        <meshStandardMaterial color="#cfc6b3" roughness={1} />
      </mesh>
      {[-1.2, 1.2].map((dz) => (
        <mesh key={dz} position={[0, 1.7, dz]} castShadow>
          <cylinderGeometry args={[0.09, 0.11, 3.2, 8]} />
          <meshStandardMaterial color="#b9b3a7" />
        </mesh>
      ))}
      <mesh position={[0, 3.1, 0]} castShadow>
        <boxGeometry args={[0.18, 0.14, 2.8]} />
        <meshStandardMaterial color="#8b8f90" metalness={0.5} />
      </mesh>
      <group position={[0, 1.15, 0]}>
        <mesh castShadow>
          <boxGeometry args={[1.1, 1.3, 0.9]} />
          <meshStandardMaterial color="#8c969b" metalness={0.35} roughness={0.55} />
        </mesh>
        {Array.from({ length: 6 }, (_, i) => (
          <mesh key={i} position={[-0.45 + i * 0.18, 0, 0.5]} castShadow>
            <boxGeometry args={[0.05, 1.1, 0.16]} />
            <meshStandardMaterial color="#7f898e" metalness={0.4} />
          </mesh>
        ))}
        {[-0.3, 0, 0.3].map((bx) => (
          <mesh key={bx} position={[bx, 0.9, 0]}>
            <cylinderGeometry args={[0.05, 0.07, 0.5, 6]} />
            <meshStandardMaterial color="#a5643f" roughness={0.6} />
          </mesh>
        ))}
      </group>
      <mesh position={[-2.6, 0.8, 2.2]} castShadow receiveShadow>
        <boxGeometry args={[2.2, 1.6, 1.7]} />
        <meshStandardMaterial color="#ebe5d8" roughness={0.9} />
      </mesh>
    </group>
  )
}

export function Grid({ dyn, tier }: { dyn: RefObject<Dynamics>; tier: Tier }) {
  const poles = useRef<InstancedMesh>(null)
  const arms = useRef<InstancedMesh>(null)
  const list = useMemo(() => polePositions(), [])
  const geo = useMemo(() => ({ pole: new CylinderGeometry(0.06, 0.08, 1, 6), arm: new BoxGeometry(1.45, 0.07, 0.08) }), [])
  const wireGeo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(wireSegments(), 3))
    return g
  }, [])
  const wireMat = useMemo(() => new LineBasicMaterial({ color: '#3a3630', transparent: true, opacity: 0.8 }), [])
  const glow = useMemo(() => new Color('#f2a900'), [])
  const base = useMemo(() => new Color('#3a3630'), [])

  useLayoutEffect(() => {
    const o = new Object3D()
    let a = 0
    list.forEach((p, i) => {
      const h = p.small ? 1.6 : 2.7
      o.position.set(p.pos[0], h / 2, p.pos[1])
      o.rotation.set(0, 0, 0)
      o.scale.set(p.small ? 0.7 : 1, h, p.small ? 0.7 : 1)
      o.updateMatrix()
      poles.current!.setMatrixAt(i, o.matrix)
      if (!p.small) {
        o.position.set(p.pos[0], 2.38, p.pos[1])
        o.rotation.set(0, p.dir + Math.PI / 2, 0)
        o.scale.set(1, 1, 1)
        o.updateMatrix()
        arms.current!.setMatrixAt(a++, o.matrix)
      }
    })
    poles.current!.instanceMatrix.needsUpdate = true
    arms.current!.count = a
    arms.current!.instanceMatrix.needsUpdate = true
  }, [list])

  useFrame(() => {
    const d = dyn.current
    if (!d) return
    const energised = d.active.size > 0
    wireMat.color.copy(base).lerp(d.overload ? new Color('#d04a2f') : glow, energised ? 0.35 : 0)
  })

  return (
    <group>
      <instancedMesh ref={poles} args={[geo.pole, undefined, list.length]} castShadow={tier === 'high'}>
        <meshStandardMaterial color="#b8b2a5" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={arms} args={[geo.arm, undefined, list.length]}>
        <meshStandardMaterial color="#6f6a60" metalness={0.4} />
      </instancedMesh>
      <lineSegments geometry={wireGeo} material={wireMat} />
    </group>
  )
}
