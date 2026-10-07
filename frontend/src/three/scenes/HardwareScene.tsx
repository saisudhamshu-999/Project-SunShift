import { RoundedBox } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef, type RefObject } from 'react'
import { CatmullRomCurve3, Group, MeshStandardMaterial, TubeGeometry, Vector3 } from 'three'

export const PARTS = [
  'ESP32 controller',
  'Relay interface',
  'Contactor',
  'Protection relays',
  'Manual override',
  'Pump motor',
] as const

const SIGNAL = '#2f74c0'
const POWER = '#e08a00'

/** Exploded controller: parts separate as `explode` goes 0 -> 1; `active` highlights one part. */
export function HardwareScene({ explode, active }: { explode: RefObject<number>; active: RefObject<number> }) {
  const { camera, pointer } = useThree()
  const parts = useRef<(Group | null)[]>([])
  const enclosure = useRef<MeshStandardMaterial>(null)
  const smooth = useRef(0)
  const builtAt = useRef(-1)
  // Collapsed and exploded y for each part (top -> bottom follows the signal chain).
  const collapsed = [1.25, 0.55, -0.15, -0.85, -1.45, -2.6]
  const exploded = [3.7, 2.3, 0.85, -0.6, -1.95, -3.7]
  const look = useMemo(() => new Vector3(0.5, 0, 0), [])
  const highlightMats = useMemo(() => PARTS.map(() => new MeshStandardMaterial({ color: '#f2a900', emissive: '#f2a900', emissiveIntensity: 0.6, transparent: true, opacity: 0 })), [])

  const wires = useMemo(() => {
    // signal wires (blue) between controller and relay; power wires (amber) below
    return [0, 1, 2, 3, 4].map((i) => ({ i, color: i === 0 ? SIGNAL : POWER }))
  }, [])
  const wireMeshes = useRef<({ geometry: TubeGeometry } | null)[]>([])

  useFrame((state, delta) => {
    smooth.current += ((explode.current ?? 0) - smooth.current) * Math.min(1, delta * 4)
    const e = smooth.current
    const ys = collapsed.map((c, i) => c + (exploded[i] - c) * e)
    parts.current.forEach((g, i) => {
      if (!g) return
      g.position.y = ys[i]
      g.rotation.y = Math.sin(state.clock.elapsedTime * 0.3 + i) * 0.08 * e
    })
    if (enclosure.current) enclosure.current.opacity = 0.32 * (1 - Math.min(1, e * 1.6))
    const a = active.current ?? -1
    highlightMats.forEach((m, i) => (m.opacity = i === a ? 0.18 + 0.08 * Math.sin(state.clock.elapsedTime * 4) : 0))
    if (Math.abs(e - builtAt.current) > 0.002) {
      builtAt.current = e
      wires.forEach((_, k) => {
        const mesh = wireMeshes.current[k]
        if (!mesh) return
        const x = k === 0 ? -0.55 : 0.6
        const curve = new CatmullRomCurve3([new Vector3(x, ys[k] - 0.2, 0.3), new Vector3(x + 0.25, (ys[k] + ys[k + 1]) / 2, 0.45), new Vector3(x, ys[k + 1] + 0.25, 0.3)])
        mesh.geometry.dispose()
        mesh.geometry = new TubeGeometry(curve, 12, 0.035, 6)
      })
    }
    camera.position.x += (pointer.x * 1.2 + 2.2 - camera.position.x) * Math.min(1, delta * 2)
    camera.position.y += (pointer.y * 0.8 + 0.6 - camera.position.y) * Math.min(1, delta * 2)
    camera.lookAt(look)
  })

  const set = (i: number) => (g: Group | null) => void (parts.current[i] = g)

  return (
    <>
      <color attach="background" args={['#1b1a16']} />
      <hemisphereLight args={['#fff4e0', '#2b2925', 1.2]} />
      <directionalLight position={[5, 8, 6]} intensity={2.4} />
      <directionalLight position={[-6, 2, -4]} intensity={0.6} color="#9cc8ff" />

      {/* panel enclosure, visible when collapsed */}
      <mesh position={[0, -0.6, 0]}>
        <boxGeometry args={[3.2, 4.6, 1.4]} />
        <meshStandardMaterial ref={enclosure} color="#d9d3c6" transparent opacity={0.3} depthWrite={false} />
      </mesh>

      {/* ESP32 */}
      <group ref={set(0)}>
        <RoundedBox args={[1.6, 0.1, 0.9]} radius={0.03} position={[0, 0, 0]}>
          <meshStandardMaterial color="#1f5f3a" roughness={0.6} />
        </RoundedBox>
        <mesh position={[-0.2, 0.1, 0]}>
          <boxGeometry args={[0.7, 0.1, 0.55]} />
          <meshStandardMaterial color="#b8bcc0" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0.55, 0.08, 0.25]}>
          <boxGeometry args={[0.3, 0.06, 0.18]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
        {Array.from({ length: 12 }, (_, i) => (
          <mesh key={i} position={[-0.7 + i * 0.125, 0.07, -0.4]}>
            <boxGeometry args={[0.04, 0.05, 0.04]} />
            <meshStandardMaterial color="#d4b24a" metalness={0.8} />
          </mesh>
        ))}
        <mesh material={highlightMats[0]}>
          <boxGeometry args={[1.8, 0.4, 1.1]} />
        </mesh>
      </group>

      {/* Opto-isolated relay module */}
      <group ref={set(1)}>
        <RoundedBox args={[1.3, 0.08, 0.8]} radius={0.02}>
          <meshStandardMaterial color="#1d3f73" />
        </RoundedBox>
        {[-0.3, 0.3].map((x) => (
          <mesh key={x} position={[x, 0.22, 0]}>
            <boxGeometry args={[0.45, 0.38, 0.5]} />
            <meshStandardMaterial color={SIGNAL} roughness={0.5} />
          </mesh>
        ))}
        <mesh material={highlightMats[1]}>
          <boxGeometry args={[1.5, 0.7, 1]} />
        </mesh>
      </group>

      {/* Contactor */}
      <group ref={set(2)}>
        <RoundedBox args={[1.1, 0.75, 0.85]} radius={0.06}>
          <meshStandardMaterial color="#8d9397" roughness={0.5} metalness={0.2} />
        </RoundedBox>
        <mesh position={[0, 0.2, 0.44]}>
          <boxGeometry args={[0.6, 0.2, 0.04]} />
          <meshStandardMaterial color={POWER} />
        </mesh>
        {[-0.35, 0, 0.35].map((x) => (
          <mesh key={x} position={[x, 0.43, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 0.12, 8]} />
            <meshStandardMaterial color="#c9a227" metalness={0.8} roughness={0.3} />
          </mesh>
        ))}
        <mesh material={highlightMats[2]}>
          <boxGeometry args={[1.3, 1, 1.05]} />
        </mesh>
      </group>

      {/* Protection: overload, phase failure, dry-run */}
      <group ref={set(3)}>
        {[-0.62, 0, 0.62].map((x, i) => (
          <group key={x} position={[x, 0, 0]}>
            <RoundedBox args={[0.5, 0.6, 0.7]} radius={0.04}>
              <meshStandardMaterial color={['#e6e1d6', '#cfd4d6', '#e6e1d6'][i]} roughness={0.6} />
            </RoundedBox>
            <mesh position={[0, 0.12, 0.36]}>
              <circleGeometry args={[0.06, 16]} />
              <meshStandardMaterial color="#4c8a3b" emissive="#5dff8a" emissiveIntensity={0.9} />
            </mesh>
          </group>
        ))}
        <mesh material={highlightMats[3]}>
          <boxGeometry args={[1.9, 0.85, 0.9]} />
        </mesh>
      </group>

      {/* Manual override selector: AUTO / OFF / MANUAL */}
      <group ref={set(4)}>
        <RoundedBox args={[0.9, 0.5, 0.35]} radius={0.05}>
          <meshStandardMaterial color="#2b2925" />
        </RoundedBox>
        <mesh position={[0, 0, 0.2]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.16, 0.16, 0.08, 20]} />
          <meshStandardMaterial color="#d04a2f" />
        </mesh>
        <mesh position={[0, 0.02, 0.26]} rotation={[0, 0, 0.6]}>
          <boxGeometry args={[0.24, 0.05, 0.03]} />
          <meshStandardMaterial color="#f3eee4" />
        </mesh>
        <mesh material={highlightMats[4]}>
          <boxGeometry args={[1.1, 0.7, 0.55]} />
        </mesh>
      </group>

      {/* Submersible pump and motor */}
      <group ref={set(5)} rotation={[0, 0, Math.PI / 2]}>
        <mesh>
          <cylinderGeometry args={[0.38, 0.38, 2.6, 24]} />
          <meshStandardMaterial color="#a9b1b5" metalness={0.75} roughness={0.32} />
        </mesh>
        {Array.from({ length: 6 }, (_, i) => (
          <mesh key={i} position={[0, -0.9 + i * 0.36, 0]}>
            <torusGeometry args={[0.39, 0.025, 6, 24]} />
            <meshStandardMaterial color="#7f878b" metalness={0.8} />
          </mesh>
        ))}
        <mesh position={[0, 1.42, 0]}>
          <cylinderGeometry args={[0.22, 0.38, 0.25, 24]} />
          <meshStandardMaterial color="#2f74c0" metalness={0.4} />
        </mesh>
        <mesh material={highlightMats[5]}>
          <cylinderGeometry args={[0.55, 0.55, 2.9, 20]} />
        </mesh>
      </group>

      {wires.map((w, k) => (
        <mesh key={k} ref={(m) => void (wireMeshes.current[k] = m as never)}>
          <tubeGeometry args={[new CatmullRomCurve3([new Vector3(0, 0, 0), new Vector3(0, -1, 0)]), 4, 0.03, 6]} />
          <meshStandardMaterial color={w.color} emissive={w.color} emissiveIntensity={0.35} />
        </mesh>
      ))}
    </>
  )
}
