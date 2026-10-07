import { useFrame, useThree } from '@react-three/fiber'
import { useRef } from 'react'
import { Vector3 } from 'three'

/**
 * DOM labels positioned over a canvas without nested React roots (drei <Html> creates one
 * root per label, which breaks when scenes unmount). The section renders ordinary DOM
 * elements and registers them; <LabelProjector> moves them every frame.
 */
export interface LabelRegistry {
  anchors: Map<string, Vector3>
  els: Map<string, HTMLElement>
}

export function useLabelRegistry(): LabelRegistry {
  const ref = useRef<LabelRegistry | null>(null)
  if (!ref.current) ref.current = { anchors: new Map(), els: new Map() }
  return ref.current
}

export function LabelProjector({ registry }: { registry: LabelRegistry }) {
  const { camera, size } = useThree()
  const v = useRef(new Vector3())
  useFrame(() => {
    registry.els.forEach((el, id) => {
      const anchor = registry.anchors.get(id)
      if (!anchor) return
      v.current.copy(anchor).project(camera)
      const behind = v.current.z > 1
      const x = (v.current.x * 0.5 + 0.5) * size.width
      const y = (-v.current.y * 0.5 + 0.5) * size.height
      const off = behind || x < -40 || x > size.width + 40 || y < -20 || y > size.height + 20
      const align = el.dataset.align === 'left' ? 'translate(0, -50%)' : 'translate(-50%, -50%)'
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ${align}`
      el.style.visibility = off ? 'hidden' : 'visible'
    })
  })
  return null
}
