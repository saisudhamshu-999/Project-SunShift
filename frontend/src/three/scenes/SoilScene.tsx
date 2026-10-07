import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef, type RefObject } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, ConeGeometry, Float32BufferAttribute, IcosahedronGeometry, Mesh, ShaderMaterial, Vector3 } from 'three'
import type { CropKey } from '@/api/types'
import { LabelProjector, type LabelRegistry } from '../common/ProjectedLabels'
import { rng } from '../world/layout'

export interface SoilState {
  fill: number // 0..1 available water in the root zone
  rawFrac: number // RAW / TAW
  rootDepthM: number
  et: number // 0..1 evapotranspiration intensity
  rainAt: number // clock time of the last rain burst
  irrigateAt: number
  drainAt: number
}

const W = 6
const H = 4.2
const M = 2.6 // scene units per metre of soil

const faceVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const faceFragment = /* glsl */ `
  uniform float uRoot;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
  float fbm(vec2 p) { float f = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { f += a*noise(p); p *= 2.03; a *= 0.5; } return f; }
  void main() {
    vec2 p = vUv * vec2(6.0, 4.2);
    float depth = 1.0 - vUv.y;
    float n = fbm(p * 2.4);
    float b1 = 0.1 + 0.02 * sin(p.x * 1.9) + 0.03 * (n - 0.5);
    float b2 = 0.5 + 0.04 * sin(p.x * 1.1) + 0.04 * (n - 0.5);
    vec3 col = depth < b1 ? vec3(0.22, 0.16, 0.11) : depth < b2 ? vec3(0.45, 0.27, 0.16) : vec3(0.58, 0.45, 0.31);
    col *= 0.8 + 0.34 * n;
    col += step(0.87, noise(p * 26.0)) * 0.08;
    float rz = uRoot / 4.2;
    col *= depth < rz ? 1.0 : 0.72;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

const dotV = /* glsl */ `
  attribute float aAlpha; uniform float uPx; varying float vA;
  void main() { vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = uPx * (10.0 / -mv.z); }
`
const dotF = /* glsl */ `
  uniform vec3 uColor; varying float vA;
  void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d) * vA; if (a < 0.01) discard; gl_FragColor = vec4(uColor, a); }
