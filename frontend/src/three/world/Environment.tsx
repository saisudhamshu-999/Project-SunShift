import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { BackSide, Color, DirectionalLight, Fog, HemisphereLight, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three'
import type { Dynamics } from './dynamics'

const UNDERGROUND = new Color('#140e09')

const vertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`

const fragment = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uSunVis;
  uniform float uUnder;
  uniform vec3 uUnderColor;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float t = pow(clamp(h, 0.0, 1.0), 0.5);
    vec3 col = mix(uHorizon, uTop, t);
    col = mix(col, uHorizon * 0.9, smoothstep(0.0, -0.25, h));
    float s = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * (pow(s, 1400.0) * 2.4 + pow(s, 260.0) * 0.5 + pow(s, 9.0) * 0.16) * uSunVis;
    col = mix(col, uUnderColor, uUnder);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

export function Environment({ dyn, shadows = false }: { dyn: RefObject<Dynamics>; shadows?: boolean }) {
  const { scene, camera } = useThree()
  const sky = useRef<Mesh>(null)
  const sunLight = useRef<DirectionalLight>(null)
  const hemi = useRef<HemisphereLight>(null)
  const geometry = useMemo(() => new SphereGeometry(1, 32, 16), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        side: BackSide,
        depthWrite: false,
        uniforms: {
          uTop: { value: new Color() },
          uHorizon: { value: new Color() },
          uSunDir: { value: new Vector3(0, 1, 0) },
          uSunColor: { value: new Color('#fff3d6') },
          uSunVis: { value: 1 },
          uUnder: { value: 0 },
          uUnderColor: { value: UNDERGROUND.clone() },
        },
      }),
    [],
  )
  const fog = useMemo(() => new Fog('#efe6d3', 120, 520), [])
  const fogColor = useMemo(() => new Color(), [])

  useEffect(() => {
    scene.fog = fog
    return () => {
      scene.fog = null
    }
  }, [scene, fog])

  useFrame(() => {
    const d = dyn.current
    if (!d) return
    const s = d.sun
    const u = material.uniforms
    u.uTop.value.copy(s.skyTop)
    u.uHorizon.value.copy(s.skyHorizon)
    u.uSunDir.value.copy(s.dir)
    u.uSunColor.value.copy(s.light)
    u.uSunVis.value = Math.max(0, Math.min(1, (s.elevation + 3) / 6)) * (1 - d.rain * 0.85)
    u.uUnder.value = d.underground
    if (sky.current) {
      sky.current.position.copy(camera.position)
      sky.current.scale.setScalar(900)
    }
    fogColor.copy(s.skyHorizon).lerp(UNDERGROUND, d.underground)
    if (d.rain > 0) fogColor.lerp(new Color('#8a8f94'), d.rain * 0.6)
    fog.color.copy(fogColor)
    // near must stay below far: GLSL smoothstep is undefined with inverted edges
    const under = d.underground
    fog.near = (90 - d.rain * 50) * (1 - under) + 8 * under
    fog.far = Math.max(fog.near + 20, (560 - d.rain * 300) * (1 - under) + 60 * under)
    if (sunLight.current) {
      const l = sunLight.current
      l.position.copy(s.dir).multiplyScalar(160)
      l.color.copy(s.light)
      l.intensity = s.intensity * (1 - d.rain * 0.6) * (s.elevation > -2 ? 1 : 0)
    }
    if (hemi.current) {
      hemi.current.color.copy(s.skyTop)
      hemi.current.groundColor.copy(s.ground)
      hemi.current.intensity = 0.55 + s.ambient * 0.9
    }
  })

  return (
    <>
      <mesh ref={sky} geometry={geometry} material={material} frustumCulled={false} renderOrder={-1} />
      <hemisphereLight ref={hemi} args={['#b4cde3', '#8a7356', 1.2]} />
      <directionalLight
        ref={sunLight}
        castShadow={shadows}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={10}
        shadow-camera-far={400}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
      />
    </>
  )
}
