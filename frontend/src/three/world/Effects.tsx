import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, type RefObject } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, NormalBlending, ShaderMaterial } from 'three'
import type { Tier } from '@/lib/device'
import type { Dynamics } from './dynamics'
import { PLOTS, along, plotById, rng } from './layout'

const pointVertex = /* glsl */ `
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uSize;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (60.0 / max(1.0, -mv.z));
  }
`
const pointFragment = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * (1.0 + a * 0.6), a);
  }
`

function pointMaterial(size: number) {
  return new ShaderMaterial({
    vertexShader: pointVertex,
    fragmentShader: pointFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uSize: { value: size }, uPixelRatio: { value: 1 } },
  })
}

const SUN = new Color('#ffbf2e')
const HOT = new Color('#ff4a24')

/** Energy moving from the substation, along the feeder, into each running pump. */
export function EnergyFlow({ dyn, tier }: { dyn: RefObject<Dynamics>; tier: Tier }) {
  const { gl } = useThree()
  const perPlot = tier === 'low' ? 6 : tier === 'mid' ? 10 : 14
  const count = PLOTS.length * perPlot
  const { geometry, phases, fades } = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
    g.setAttribute('aAlpha', new BufferAttribute(new Float32Array(count), 1))
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(count * 3), 3))
    const r = rng(5)
    return { geometry: g, phases: Array.from({ length: count }, () => r()), fades: new Float32Array(PLOTS.length) }
  }, [count])
  const material = useMemo(() => pointMaterial(tier === 'low' ? 5 : 6.5), [tier])
  const lengths = useMemo(
    () => PLOTS.map((p) => p.path.reduce((acc, v, i, a) => (i ? acc + Math.hypot(v[0] - a[i - 1][0], v[2] - a[i - 1][2]) : 0), 0)),
    [],
  )

  useFrame((state, delta) => {
    const d = dyn.current
    if (!d) return
    material.uniforms.uPixelRatio.value = gl.getPixelRatio()
    const t = state.clock.elapsedTime
    const pos = geometry.attributes.position.array as Float32Array
    const alpha = geometry.attributes.aAlpha.array as Float32Array
    const col = geometry.attributes.aColor.array as Float32Array
    const color = d.overload ? HOT : SUN
    PLOTS.forEach((p, pi) => {
      const on = d.active.has(p.id)
      fades[pi] += ((on ? 1 : 0) - fades[pi]) * Math.min(1, delta * 3)
      for (let k = 0; k < perPlot; k++) {
        const i = pi * perPlot + k
        const speed = (9 * d.flowSpeed) / lengths[pi]
        const u = (phases[i] + t * speed) % 1
        const v = along(p.path, u)
        pos[i * 3] = v[0]
        pos[i * 3 + 1] = v[1] + 0.06
        pos[i * 3 + 2] = v[2]
        alpha[i] = fades[pi] * (0.55 + 0.45 * Math.sin(u * Math.PI))
        col[i * 3] = color.r
        col[i * 3 + 1] = color.g
        col[i * 3 + 2] = color.b
      }
    })
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aAlpha.needsUpdate = true
    geometry.attributes.aColor.needsUpdate = true
  })

  return <points geometry={geometry} material={material} frustumCulled={false} />
}

/** Water running from the pump house along the plot's head channel. */
export function WaterFlow({ dyn, tier }: { dyn: RefObject<Dynamics>; tier: Tier }) {
  const { gl } = useThree()
  const per = tier === 'low' ? 5 : 9
  const count = PLOTS.length * per
  const { geometry, phases, fades, paths } = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
    g.setAttribute('aAlpha', new BufferAttribute(new Float32Array(count), 1))
    const c = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) c.set([0.35, 0.65, 1.0], i * 3)
    g.setAttribute('aColor', new BufferAttribute(c, 3))
    const r = rng(9)
    const paths = PLOTS.map((p) => {
      const [cx, cz] = p.center
      const [w, d] = p.size
      // head channel: from the pump along the nearest plot edge
      const horizontal = Math.abs(p.pump[1] - cz) > Math.abs(p.pump[0] - cx)
      const y = 0.16
      return horizontal
        ? [[p.pump[0], y, p.pump[1]], [cx - w / 2 + 0.4, y, cz + Math.sign(p.pump[1] - cz) * (d / 2 - 0.4)], [cx + w / 2 - 0.4, y, cz + Math.sign(p.pump[1] - cz) * (d / 2 - 0.4)]] as [number, number, number][]
        : [[p.pump[0], y, p.pump[1]], [cx + Math.sign(p.pump[0] - cx) * (w / 2 - 0.4), y, cz - d / 2 + 0.4], [cx + Math.sign(p.pump[0] - cx) * (w / 2 - 0.4), y, cz + d / 2 - 0.4]] as [number, number, number][]
    })
    return { geometry: g, phases: Array.from({ length: count }, () => r()), fades: new Float32Array(PLOTS.length), paths }
  }, [count])
  const material = useMemo(() => pointMaterial(4.5), [])
  useFrame((state, delta) => {
    const d = dyn.current
    if (!d) return
    material.uniforms.uPixelRatio.value = gl.getPixelRatio()
    const t = state.clock.elapsedTime
    const pos = geometry.attributes.position.array as Float32Array
    const alpha = geometry.attributes.aAlpha.array as Float32Array
    PLOTS.forEach((p, pi) => {
      fades[pi] += ((d.active.has(p.id) ? 1 : 0) - fades[pi]) * Math.min(1, delta * 2)
      for (let k = 0; k < per; k++) {
        const i = pi * per + k
        const u = (phases[i] + t * 0.18) % 1
        const v = along(paths[pi], u)
        pos.set(v, i * 3)
        alpha[i] = fades[pi] * 0.9
      }
    })
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aAlpha.needsUpdate = true
  })
  return <points geometry={geometry} material={material} frustumCulled={false} />
}

/** Rain streaks around the camera; intensity from dyn.rain. */
export function Rain({ dyn }: { dyn: RefObject<Dynamics> }) {
  const { camera, gl } = useThree()
  const count = 2600
  const { geometry, speeds } = useMemo(() => {
    const g = new BufferGeometry()
    const r = rng(3)
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) pos.set([(r() - 0.5) * 120, r() * 45, (r() - 0.5) * 120], i * 3)
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    g.setAttribute('aAlpha', new Float32BufferAttribute(new Float32Array(count).fill(0), 1))
    const c = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) c.set([0.75, 0.82, 0.9], i * 3)
    g.setAttribute('aColor', new Float32BufferAttribute(c, 3))
    return { geometry: g, speeds: Array.from({ length: count }, () => 22 + r() * 14) }
  }, [])
  const material = useMemo(() => {
    const m = pointMaterial(3)
    m.blending = NormalBlending // reads better than additive for rain
    return m
  }, [])
  useFrame((_, delta) => {
    const d = dyn.current
    if (!d) return
    material.uniforms.uPixelRatio.value = gl.getPixelRatio()
    const pos = geometry.attributes.position.array as Float32Array
    const alpha = geometry.attributes.aAlpha.array as Float32Array
    const visible = d.rain > 0.01
    for (let i = 0; i < count; i++) {
      alpha[i] = visible && i / count < d.rain ? 0.55 : 0
      if (!visible) continue
      pos[i * 3 + 1] -= speeds[i] * delta
      if (pos[i * 3 + 1] < 0) {
        pos[i * 3] = camera.position.x + (Math.random() - 0.5) * 120
        pos[i * 3 + 1] = 40 + Math.random() * 8
        pos[i * 3 + 2] = camera.position.z - 30 + (Math.random() - 0.5) * 120
      }
    }
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aAlpha.needsUpdate = true
  })
  return <points geometry={geometry} material={material} frustumCulled={false} />
}

const soilVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const soilFragment = /* glsl */ `
  uniform float uTime;
  uniform vec2 uSize;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) { float f = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { f += a * noise(p); p *= 2.03; a *= 0.5; } return f; }
  void main() {
    vec2 p = vUv * uSize;
    float depth = 1.0 - vUv.y;
    float n = fbm(p * 2.6);
    float b1 = 0.12 + 0.025 * sin(p.x * 1.7) + 0.03 * (n - 0.5);
    float b2 = 0.46 + 0.05 * sin(p.x * 0.9 + 1.0) + 0.05 * (n - 0.5);
    vec3 col = depth < b1 ? vec3(0.21, 0.15, 0.10) : depth < b2 ? vec3(0.46, 0.26, 0.15) : vec3(0.60, 0.46, 0.31);
    col *= 0.78 + 0.38 * n;
    float grain = noise(p * 30.0);
    col += step(0.86, grain) * (depth > b2 ? 0.14 : 0.06);
    float front = 0.2 + 0.1 * sin(uTime * 0.35);
    float wet = smoothstep(front + 0.14, front - 0.06, depth);
    col = mix(col, col * 0.58 + vec3(0.0, 0.025, 0.06), wet * 0.85);
    float edge = smoothstep(0.0, 0.015, vUv.x) * smoothstep(0.0, 0.015, 1.0 - vUv.x) * smoothstep(0.0, 0.02, vUv.y);
    gl_FragColor = vec4(col * (0.55 + 0.45 * edge), 1.0);
    #include <colorspace_fragment>
  }
