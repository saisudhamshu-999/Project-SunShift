import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
} from 'three'
import type { CropKey } from '@/api/types'
import { CROPS, FARMS } from '@/engine/scenario'
import type { Tier } from '@/lib/device'
import type { Dynamics } from './dynamics'
import { PLOTS, rng } from './layout'

const SOIL_COLOR: Record<string, string> = {
  black_clay: '#4b3f33',
  red_sandy_loam: '#9b5d3c',
  loam: '#7b6146',
  sandy: '#b89468',
  clay_loam: '#6c5440',
}

const CROP_GREEN: Record<CropKey, string> = {
  cotton: '#557f36',
  maize: '#6f9a3f',
  groundnut: '#6c9844',
  chilli: '#3f6b2b',
}

export interface FieldsProps {
  dyn: RefObject<Dynamics>
  tier: Tier
  crops?: Record<number, CropKey>
  das?: Record<number, number>
  selected?: number | null
  onSelect?: (id: number) => void
  interactive?: boolean
}

function growth(crop: CropKey, das: number) {
  const s = CROPS[crop].stages
  return 0.4 + 0.6 * Math.max(0, Math.min(1, das / (s[0] + s[1] + s[2] * 0.4)))
}

export function Fields({ dyn, tier, crops, das, selected = null, onSelect, interactive = false }: FieldsProps) {
  const cropOf = (id: number): CropKey => crops?.[id] ?? FARMS.find((f) => f.id === id)!.crop
  const dasOf = (id: number): number => das?.[id] ?? FARMS.find((f) => f.id === id)!.das
  const cropKey = PLOTS.map((p) => `${cropOf(p.id)}:${dasOf(p.id)}`).join(',')

  // --- plants: one instanced mesh per crop type, plus fruit/boll accents
  const plants = useMemo(() => {
    const r = rng(11)
    const spacing = tier === 'low' ? 0.95 : tier === 'mid' ? 0.75 : 0.62
    const byCrop: Record<CropKey, { x: number; z: number; s: number; rot: number }[]> = { cotton: [], maize: [], groundnut: [], chilli: [] }
    const accents: { x: number; y: number; z: number; crop: CropKey }[] = []
    for (const p of PLOTS) {
      const crop = cropOf(p.id)
      const g = growth(crop, dasOf(p.id))
      const [w, d] = p.size
      const along = p.rowsAlongX
      const rowsN = Math.floor(((along ? d : w) - 0.9) / spacing)
      const colsN = Math.floor(((along ? w : d) - 0.9) / (spacing * 0.8))
      for (let i = 0; i <= rowsN; i++) {
        for (let j = 0; j <= colsN; j++) {
          const a = -((along ? w : d) - 0.9) / 2 + j * spacing * 0.8 + (r() - 0.5) * 0.08
          const b = -((along ? d : w) - 0.9) / 2 + i * spacing
          const x = p.center[0] + (along ? a : b)
          const z = p.center[1] + (along ? b : a)
          const s = g * (0.85 + r() * 0.3)
          byCrop[crop].push({ x, z, s, rot: r() * Math.PI })
          if ((crop === 'cotton' || crop === 'chilli') && g > 0.75 && r() < 0.45) {
            accents.push({ x: x + (r() - 0.5) * 0.2, y: crop === 'cotton' ? 0.5 * s : 0.3 * s, z: z + (r() - 0.5) * 0.2, crop })
          }
        }
      }
    }
    return { byCrop, accents }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropKey, tier])

  const geos = useMemo(
    () => ({
      cotton: new IcosahedronGeometry(0.27, 0).scale(1, 0.9, 1).translate(0, 0.3, 0),
      maize: new ConeGeometry(0.13, 1.15, 5).translate(0, 0.575, 0),
      groundnut: new SphereGeometry(0.25, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.75, 1),
      chilli: new IcosahedronGeometry(0.21, 0).translate(0, 0.21, 0),
      accent: new SphereGeometry(0.07, 5, 4),
      plot: new BoxGeometry(1, 0.08, 1),
      bund: new BoxGeometry(1, 1, 1),
      house: new BoxGeometry(0.95, 0.8, 0.85),
      roof: new BoxGeometry(1.15, 0.08, 1.05),
      lamp: new SphereGeometry(0.16, 10, 8),
    }),
    [],
  )

  const cropRefs = {
    cotton: useRef<InstancedMesh>(null),
    maize: useRef<InstancedMesh>(null),
    groundnut: useRef<InstancedMesh>(null),
    chilli: useRef<InstancedMesh>(null),
  }
  const accentRef = useRef<InstancedMesh>(null)
  const bundRef = useRef<InstancedMesh>(null)
  const houseRef = useRef<InstancedMesh>(null)
  const roofRef = useRef<InstancedMesh>(null)

  useLayoutEffect(() => {
    const o = new Object3D()
    const c = new Color()
    ;(Object.keys(cropRefs) as CropKey[]).forEach((crop) => {
      const mesh = cropRefs[crop].current
      if (!mesh) return
      plants.byCrop[crop].forEach((pl, i) => {
        o.position.set(pl.x, 0.04, pl.z)
        o.rotation.set(0, pl.rot, 0)
        o.scale.setScalar(pl.s)
        o.updateMatrix()
        mesh.setMatrixAt(i, o.matrix)
        mesh.setColorAt(i, c.set(CROP_GREEN[crop]).offsetHSL(0, 0, (Math.sin(i * 12.9898) * 0.5) * 0.06))
      })
      mesh.count = plants.byCrop[crop].length
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    })
    if (accentRef.current) {
      plants.accents.forEach((a, i) => {
        o.position.set(a.x, a.y + 0.04, a.z)
        o.rotation.set(0, 0, 0)
        o.scale.setScalar(a.crop === 'cotton' ? 1 : 0.8)
        o.updateMatrix()
        accentRef.current!.setMatrixAt(i, o.matrix)
        accentRef.current!.setColorAt(i, c.set(a.crop === 'cotton' ? '#f6f1e6' : '#c4452f'))
      })
      accentRef.current.count = plants.accents.length
      accentRef.current.instanceMatrix.needsUpdate = true
      if (accentRef.current.instanceColor) accentRef.current.instanceColor.needsUpdate = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plants])

  useLayoutEffect(() => {
    const o = new Object3D()
    if (bundRef.current) {
      let i = 0
      for (const p of PLOTS) {
        const [w, d] = p.size
        const edges: [number, number, number, number][] = [
          [p.center[0], p.center[1] - d / 2, w + 0.3, 0.3],
          [p.center[0], p.center[1] + d / 2, w + 0.3, 0.3],
          [p.center[0] - w / 2, p.center[1], 0.3, d + 0.3],
          [p.center[0] + w / 2, p.center[1], 0.3, d + 0.3],
        ]
        for (const [x, z, sx, sz] of edges) {
          o.position.set(x, 0.09, z)
          o.scale.set(sx, 0.18, sz)
          o.rotation.set(0, 0, 0)
          o.updateMatrix()
          bundRef.current.setMatrixAt(i++, o.matrix)
        }
      }
      bundRef.current.instanceMatrix.needsUpdate = true
    }
    if (houseRef.current && roofRef.current) {
      PLOTS.forEach((p, i) => {
        o.position.set(p.pump[0], 0.4, p.pump[1])
        o.scale.setScalar(1)
        o.rotation.set(0, 0, 0)
        o.updateMatrix()
        houseRef.current!.setMatrixAt(i, o.matrix)
        o.position.set(p.pump[0], 0.84, p.pump[1])
        o.rotation.set(0.12, 0, 0)
        o.updateMatrix()
        roofRef.current!.setMatrixAt(i, o.matrix)
      })
      houseRef.current.instanceMatrix.needsUpdate = true
      roofRef.current.instanceMatrix.needsUpdate = true
    }
  }, [])

  // --- per-plot soil and water meshes (individual materials for glow / wetness)
  const plotMats = useMemo(
    () =>
      PLOTS.map((p) => {
        const soil = FARMS.find((f) => f.id === p.id)!.soil
        return new MeshStandardMaterial({ color: SOIL_COLOR[soil] ?? '#7b6146', roughness: 1, emissive: new Color('#f2a900'), emissiveIntensity: 0 })
      }),
    [],
  )
  const waterMats = useMemo(
    () => PLOTS.map(() => new MeshStandardMaterial({ color: '#3d82c8', transparent: true, opacity: 0, roughness: 0.15, metalness: 0.1, depthWrite: false })),
    [],
  )
  const lampMats = useMemo(() => PLOTS.map(() => new MeshStandardMaterial({ color: '#3a3a36', emissive: new Color('#000000'), emissiveIntensity: 1.6, roughness: 0.4 })), [])
  const wet = useRef(PLOTS.map(() => 0))

  const outline = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 3))
    return new LineLoop(g, new LineBasicMaterial({ color: '#f2a900', transparent: true, opacity: 1 }))
  }, [])
  const [hover, setHover] = useState<number | null>(null)

  useFrame((state, delta) => {
    const d = dyn.current
    if (!d) return
    const t = state.clock.elapsedTime
    PLOTS.forEach((p, i) => {
      const running = d.active.has(p.id)
      const target = d.moisture.has(p.id) ? d.moisture.get(p.id)! * 0.35 : running ? 0.42 : 0.04
      wet.current[i] += (target - wet.current[i]) * Math.min(1, delta * (running ? 0.9 : 0.5))
      waterMats[i].opacity = Math.max(0, wet.current[i] + (running ? 0.06 * Math.sin(t * 2 + i) : 0) + d.rain * 0.3)
      const order = (p.id - 1) / 20
      const lit = Math.max(0, Math.min(1, (d.illuminate - order * 0.8) * 5))
      const hl = d.highlight === p.id || selected === p.id || hover === p.id ? 0.18 + 0.08 * Math.sin(t * 3) : 0
      plotMats[i].emissiveIntensity = lit * (0.35 + 0.15 * Math.sin(t * 2 + i)) + hl
      const lamp = lampMats[i]
      if (running) {
        lamp.emissive.set(d.overload ? (Math.sin(t * 10) > 0 ? '#ff3a1a' : '#400') : '#5dff8a')
      } else lamp.emissive.set('#000000')
    })
    outline.visible = selected != null
    if (selected != null) {
      const p = PLOTS.find((pl) => pl.id === selected)
      if (p) {
        outline.position.set(p.center[0], 0.22, p.center[1])
        outline.scale.set(p.size[0] + 0.9 + Math.sin(t * 3) * 0.15, 1, p.size[1] + 0.9 + Math.sin(t * 3) * 0.15)
      }
    }
  })

  const bundCount = PLOTS.length * 4
  return (
    <group>
      {PLOTS.map((p, i) => (
        <mesh
          key={p.id}
          geometry={geos.plot}
          material={plotMats[i]}
          position={[p.center[0], 0.04, p.center[1]]}
          scale={[p.size[0], 1, p.size[1]]}
          receiveShadow
          onClick={interactive && onSelect ? (e) => (e.stopPropagation(), onSelect(p.id)) : undefined}
          onPointerOver={interactive ? (e) => (e.stopPropagation(), setHover(p.id), (document.body.style.cursor = 'pointer')) : undefined}
          onPointerOut={interactive ? () => (setHover(null), (document.body.style.cursor = '')) : undefined}
        />
      ))}
      {PLOTS.map((p, i) => (
        <mesh key={`w${p.id}`} material={waterMats[i]} position={[p.center[0], 0.1, p.center[1]]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
          <planeGeometry args={[p.size[0] - 0.2, p.size[1] - 0.2]} />
        </mesh>
      ))}
      <instancedMesh ref={bundRef} args={[geos.bund, undefined, bundCount]} receiveShadow>
        <meshStandardMaterial color="#9b8a5e" roughness={1} />
      </instancedMesh>
      {(Object.keys(cropRefs) as CropKey[]).map((crop) => (
        <instancedMesh key={crop} ref={cropRefs[crop]} args={[geos[crop], undefined, Math.max(1, plants.byCrop[crop].length)]} castShadow={tier === 'high'} receiveShadow>
          <meshStandardMaterial flatShading roughness={0.9} />
        </instancedMesh>
      ))}
      <instancedMesh ref={accentRef} args={[geos.accent, undefined, Math.max(1, plants.accents.length)]}>
        <meshStandardMaterial roughness={0.7} />
      </instancedMesh>
      <instancedMesh ref={houseRef} args={[geos.house, undefined, PLOTS.length]} castShadow receiveShadow>
        <meshStandardMaterial color="#e3dccd" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={roofRef} args={[geos.roof, undefined, PLOTS.length]} castShadow>
        <meshStandardMaterial color="#9aa3a6" roughness={0.5} metalness={0.4} />
      </instancedMesh>
      {PLOTS.map((p, i) => (
        <mesh key={`l${p.id}`} geometry={geos.lamp} material={lampMats[i]} position={[p.pump[0], 1.12, p.pump[1]]} />
      ))}
      <primitive object={outline} />
    </group>
  )
}
