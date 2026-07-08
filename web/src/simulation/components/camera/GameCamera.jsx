import { useRef, useEffect, memo } from 'react'
import { useThree, useFrame }       from '@react-three/fiber'
import { OrbitControls }            from '@react-three/drei'
import * as THREE                   from 'three'
import { CAMERA_CONFIG }            from '../../config/simulationConfig'

// Fallback duration when a preset omits `duration`
const DEFAULT_DURATION = 2.8

// Cubic ease — stronger acceleration/deceleration than sine for cinematic intent.
// t=0→slow→fast→slow→t=1. More deliberate than sine; less extreme than quint.
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export const GameCamera = memo(function GameCamera({
  cameraPreset = 'default',
  lerpSpeed    = 0.055, 
  orbitEnabled = true,
  zoomEnabled  = false,
  minDistance  = 0.8,
  maxDistance  = 9,
  instant      = false,
}) {
  const controlsRef   = useRef()
  const { camera }    = useThree()

  // Tween state — all refs, zero per-frame allocation
  const startPos      = useRef(new THREE.Vector3())
  const startTgt      = useRef(new THREE.Vector3())
  const startFov      = useRef(camera.fov)
  const destPos       = useRef(new THREE.Vector3())
  const destTgt       = useRef(new THREE.Vector3())
  const destFov       = useRef(camera.fov)
  // Per-preset transition length (seconds) — set from CAMERA_CONFIG.duration
  const destDuration  = useRef(DEFAULT_DURATION)
  const elapsed       = useRef(DEFAULT_DURATION)
  const settled       = useRef(true)
  const tweenPending  = useRef(false)

  // First mount — snap instantly to the initial preset, no tween
  useEffect(() => {
    const p = CAMERA_CONFIG[cameraPreset] ?? CAMERA_CONFIG.default
    destPos.current.set(...p.position)
    destTgt.current.set(...p.target)
    destFov.current = p.fov ?? 55
    destDuration.current = p.duration ?? DEFAULT_DURATION
    camera.position.copy(destPos.current)
    camera.fov = destFov.current
    camera.updateProjectionMatrix()
    camera.lookAt(...p.target)
    if (controlsRef.current) {
      controlsRef.current.target.copy(destTgt.current)
      controlsRef.current.update()
    }
    startPos.current.copy(destPos.current)
    startTgt.current.copy(destTgt.current)
    startFov.current = destFov.current
    elapsed.current = destDuration.current 
    settled.current = true
    tweenPending.current = false
  }, [])

  // Preset change
  useEffect(() => {
    const p = CAMERA_CONFIG[cameraPreset] ?? CAMERA_CONFIG.default
    destPos.current.set(...p.position)
    destTgt.current.set(...p.target)
    destFov.current = p.fov ?? 55
    destDuration.current = p.duration ?? DEFAULT_DURATION

    if (instant) {
      tweenPending.current = false
      camera.position.copy(destPos.current)
      camera.fov = destFov.current
      camera.updateProjectionMatrix()
      camera.lookAt(...p.target)
      if (controlsRef.current) {
        controlsRef.current.target.copy(destTgt.current)
        controlsRef.current.update()
      }
      startPos.current.copy(destPos.current)
      startTgt.current.copy(destTgt.current)
      startFov.current = destFov.current
      elapsed.current = destDuration.current
      settled.current = true
    } else {
      tweenPending.current = true
      settled.current = false
    }
  }, [cameraPreset, instant]) 

  useFrame((_, delta) => {
    if (settled.current) return

    if (tweenPending.current) {
      startPos.current.copy(camera.position)
      startTgt.current.copy(
        controlsRef.current ? controlsRef.current.target : destTgt.current
      )
      startFov.current = camera.fov
      elapsed.current = 0
      tweenPending.current = false
    }

    // Advance tween with per-preset duration
    const duration = destDuration.current
    elapsed.current = Math.min(elapsed.current + delta, duration)
    const t     = elapsed.current / duration
    const eased = easeInOutCubic(t) 

    // Position — linear lerp on eased t (straight-line arc between positions)
    camera.position.lerpVectors(startPos.current, destPos.current, eased)

    // FOV — smooth tween in tandem with position
    const newFov = startFov.current + (destFov.current - startFov.current) * eased
    if (Math.abs(camera.fov - newFov) > 0.01) {
      camera.fov = newFov
      camera.updateProjectionMatrix()
    }

    // Target / lookAt — drive orientation directly during tween.
    const tx = startTgt.current.x + (destTgt.current.x - startTgt.current.x) * eased
    const ty = startTgt.current.y + (destTgt.current.y - startTgt.current.y) * eased
    const tz = startTgt.current.z + (destTgt.current.z - startTgt.current.z) * eased
    if (controlsRef.current) controlsRef.current.target.set(tx, ty, tz)
    camera.lookAt(tx, ty, tz)

    // Tween complete — sync OrbitControls then re-snap to exact dest values.
    if (t >= 1) {
      if (controlsRef.current) {
        controlsRef.current.target.copy(destTgt.current)
        controlsRef.current.update()
      }
      camera.position.copy(destPos.current)
      camera.fov = destFov.current
      camera.updateProjectionMatrix()
      camera.lookAt(destTgt.current.x, destTgt.current.y, destTgt.current.z)
      startPos.current.copy(destPos.current)
      startTgt.current.copy(destTgt.current)
      startFov.current = destFov.current
      settled.current = true
    }
  }, -2)

  const initPreset = CAMERA_CONFIG[cameraPreset] ?? CAMERA_CONFIG.default

  return (
    <OrbitControls
      ref={controlsRef}
      target={initPreset.target}
      minDistance={minDistance}
      maxDistance={maxDistance}
      maxPolarAngle={Math.PI * 0.47}
      minPolarAngle={0.05}
      enableDamping
      dampingFactor={0.08}
      enablePan={false}
      enableRotate={orbitEnabled}      
      rotateSpeed={0.45}
      zoomSpeed={0.65}
      enabled={orbitEnabled || zoomEnabled}
    />
  )
})
