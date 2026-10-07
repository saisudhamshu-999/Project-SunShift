import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef, type RefObject } from 'react'
import { BufferGeometry, Color, Float32BufferAttribute, LineDashedMaterial, LineSegments, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import type { PlanResult } from '@/api/types'
import { cellTexture } from '../world/Infrastructure'
import { sunFromAngles } from '../world/sun'

const TILT = (15 * Math.PI) / 180

/** A row of modules under the sun's true position at the scrubbed time. */
export function PanelScene({ plan, slot }: { plan: PlanResult | null; slot: RefObject<number> }) {
  const { camera, pointer } = useThree()
  const sun = useRef<Mesh>(null)
  const panelMat = useMemo(() => new MeshStandardMaterial({ color: '#ffffff', map: cellTexture(), metalness: 0.1, roughness: 0.24, emissive: new Color('#1d3d66'), emissiveIntensity: 0.2 }), [])
  const glowMat = useMemo(() => new MeshStandardMaterial({ color: '#f2a900', emissive: new Color('#f2a900'), emissiveIntensity: 0, transparent: true, opacity: 0 }), [])
  const rays = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(16 * 2 * 3), 3))
    const m = new LineDashedMaterial({ color: '#f2a900', dashSize: 0.6, gapSize: 0.5, transparent: true, opacity: 0.8 })
    const l = new LineSegments(g, m)
    return l
  }, [])
  const targets = useMemo(() => Array.from({ length: 16 }, (_, i) => new Vector3(-4.5 + (i % 8) * 1.28, 1.25 + Math.floor(i / 8) * 0.2, -0.2 + Math.floor(i / 8) * 0.4)), [])
  const look = useMemo(() => new Vector3(-0.4, 0.9, -1.4), [])

  useFrame((state, delta) => {
    const i = Math.max(0, Math.min(47, Math.floor(slot.current ?? 24)))
    const zen = plan?.solar.zenith[i] ?? 40
    const az = plan?.solar.azimuth[i] ?? 140
    const s = sunFromAngles(90 - zen, az)
    const dir = s.dir
    if (sun.current) sun.current.position.copy(dir).multiplyScalar(26).add(new Vector3(0, 0, 0))
    const ghi = plan?.solar.ghi[i] ?? 600
    const ac = plan ? plan.solar.acKw[i] / Math.max(1, plan.solar.peakKw) : 0.7
    panelMat.emissiveIntensity = 0.15 + ac * 0.3
    glowMat.opacity = ac * 0.35
    glowMat.emissiveIntensity = ac * 1.5
    const pos = rays.geometry.attributes.position.array as Float32Array
    targets.forEach((t, k) => {
      const start = t.clone().addScaledVector(dir, 14 + (k % 3) * 2)
      pos.set([start.x, start.y, start.z, t.x, t.y, t.z], k * 6)
    })
    rays.geometry.attributes.position.needsUpdate = true
    rays.computeLineDistances()
    const mat = rays.material as LineDashedMaterial
    mat.opacity = Math.min(0.9, ghi / 900) * (s.elevation > 0 ? 1 : 0)
    ;(mat as unknown as { dashOffset: number }).dashOffset = -state.clock.elapsedTime * 2
    camera.position.x += (6.5 + pointer.x * 1.4 - camera.position.x) * Math.min(1, delta * 2)
    camera.position.y += (6.2 + pointer.y * 0.6 - camera.position.y) * Math.min(1, delta * 2)
    camera.lookAt(look)
  })

  return (
    <>
      <hemisphereLight args={['#dfe9f2', '#9a8566', 1.1]} />
      <directionalLight position={[3, 10, 6]} intensity={1.6} />
      <mesh ref={sun}>
        <sphereGeometry args={[1.1, 24, 16]} />
        <meshBasicMaterial color="#ffd36b" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[600, 600]} />
        <meshStandardMaterial color="#cbb894" roughness={1} />
      </mesh>
      {[0, 1].map((row) => (
        <group key={row} position={[0, 0, row * -2.6]}>
          {Array.from({ length: 8 }, (_, c) => (
            <group key={c} position={[-4.5 + c * 1.28, 0, 0]}>
              <mesh position={[0, 1.35, 0]} rotation={[TILT, 0, 0]} material={panelMat}>
                <boxGeometry args={[1.2, 0.05, 2]} />
              </mesh>
              <mesh position={[0, 1.37, 0]} rotation={[TILT, 0, 0]} material={glowMat}>
                <boxGeometry args={[1.22, 0.06, 2.02]} />
              </mesh>
              {[-0.75, 0.75].map((dz) => (
                <mesh key={dz} position={[0, (1.35 - dz * Math.sin(TILT)) / 2, dz * Math.cos(TILT)]}>
                  <boxGeometry args={[0.06, 1.35 - dz * Math.sin(TILT), 0.06]} />
                  <meshStandardMaterial color="#9da3a6" />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      ))}
      <primitive object={rays} />
    </>
  )
}