`

/** Cut-away soil profile at the edge of Farm 07: the hero's opening shot. */
export function SoilProfile({ dyn }: { dyn: RefObject<Dynamics> }) {
  const plot = plotById(7)!
  const w = 8
  const h = 3.4
  const face: [number, number, number] = [plot.center[0], -h / 2, plot.center[1] + plot.size[1] / 2 + 0.55]
  const material = useMemo(
    () => new ShaderMaterial({ vertexShader: soilVertex, fragmentShader: soilFragment, uniforms: { uTime: { value: 0 }, uSize: { value: [w, h] } } }),
    [],
  )
  const { gl } = useThree()
  const drops = 520
  const { geometry, seeds } = useMemo(() => {
    const g = new BufferGeometry()
    const r = rng(17)
    g.setAttribute('position', new BufferAttribute(new Float32Array(drops * 3), 3))
    g.setAttribute('aAlpha', new BufferAttribute(new Float32Array(drops), 1))
    const c = new Float32Array(drops * 3)
    for (let i = 0; i < drops; i++) c.set([0.32, 0.62, 1.0], i * 3)
    g.setAttribute('aColor', new BufferAttribute(c, 3))
    return { geometry: g, seeds: Array.from({ length: drops }, () => [r(), r(), r(), r()] as const) }
  }, [])
  const dropMat = useMemo(() => pointMaterial(0.2), []) // near-field: the profile is ~3 units from the camera
  const roots = useMemo(() => {
    const r = rng(23)
    const pts: number[] = []
    for (let k = 0; k < 16; k++) {
      let x = face[0] - w / 2 + 0.4 + (k / 15) * (w - 0.8)
      let y = 0
      const depth = 0.9 + r() * 1.1
      while (y > -depth) {
        const nx = x + (r() - 0.5) * 0.18
        const ny = y - 0.08 - r() * 0.06
        pts.push(x, y, face[2] + 0.012, nx, ny, face[2] + 0.012)
        if (r() < 0.12) {
          const bx = nx + (r() - 0.5) * 0.5
          pts.push(nx, ny, face[2] + 0.012, bx, ny - 0.18, face[2] + 0.012)
        }
        x = nx
        y = ny
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pts, 3))
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useFrame((state) => {
    const t = state.clock.elapsedTime
    material.uniforms.uTime.value = t
    dropMat.uniforms.uPixelRatio.value = gl.getPixelRatio()
    const vis = dyn.current ? Math.min(1, dyn.current.underground * 1.4 + 0.15) : 1
    const pos = geometry.attributes.position.array as Float32Array
    const alpha = geometry.attributes.aAlpha.array as Float32Array
    for (let i = 0; i < drops; i++) {
      const [sx, sy, sp, sw] = seeds[i]
      const fall = (sy + t * (0.03 + sp * 0.05)) % 1
      const depthFrac = fall * (0.35 + sw * 0.6)
      pos[i * 3] = face[0] - w / 2 + sx * w + Math.sin(t * (0.6 + sp) + i) * 0.08
      pos[i * 3 + 1] = -depthFrac * h
      pos[i * 3 + 2] = face[2] + 0.03 + sw * 0.05
      alpha[i] = vis * (1 - depthFrac) * (0.5 + 0.5 * Math.sin(t * 2 + i))
    }
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aAlpha.needsUpdate = true
  })

  return (
    <group>
      <mesh position={face} material={material}>
        <planeGeometry args={[w, h]} />
      </mesh>
      <mesh position={[face[0], -h / 2, face[2] - 1.22]}>
        <boxGeometry args={[w, h, 2.4]} />
        <meshBasicMaterial color="#0f0a06" />
      </mesh>
      <lineSegments geometry={roots}>
        <lineBasicMaterial color="#efe4cc" transparent opacity={0.7} />
      </lineSegments>
      <points geometry={geometry} material={dropMat} frustumCulled={false} />
    </group>
  )
}

export const SOIL_FACE = (() => {
  const plot = plotById(7)!
  return { x: plot.center[0], z: plot.center[1] + plot.size[1] / 2 + 0.55 }
})()
