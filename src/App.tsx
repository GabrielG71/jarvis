import { useCallback, useEffect, useRef, useState } from 'react'
import Orb, { type OrbState } from './Orb'

const MUSICA = '/back-in-black.mp3'
const SAUDACAO = 'Às suas ordens, senhor.'
const SESSION_KEY = 'jarvis-session'
const VOLUME_MUSICA = 0.35

// --- Web Speech: tipos mínimos (não vêm no lib.dom) ---
interface Reconhecedor {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: any) => void) | null
  onerror: ((e: any) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
const SR: (new () => Reconhecedor) | undefined =
  (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition

function lerSessao(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}
function gravarSessao(id: string | null) {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id)
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* sem storage: a conversa só dura enquanto a página estiver aberta */
  }
}

// espera as vozes do navegador carregarem (voiceschanged), com teto de 1,5 s
function vozesProntas(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis
  const ja = synth.getVoices()
  if (ja.length) return Promise.resolve(ja)
  return new Promise((resolve) => {
    const fim = () => {
      synth.removeEventListener('voiceschanged', fim)
      clearTimeout(t)
      resolve(synth.getVoices())
    }
    const t = setTimeout(fim, 1500)
    synth.addEventListener('voiceschanged', fim)
  })
}

function escolherVoz(vozes: SpeechSynthesisVoice[]) {
  const br = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-').toLowerCase() === 'pt-br'
  return (
    vozes.find((v) => br(v) && v.name.includes('Google')) ??
    vozes.find(br) ??
    vozes.find((v) => v.lang.toLowerCase().startsWith('pt'))
  )
}

const emCampoDeTexto = (e: Event) => (e.target as Element | null)?.tagName === 'INPUT'

