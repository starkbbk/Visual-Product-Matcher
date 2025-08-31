import React, { useEffect, useRef } from 'react'

type Props = {
  enabled?: boolean
  density?: number   // 0..1
  zIndex?: number
}

export default function Snowfall({ enabled = true, density = 0.7, zIndex = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !enabled) return

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    let w = 0, h = 0

    // perf knobs
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const isChrome = /Chrome\/\d+/.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent)
    const targetFPS = reduced ? 20 : (isChrome ? 28 : 32)
    const frameInterval = 1000 / targetFPS

    // particles (typed arrays for speed)
    let N = 0
    let X: Float32Array, Y: Float32Array, R: Float32Array, S: Float32Array, PHI: Float32Array

    const rand = (a: number, b: number) => a + Math.random() * (b - a)

    const resize = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      w = Math.max(1, vw)
      h = Math.max(1, vh)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const base = Math.min(220, Math.round((w * h) / 24000))
      const scale = density * (reduced ? 0.4 : 1)
      const nextN = Math.max(12, Math.round(base * scale))

      N = nextN
      X = new Float32Array(N)
      Y = new Float32Array(N)
      R = new Float32Array(N)
      S = new Float32Array(N)
      PHI = new Float32Array(N)

      for (let i = 0; i < N; i++) {
        X[i] = Math.random() * w
        Y[i] = Math.random() * h
        R[i] = rand(0.5, 1.8)
        S[i] = rand(18, 42) / 60
        PHI[i] = Math.random() * Math.PI * 2
      }
    }

    let last = performance.now()
    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick)
      const dt = now - last
      if (dt < frameInterval) return
      last = now

      ctx.clearRect(0, 0, w, h)
      ctx.globalAlpha = 0.9

      for (let i = 0; i < N; i++) {
        const drift = Math.sin(PHI[i] + now * 0.0018) * 0.35
        X[i] += drift
        Y[i] += S[i] * (dt / (1000 / 60))
        if (Y[i] > h + 8) { Y[i] = -8; X[i] = Math.random() * w }
        const r = R[i]
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.fillRect(X[i], Y[i], r, r)
      }
    }

    const onVis = () => {
      if (document.hidden) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      } else if (!rafRef.current) {
        last = performance.now()
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    resize()
    window.addEventListener('resize', resize, { passive: true })
    document.addEventListener('visibilitychange', onVis)

    rafRef.current = requestAnimationFrame(tick)

    cleanupRef.current = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVis)
    }

    return () => cleanupRef.current?.()
  }, [enabled, density])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        pointerEvents: 'none',
        mixBlendMode: 'normal',
      }}
    />
  )
}