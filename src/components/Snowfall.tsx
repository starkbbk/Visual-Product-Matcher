import React, { useEffect, useRef } from 'react'

type Props = {
  count?: number            // flakes
  speed?: number            // fall speed multiplier
  opacity?: number          // 0..1
  blurPx?: number           // CSS blur for this layer
  parallax?: number         // px shift from mouse
  zIndex?: number
  // Repulsion (cursor pushes flakes away)
  repelRadius?: number      // px radius around cursor
  repelStrength?: number    // 0..3 typical
  repelOnHover?: boolean    // only while moving/hovering
  // NEW: motion responsiveness
  timeScale?: number        // global time multiplier
  parallaxEase?: number     // how quickly parallax follows mouse
  returnEase?: number       // how quickly velocities return to baseline
  hoverDecay?: number       // how fast the “hole” collapses
  className?: string
}

type Flake = {
  x: number; y: number; r: number;
  vx: number; vy: number; vx0: number; vy0: number;
  z: number; phase: number;
}

export default function Snowfall({
  count = 220,
  speed = 1,
  opacity = 0.9,
  blurPx = 0,
  parallax = 16,
  zIndex = 5,
  repelRadius = 160,
  repelStrength = 2.2,
  repelOnHover = true,
  timeScale = 1.25,        // ↑ snappier overall motion
  parallaxEase = 0.18,     // ↑ faster parallax follow
  returnEase = 0.12,       // ↑ faster return to baseline drift
  hoverDecay = 0.08,       // ↑ “hole” closes quicker
  className = '',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const flakesRef = useRef<Flake[]>([])
  const rafRef = useRef<number | null>(null)
  const lastT = useRef<number>(performance.now())

  const mouseTarget = useRef({ x: 0, y: 0 })   // -1..1
  const mouse = useRef({ x: 0, y: 0 })
  const hoverAlpha = useRef(0)                 // 0..1 repulsion energy

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!

    function seed() {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.floor(window.innerWidth * dpr)
      canvas.height = Math.floor(window.innerHeight * dpr)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      flakesRef.current = Array.from({ length: count }, () => {
        const z = Math.random()
        const vx0 = (Math.random() * 0.6 - 0.3) * (0.5 + z)
        const vy0 = (0.6 + z * 1.8) * (0.95 + Math.random() * 0.4)
        return {
          x: Math.random() * window.innerWidth,
          y: Math.random() * window.innerHeight,
          r: 0.6 + z * 2.2,
          vx: vx0, vy: vy0, vx0, vy0, z,
          phase: Math.random() * Math.PI * 2,
        }
      })
    }

    function frame(t: number) {
      const dt = timeScale * Math.min(40, t - lastT.current) / 16.6667
      lastT.current = t

      // quick parallax follow
      mouse.current.x += (mouseTarget.current.x - mouse.current.x) * parallaxEase * dt
      mouse.current.y += (mouseTarget.current.y - mouse.current.y) * parallaxEase * dt

      // repulsion energy fades
      hoverAlpha.current = Math.max(0, hoverAlpha.current - hoverDecay * dt)

      const w = window.innerWidth, h = window.innerHeight
      ctx.clearRect(0, 0, w, h)
      ctx.globalAlpha = opacity
      ctx.fillStyle = '#fff'

      const mx = ((mouse.current.x + 1) * 0.5) * w
      const my = ((mouse.current.y + 1) * 0.5) * h
      const R = repelRadius, R2 = R * R
      const repelActive = !repelOnHover || hoverAlpha.current > 0.001
      const repelK = (repelOnHover ? hoverAlpha.current : 1) * repelStrength

      const far = flakesRef.current.filter(f => f.z < 0.5)
      const near = flakesRef.current.filter(f => f.z >= 0.5)

      const draw = (list: Flake[], useBlur: boolean) => {
        ctx.filter = useBlur && blurPx > 0 ? `blur(${blurPx}px)` : 'none'
        for (const f of list) {
          f.phase += 0.03 * dt                           // ↑ sway speed
          const sway = Math.sin(f.phase) * 0.5

          // Faster return to baseline drift
          f.vx += (f.vx0 - f.vx) * returnEase * dt
          f.vy += (f.vy0 - f.vy) * returnEase * dt

          // Cursor repulsion (stronger + snappier)
          if (repelActive) {
            const dx = f.x - mx, dy = f.y - my
            const d2 = dx * dx + dy * dy
            if (d2 < R2) {
              const d = Math.sqrt(d2) + 1e-4
              const ax = dx / d, ay = dy / d
              const fall = 1 - d / R
              const impulse = repelK * fall * 1.4 * dt   // ↑ impulse
              f.vx += ax * impulse
              f.vy += ay * impulse
              f.x  += ax * fall * 0.7 * dt               // ↑ positional push
              f.y  += ay * fall * 0.7 * dt
            }
          }

          // integrate (faster fall)
          f.y += (f.vy * speed) * dt
          f.x += (f.vx + sway * 0.25) * dt

          // wrap
          if (f.y - f.r > h) { f.y = -f.r - Math.random() * 20; f.x = Math.random() * w }
          if (f.x < -10) f.x = w + 10
          if (f.x > w + 10) f.x = -10

          // parallax displacement
          const px = mouse.current.x * parallax * (0.2 + f.z)
          const py = mouse.current.y * parallax * (0.12 + f.z * 0.3)

          ctx.beginPath()
          ctx.arc(f.x + px, f.y + py, f.r, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      draw(far, true)
      draw(near, false)

      rafRef.current = requestAnimationFrame(frame)
    }

    const onResize = () => seed()
    const onMove = (e: MouseEvent) => {
      mouseTarget.current.x = (e.clientX / window.innerWidth) * 2 - 1
      mouseTarget.current.y = (e.clientY / window.innerHeight) * 2 - 1
      hoverAlpha.current = 1 // kick repulsion instantly
    }

    seed()
    rafRef.current = requestAnimationFrame(frame)
    window.addEventListener('resize', onResize)
    window.addEventListener('mousemove', onMove)

    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('mousemove', onMove)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [
    count, speed, opacity, blurPx, parallax, zIndex,
    repelRadius, repelStrength, repelOnHover,
    timeScale, parallaxEase, returnEase, hoverDecay
  ])

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none fixed left-0 top-0 ${className}`}
      style={{ zIndex, mixBlendMode: 'screen' }}
    />
  )
}