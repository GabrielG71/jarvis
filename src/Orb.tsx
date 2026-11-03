import { useEffect, useRef } from 'react'

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking'

interface Props {
  state: OrbState
  // amplitude 0..1 em tempo real (microfone ou fala simulada); lida a cada frame
  getLevel: () => number
  onClick: () => void
}

const CIANO = '54, 224, 255'

export default function Orb({ state, getLevel, onClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  const levelRef = useRef(getLevel)
  stateRef.current = state
  levelRef.current = getLevel

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let spin = 0
    let energy = 0 // suaviza a amplitude para o brilho não tremer
    let last = performance.now()

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const { width, height } = canvas.getBoundingClientRect()
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      const t = now / 1000
      const st = stateRef.current
      const w = canvas.width
      const cx = w / 2
      const cy = canvas.height / 2
      const R = w / 2

      // alvo de energia por estado
      let target = 0.15 + 0.08 * Math.sin(t * 1.2) // idle respira devagar
      if (st === 'listening') target = 0.3 + levelRef.current() * 0.7
      if (st === 'speaking') target = 0.25 + levelRef.current() * 0.75
      if (st === 'thinking') target = 0.35
      energy += (target - energy) * Math.min(1, dt * 10)
      spin += dt * (st === 'thinking' ? 4 : 0.35)

      ctx.clearRect(0, 0, w, canvas.height)
      ctx.globalCompositeOperation = 'lighter'

      // halo
      const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R)
      halo.addColorStop(0, `rgba(${CIANO}, ${0.18 + energy * 0.45})`)
      halo.addColorStop(0.5, `rgba(20, 110, 200, ${0.06 + energy * 0.14})`)
      halo.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = halo
      ctx.fillRect(0, 0, w, canvas.height)

      ctx.lineCap = 'round'
      ctx.shadowColor = `rgba(${CIANO}, 0.9)`
      ctx.shadowBlur = R * 0.06

      // anel externo fino + marcas
      ctx.strokeStyle = `rgba(${CIANO}, 0.35)`
      ctx.lineWidth = R * 0.008
      ctx.beginPath()
      ctx.arc(cx, cy, R * 0.86, 0, Math.PI * 2)
      ctx.stroke()

      ctx.lineWidth = R * 0.02
      ctx.strokeStyle = `rgba(${CIANO}, ${0.5 + energy * 0.4})`
      for (let i = 0; i < 10; i++) {
        const a = spin * 0.5 + (i / 10) * Math.PI * 2
        ctx.beginPath()
        ctx.arc(cx, cy, R * 0.78, a, a + 0.34)
        ctx.stroke()
      }

      // anel reativo: raio e espessura seguem a energia; no "listening" ganha onda
      const ringR = R * (0.6 + energy * 0.1)
      ctx.lineWidth = R * (0.025 + energy * 0.05)
      ctx.strokeStyle = `rgba(${CIANO}, ${0.55 + energy * 0.45})`
      ctx.beginPath()
      if (st === 'thinking') {
        ctx.arc(cx, cy, ringR, spin, spin + Math.PI * 1.3)
      } else if (st === 'listening') {
        const steps = 120
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2
          const wob = 1 + Math.sin(a * 6 + t * 5) * energy * 0.05
          const x = cx + Math.cos(a) * ringR * wob
          const y = cy + Math.sin(a) * ringR * wob
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
        }
        ctx.closePath()
      } else {
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
      }
      ctx.stroke()

      // triângulo interno (arc reactor), gira devagar
      ctx.lineWidth = R * 0.015
      ctx.strokeStyle = `rgba(${CIANO}, ${0.45 + energy * 0.4})`
      ctx.beginPath()
      const triR = R * 0.4
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + spin * (st === 'thinking' ? 0.6 : 0.2) + (i / 3) * Math.PI * 2
        const x = cx + Math.cos(a) * triR
        const y = cy + Math.sin(a) * triR
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      }
      ctx.closePath()
      ctx.stroke()

      // núcleo
      ctx.shadowBlur = 0
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.22 + energy * 0.08))
      core.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
      core.addColorStop(0.35, `rgba(${CIANO}, ${0.7 + energy * 0.3})`)
      core.addColorStop(1, 'rgba(0, 80, 160, 0)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, R * 0.32, 0, Math.PI * 2)
      ctx.fill()

      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="orb"
      role="button"
      aria-label="Falar com o Jarvis"
      onClick={onClick}
    />
  )
}