export default function App() {
  const [estado, setEstado] = useState<OrbState>('idle')
  const [ouvido, setOuvido] = useState('')
  const [resposta, setResposta] = useState('')
  const [digitado, setDigitado] = useState('')

  const estadoRef = useRef<OrbState>('idle')
  const sessionRef = useRef<string | null>(lerSessao())
  const recRef = useRef<Reconhecedor | null>(null)

  // --- música ---
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const musicaRef = useRef<'espera' | 'tocando' | 'parada'>('espera') // parada = fade feito ou arquivo ausente
  const fadeRef = useRef(0)

  // --- amplitude para o orbe ---
  const micRef = useRef<{ stream: MediaStream; ctx: AudioContext; an: AnalyserNode; buf: Uint8Array<ArrayBuffer> } | null>(null)
  const picoRef = useRef(0) // pico da fala simulada, decai sozinho
  const saudouRef = useRef(false)

  const mudarEstado = useCallback((s: OrbState) => {
    estadoRef.current = s
    setEstado(s)
  }, [])

  const getLevel = useCallback(() => {
    const t = performance.now() / 1000
    if (estadoRef.current === 'listening') {
      const mic = micRef.current
      if (mic) {
        mic.an.getByteTimeDomainData(mic.buf)
        let soma = 0
        for (const b of mic.buf) soma += ((b - 128) / 128) ** 2
        return Math.min(1, Math.sqrt(soma / mic.buf.length) * 4)
      }
      return 0.5 + 0.5 * Math.sin(t * 4) // sem microfone: anel pulsando
    }
    if (estadoRef.current === 'speaking') {
      // o áudio do TTS não é analisável: ruído suave + picos nas fronteiras de palavra
      picoRef.current *= 0.93
      const ruido = 0.35 + 0.2 * Math.sin(t * 9) * Math.sin(t * 5.3) + 0.1 * Math.sin(t * 17.1)
      return Math.min(1, Math.max(ruido, picoRef.current))
    }
    return 0
  }, [])

  // --- música ---
  const fadeOutMusica = useCallback(() => {
    const a = audioRef.current
    const antes = musicaRef.current
    musicaRef.current = 'parada'
    if (!a || antes !== 'tocando') return
    clearInterval(fadeRef.current)
    const v0 = a.volume
    let passo = 0
    fadeRef.current = window.setInterval(() => {
      passo++
      a.volume = Math.max(0, v0 * (1 - passo / 10))
      if (passo >= 10) {
        clearInterval(fadeRef.current)
        a.pause()
      }
    }, 100)
  }, [])

  // --- fala ---
  const falar = useCallback(
    async (texto: string, opcoes: { manterMusica?: boolean; aoRecusar?: () => void } = {}) => {
      const synth = window.speechSynthesis
      if (!synth) return
      synth.cancel()
      const vozes = await vozesProntas()
      const u = new SpeechSynthesisUtterance(texto)
      u.lang = 'pt-BR'
      u.rate = 1.05
      const voz = escolherVoz(vozes)
      if (voz) u.voice = voz
      u.onstart = () => {
        if (!opcoes.manterMusica) fadeOutMusica()
        mudarEstado('speaking')
      }
      u.onboundary = () => (picoRef.current = 1)
      u.onend = () => {
        if (estadoRef.current === 'speaking') mudarEstado('idle')
      }
      u.onerror = (e) => {
        if (estadoRef.current === 'speaking') mudarEstado('idle')
        // sem gesto do usuário o Chrome recusa a fala: quem chamou tenta de novo depois
        if (e.error === 'not-allowed') opcoes.aoRecusar?.()
      }
      synth.speak(u)
    },
    [fadeOutMusica, mudarEstado],
  )

  const saudar = useCallback(() => {
    if (saudouRef.current) return
    saudouRef.current = true
    // a música segue tocando por baixo da saudação; só some quando ele ouvir/responder
    falar(SAUDACAO, { manterMusica: true, aoRecusar: () => (saudouRef.current = false) })
  }, [falar])

  // --- envio ao Claude ---
  const enviar = useCallback(
    async (texto: string) => {
      mudarEstado('thinking')
      setResposta('')
      try {
        const r = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: texto, sessionId: sessionRef.current ?? undefined }),
        })
        const j = await r.json()
        if (!r.ok || typeof j.text !== 'string') throw new Error(j.error ?? `HTTP ${r.status}`)
        if (j.sessionId) {
          sessionRef.current = j.sessionId
          gravarSessao(j.sessionId)
        }
        setResposta(j.text)
        falar(j.text)
      } catch (e) {
        // sessão velha/inválida travaria todas as próximas perguntas: recomeça do zero
        sessionRef.current = null
        gravarSessao(null)
        console.error('jarvis:', e)
        const msg = 'Perdão, senhor, não consegui concluir o pedido.'
        setResposta(msg)
        falar(msg)
      }
    },
    [falar, mudarEstado],
  )

  // pergunta digitada: mesmo fluxo da fala
  const enviarDigitado = useCallback(() => {
    const texto = digitado.trim()
    if (!texto || estadoRef.current === 'thinking' || estadoRef.current === 'listening') return
    setDigitado('')
    setOuvido(texto)
    window.speechSynthesis?.cancel()
    fadeOutMusica()
    void enviar(texto)
  }, [digitado, enviar, fadeOutMusica])

  // --- escuta ---
  const pararMic = useCallback(() => {
    const m = micRef.current
    micRef.current = null
    if (!m) return
    m.stream.getTracks().forEach((t) => t.stop())
    void m.ctx.close()
  }, [])

  const abrirMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // a escuta pode ter acabado enquanto o usuário respondia ao pedido de permissão
      if (estadoRef.current !== 'listening') return stream.getTracks().forEach((t) => t.stop())
      const ctx = new AudioContext()
      const an = ctx.createAnalyser()
      an.fftSize = 256
      ctx.createMediaStreamSource(stream).connect(an)
      micRef.current = { stream, ctx, an, buf: new Uint8Array(an.fftSize) }
    } catch {
      /* sem microfone para o orbe: o anel pulsa simulado */
    }
  }, [])

  const alternarEscuta = useCallback(() => {
    if (estadoRef.current === 'thinking') return
    if (estadoRef.current === 'listening') return recRef.current?.stop()
    if (!SR) {
      setResposta('Este navegador não tem reconhecimento de voz. Use o Chrome.')
      return
    }
    window.speechSynthesis?.cancel()
    fadeOutMusica()

    const rec = new SR()
    rec.lang = 'pt-BR'
    rec.continuous = false
    rec.interimResults = true
    let final = ''
    rec.onresult = (e) => {
      let parcial = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) final += r[0].transcript
        else parcial += r[0].transcript
      }
      setOuvido((final + parcial).trim())
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setResposta('Preciso da permissão do microfone, senhor.')
      }
    }
    rec.onend = () => {
      recRef.current = null
      pararMic()
      const texto = final.trim()
      if (texto) {
        setOuvido(texto)
        void enviar(texto)
      } else {
        mudarEstado('idle')
      }
    }
    recRef.current = rec
    setOuvido('')
    mudarEstado('listening')
    try {
      rec.start()
      void abrirMic()
    } catch {
      recRef.current = null
      mudarEstado('idle')
    }
  }, [abrirMic, enviar, fadeOutMusica, mudarEstado, pararMic])

  // Espaço: segurar = escutar, soltar = fim da frase
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || emCampoDeTexto(e)) return
      e.preventDefault()
      if (e.repeat) return
      if (estadoRef.current === 'idle' || estadoRef.current === 'speaking') alternarEscuta()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || emCampoDeTexto(e)) return
      e.preventDefault()
      if (estadoRef.current === 'listening') recRef.current?.stop()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [alternarEscuta])

  // música ao abrir a página + saudação; se o autoplay for barrado, vale o primeiro gesto
  useEffect(() => {
    const audio = new Audio(MUSICA)
    audio.loop = true
    audio.volume = VOLUME_MUSICA
    audioRef.current = audio

    const tocar = () => {
      if (musicaRef.current !== 'espera') return
      audio.play().then(
        () => {
          // o Jarvis já pode ter começado a ouvir/falar enquanto o play() resolvia
          if (musicaRef.current !== 'espera') return audio.pause()
          musicaRef.current = 'tocando'
          saudar()
        },
        (e: DOMException) => {
          // NotAllowedError: espera o gesto. Arquivo ausente/ilegível: segue sem música.
          if (e.name !== 'NotAllowedError') musicaRef.current = 'parada'
        },
      )
    }
    tocar()

    const gesto = (e: Event) => {
      const noOrbe = (e.target as Element | null)?.closest?.('.orb')
      const espaco = e instanceof KeyboardEvent && e.code === 'Space' && !emCampoDeTexto(e)
      // gesto que já inicia a escuta não deve acender a música
      if (noOrbe || espaco) saudouRef.current = true // vai escutar: sem saudação
      else {
        tocar()
        saudar()
      }
    }
    window.addEventListener('pointerdown', gesto)
    window.addEventListener('keydown', gesto)

    return () => {
      window.removeEventListener('pointerdown', gesto)
      window.removeEventListener('keydown', gesto)
      clearInterval(fadeRef.current)
      audio.pause()
      audioRef.current = null
      recRef.current?.abort()
      pararMic()
      window.speechSynthesis?.cancel()
    }
  }, [pararMic, saudar])

  return (
    <div className="stage">
      <Orb state={estado} getLevel={getLevel} onClick={alternarEscuta} />
      <form
        className="entrada"
        onSubmit={(e) => {
          e.preventDefault()
          enviarDigitado()
        }}
      >
        <input
          value={digitado}
          onChange={(e) => setDigitado(e.target.value)}
          disabled={estado === 'thinking'}
          placeholder="ou digite sua pergunta…"
          aria-label="Pergunta ao Jarvis"
          autoComplete="off"
          enterKeyHint="send"
        />
      </form>
      <div className="legenda" aria-live="polite">
        {ouvido && <div className="voce">{ouvido}</div>}
        {resposta && <div className="jarvis">{resposta}</div>}
      </div>
      <div className="dica">clique no orbe ou segure Espaço · ou digite</div>
    </div>
  )
}