`

function dots(color: string, px: number) {
  return new ShaderMaterial({ vertexShader: dotV, fragmentShader: dotF, transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uPx: { value: px }, uColor: { value: new Color(color) } } })
}

function useParticles(count: number) {
  return useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
    g.setAttribute('aAlpha', new BufferAttribute(new Float32Array(count), 1))
    const r = rng(count)
    return { g, seeds: Array.from({ length: count }, () => [r(), r(), r()] as const) }
  }, [count])
}

/** Anchors for the three threshold labels the section renders as DOM. */
export const SOIL_LABELS = ['fc', 'raw', 'wp'] as const

export function SoilScene({ state, crop, rawFrac, rootDepthM, labels }: { state: RefObject<SoilState>; crop: CropKey; rawFrac: number; rootDepthM: number; labels?: LabelRegistry }) {
  const { gl, camera, pointer } = useThree()
  const face = useMemo(() => new ShaderMaterial({ vertexShader: faceVertex, fragmentShader: faceFragment, uniforms: { uRoot: { value: 2.6 } } }), [])
  const fill = useRef<Mesh>(null)
  const surface = useRef<Mesh>(null)
  const fillLevel = useRef(0.5)
  const rain = useParticles(260)
  const irr = useParticles(160)
  const et = useParticles(140)
  const drain = useParticles(90)
  const mats = useMemo(() => ({ rain: dots('#9cc8ff', 7), irr: dots('#3d8bff', 7), et: dots('#f3eee4', 5), drain: dots('#4fa3ff', 6) }), [])
  const plants = useMemo(() => {
    const r = rng(4)
    return Array.from({ length: 7 }, (_, i) => ({ x: -W / 2 + 0.6 + i * ((W - 1.2) / 6) + (r() - 0.5) * 0.2, s: 0.85 + r() * 0.3 }))
  }, [])
  const plantGeo = useMemo(() => (crop === 'maize' ? new ConeGeometry(0.18, 1.6, 6).translate(0, 0.8, 0) : new IcosahedronGeometry(0.42, 0).translate(0, 0.42, 0)), [crop])
  const roots = useMemo(() => {
    const r = rng(8)
    const pts: number[] = []
    for (const p of plants) {
      for (let k = 0; k < 4; k++) {
        let x = p.x
        let y = 0
        while (y > -1) {
          const nx = x + (r() - 0.5) * 0.25
          const ny = y - 0.12 - r() * 0.08
          pts.push(x, y, 0.03, nx, ny, 0.03)
          x = nx
          y = ny
        }
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pts, 3))
    return g
  }, [plants])
  const rootGroup = useRef<Mesh>(null)
  const look = useMemo(() => new Vector3(0, -1.3, 0), [])

  useFrame((s, delta) => {
    const st = state.current
    if (!st) return
    const t = s.clock.elapsedTime
    const rootH = Math.min(H - 0.3, st.rootDepthM * M)
    face.uniforms.uRoot.value = rootH
    fillLevel.current += (st.fill - fillLevel.current) * Math.min(1, delta * 2.2)
    const fh = Math.max(0.02, fillLevel.current * rootH)
    if (fill.current) {
      fill.current.scale.set(W - 0.1, fh, 1)
      fill.current.position.set(0, -rootH + fh / 2, 0.02)
    }
    if (surface.current) surface.current.position.set(0, -rootH + fh, 0.025)
    if (rootGroup.current) rootGroup.current.scale.set(1, st.rootDepthM * M, 1)
    // gentle parallax towards the pointer
    camera.position.x += (pointer.x * 1.1 - camera.position.x) * Math.min(1, delta * 2)
    camera.position.y += (0.6 + pointer.y * 0.5 - camera.position.y) * Math.min(1, delta * 2)
    camera.lookAt(look)

    const since = (at: number) => (at > 0 ? t - at : 99)
    const update = (sys: ReturnType<typeof useParticles>, fn: (i: number, seed: readonly [number, number, number], pos: Float32Array, alpha: Float32Array) => void) => {
      const pos = sys.g.attributes.position.array as Float32Array
      const alpha = sys.g.attributes.aAlpha.array as Float32Array
      sys.seeds.forEach((seed, i) => fn(i, seed, pos, alpha))
      sys.g.attributes.position.needsUpdate = true
      sys.g.attributes.aAlpha.needsUpdate = true
    }
    const rs = since(st.rainAt)
    update(rain, (i, [a, b, c], pos, alpha) => {
      const life = rs * (0.8 + c * 0.6) - b * 1.2
      const y = 4 - life * 5
      pos[i * 3] = -W / 2 + a * W
      pos[i * 3 + 1] = Math.max(y, -0.6 * c)
      pos[i * 3 + 2] = 0.1 + c * 0.4
      alpha[i] = rs < 3.2 && life > 0 ? (y > 0 ? 0.9 : 0.5 * (1 - life / 2.2)) : 0
    })
    const is = since(st.irrigateAt)
    update(irr, (i, [a, b, c], pos, alpha) => {
      const life = is * 0.9 - b * 1.4
      const x = -W / 2 + Math.min(1, life * 0.55) * W * a + 0.1
      pos[i * 3] = x
      pos[i * 3 + 1] = life < 1 ? 0.05 : -Math.min(rootH * 0.9, (life - 1) * 0.9 * (0.5 + c))
      pos[i * 3 + 2] = 0.08 + c * 0.2
      alpha[i] = is < 4 && life > 0 ? 0.85 : 0
    })
    update(et, (i, [a, b, c], pos, alpha) => {
      const cyc = (t * (0.18 + c * 0.1) + b) % 1
      const p = plants[i % plants.length]
      pos[i * 3] = p.x + (a - 0.5) * 0.6 + Math.sin(t + i) * 0.1
      pos[i * 3 + 1] = 0.4 + cyc * 2.6
      pos[i * 3 + 2] = 0.1 + c * 0.3
      alpha[i] = st.et * (1 - cyc) * 0.55
    })
    const ds = since(st.drainAt)
    update(drain, (i, [a, b, c], pos, alpha) => {
      const life = ds * (0.6 + c * 0.5) - b
      pos[i * 3] = -W / 2 + a * W
      pos[i * 3 + 1] = -rootH - Math.max(0, life) * 1.2
      pos[i * 3 + 2] = 0.06
      alpha[i] = ds < 3.5 && life > 0 && -rootH - life * 1.2 > -H ? 0.8 : 0
    })
    Object.values(mats).forEach((m) => (m.uniforms.uPx.value = 3.2 * gl.getPixelRatio()))
  })

  const rootH = Math.min(H - 0.3, rootDepthM * M)

  return (
    <>
      <color attach="background" args={['#f3eee4']} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 8, 6]} intensity={2.2} />
      <mesh position={[0, -H / 2, 0]} material={face}>
        <planeGeometry args={[W, H]} />
      </mesh>
      <mesh position={[0, -H / 2, -1.5]}>
        <boxGeometry args={[W, H, 3]} />
        <meshStandardMaterial color="#5a4330" />
      </mesh>
      <mesh position={[0, 0.03, -1.5]}>
        <boxGeometry args={[W, 0.06, 3]} />
        <meshStandardMaterial color="#6d5236" />
      </mesh>
      <mesh ref={fill}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial color="#2f74c0" transparent opacity={0.42} depthWrite={false} />
      </mesh>
      <mesh ref={surface}>
        <planeGeometry args={[W - 0.1, 0.035]} />
        <meshBasicMaterial color="#9cc8ff" />
      </mesh>
      <lineSegments geometry={roots} ref={rootGroup as never}>
        <lineBasicMaterial color="#f1e7cf" transparent opacity={0.85} />
      </lineSegments>
      {plants.map((p, i) => (
        <mesh key={i} geometry={plantGeo} position={[p.x, 0.06, -0.4]} scale={p.s}>
          <meshStandardMaterial color="#5a8a3a" flatShading />
        </mesh>
      ))}
      <points geometry={rain.g} material={mats.rain} frustumCulled={false} />
      <points geometry={irr.g} material={mats.irr} frustumCulled={false} />
      <points geometry={et.g} material={mats.et} frustumCulled={false} />
      <points geometry={drain.g} material={mats.drain} frustumCulled={false} />
      {/* Threshold lines; their labels are DOM, positioned by the projector */}
      {[
        { id: 'fc', y: 0, tone: '#2f74c0' },
        { id: 'raw', y: -rootH * rawFrac, tone: '#e08a00' },
        { id: 'wp', y: -rootH, tone: '#d04a2f' },
      ].map((l) => {
        labels?.anchors.set(`soil-${l.id}`, new Vector3(-W / 2 + 0.15, l.y, 0.05))
        return (
          <mesh key={l.id} position={[0, l.y, 0.04]}>
            <planeGeometry args={[W, 0.02]} />
            <meshBasicMaterial color={l.tone} />
          </mesh>
        )
      })}
      {labels && <LabelProjector registry={labels} />}
    </>
  )
}
