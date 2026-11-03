import { useCallback, useEffect, useRef, useState } from 'react'
import Orb, { type OrbState } from './Orb'

const MUSICA = '/back-in-black.mp3'
const SAUDACAO = 'Às suas ordens, senhor.'
const CONVERSA_KEY = 'jarvis-conversa'
const VOLUME_MUSICA = 0.35
const INTRO_MS = 20_000 // só a introdução do riff; depois some em fade

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

function lerConversa(): string | null {
  try {
    return sessionStorage.getItem(CONVERSA_KEY)
  } catch {
    return null
  }
}
function gravarConversa(id: string | null) {
  try {
    if (id) sessionStorage.setItem(CONVERSA_KEY, id)
    else sessionStorage.removeItem(CONVERSA_KEY)
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

// data/hora local e fuso, para o Jarvis interpretar "hoje"/"amanhã" sem consultar o ClickUp
function agoraLocal() {
  const d = new Date()
  const fuso = Intl.DateTimeFormat().resolvedOptions().timeZone
  const dia = d.toLocaleDateString('pt-BR', { weekday: 'long' })
  return `${dia}, ${d.toString().replace(/\s*\(.*\)$/, '')} | ${fuso}`.slice(0, 120)
}

// separa a próxima frase completa: pontuação final seguida de espaço, ou quebra de linha
const FIM_DE_FRASE = /[.!?…]+["')»]*\s|\n/

const emCampoDeTexto = (e: Event) => (e.target as Element | null)?.tagName === 'INPUT'

export default function App() {
  const [estado, setEstado] = useState<OrbState>('idle')
  const [ouvido, setOuvido] = useState('')
  const [resposta, setResposta] = useState('')
  const [digitado, setDigitado] = useState('')

  const estadoRef = useRef<OrbState>('idle')
  const conversaRef = useRef<string | null>(lerConversa())
  const vozRef = useRef<SpeechSynthesisVoice | undefined>(undefined)

  // --- resposta em streaming: fala por frase ---
  const abortRef = useRef<AbortController | null>(null)
  const geracaoRef = useRef(0) // invalida callbacks de falas canceladas
  const pendentesRef = useRef(0) // frases enfileiradas e ainda não faladas
  const streamAtivoRef = useRef(false)
  const bufferRef = useRef('') // texto recebido que ainda não fechou uma frase
  const textoRef = useRef('') // resposta inteira até agora (transcrição)
  const falouRef = useRef(false)
  const aquecidoEmRef = useRef(0)
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

  // --- fala por frase ---
  const enfileirar = useCallback(
    (frase: string) => {
      const synth = window.speechSynthesis
      if (!synth) return
      const geracao = geracaoRef.current
      const u = new SpeechSynthesisUtterance(frase)
      u.lang = 'pt-BR'
      u.rate = 1.05
      if (vozRef.current) u.voice = vozRef.current
      const terminou = () => {
        if (geracao !== geracaoRef.current) return
        if (--pendentesRef.current > 0) return
        // fila vazia: ou a resposta acabou, ou falta chegar a próxima frase
        if (streamAtivoRef.current) mudarEstado('thinking')
        else if (estadoRef.current === 'speaking') mudarEstado('idle')
      }
      u.onstart = () => {
        if (geracao !== geracaoRef.current) return
        fadeOutMusica()
        mudarEstado('speaking')
      }
      u.onboundary = () => (picoRef.current = 1)
      u.onend = terminou
      u.onerror = terminou
      pendentesRef.current++
      falouRef.current = true
      synth.speak(u)
    },
    [fadeOutMusica, mudarEstado],
  )

  // acumula o texto e fala cada frase completa; `fim` descarrega o que sobrou
  const alimentar = useCallback(
    (delta: string, fim = false) => {
      textoRef.current += delta
      setResposta(textoRef.current)
      bufferRef.current += delta
      for (let m = FIM_DE_FRASE.exec(bufferRef.current); m; m = FIM_DE_FRASE.exec(bufferRef.current)) {
        const corte = m.index + m[0].length
        const frase = bufferRef.current.slice(0, corte).trim()
        bufferRef.current = bufferRef.current.slice(corte)
        if (frase) enfileirar(frase)
      }
      if (fim && bufferRef.current.trim()) enfileirar(bufferRef.current.trim())
      if (fim) bufferRef.current = ''
    },
    [enfileirar],
  )

  // nova pergunta (ou nova escuta): aborta a resposta em andamento e limpa a fila de fala
  const cancelarResposta = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    streamAtivoRef.current = false
    geracaoRef.current++
    pendentesRef.current = 0
    bufferRef.current = ''
    window.speechSynthesis?.cancel()
  }, [])

  // pré-aquece o processo do Claude (CLI + ClickUp) no servidor; é barato se já estiver vivo
  const aquecer = useCallback(() => {
    const agora = Date.now()
    if (agora - aquecidoEmRef.current < 30_000) return
    aquecidoEmRef.current = agora
    fetch('/api/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: conversaRef.current ?? undefined }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && typeof j.conversationId === 'string') {
          conversaRef.current = j.conversationId
          gravarConversa(j.conversationId)
        }
      })
      .catch(() => {
        aquecidoEmRef.current = 0
      })
  }, [])

  // --- envio ao Claude ---
  const enviar = useCallback(
    async (texto: string) => {
      cancelarResposta()
      const ac = new AbortController()
      abortRef.current = ac
      streamAtivoRef.current = true
      textoRef.current = ''
      falouRef.current = false
      mudarEstado('thinking')
      setResposta('')
      try {
        const r = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: texto, conversationId: conversaRef.current ?? undefined, agora: agoraLocal() }),
          signal: ac.signal,
        })
        if (!r.ok || !r.body) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
        // NDJSON: {conversationId} | {delta} | {done} | {error}
        const leitor = r.body.getReader()
        const decoder = new TextDecoder()
        let resto = ''
        let terminou = false
        const tratar = (linha: string) => {
          if (!linha.trim()) return
          const ev = JSON.parse(linha)
          if (typeof ev.conversationId === 'string') {
            conversaRef.current = ev.conversationId
            gravarConversa(ev.conversationId)
          }
          if (typeof ev.delta === 'string') alimentar(ev.delta)
          if (ev.error) throw new Error(String(ev.error))
          if (ev.done) terminou = true
        }
        for (;;) {
          const { value, done } = await leitor.read()
          if (done) break
          resto += decoder.decode(value, { stream: true })
          const linhas = resto.split('\n')
          resto = linhas.pop() ?? ''
          linhas.forEach(tratar)
        }
        tratar(resto)
        if (!terminou) throw new Error('resposta interrompida')
        alimentar('', true)
        streamAtivoRef.current = false
        if (!falouRef.current) mudarEstado('idle') // resposta vazia
        else if (pendentesRef.current === 0 && estadoRef.current !== 'speaking') mudarEstado('idle')
      } catch (e) {
        if (ac.signal.aborted) return // nova pergunta: quem cancelou já cuida do estado
        // conversa velha/inválida travaria todas as próximas perguntas: recomeça do zero
        conversaRef.current = null
        gravarConversa(null)
        console.error('jarvis:', e)
        streamAtivoRef.current = false
        const msg = 'Perdão, senhor, não consegui concluir o pedido.'
        textoRef.current += (textoRef.current ? '\n' : '') + msg
        setResposta(textoRef.current)
        enfileirar(msg)
      }
    },
    [alimentar, cancelarResposta, enfileirar, mudarEstado],
  )

  // pergunta digitada: mesmo fluxo da fala
  const enviarDigitado = useCallback(() => {
    const texto = digitado.trim()
    if (!texto || estadoRef.current === 'thinking' || estadoRef.current === 'listening') return
    setDigitado('')
    setOuvido(texto)
    cancelarResposta()
    fadeOutMusica()
    void enviar(texto)
  }, [cancelarResposta, digitado, enviar, fadeOutMusica])

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
    cancelarResposta()
    fadeOutMusica()
    aquecer() // enquanto ele fala, o Claude já sobe

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
  }, [abrirMic, aquecer, cancelarResposta, enviar, fadeOutMusica, mudarEstado, pararMic])

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

  // voz escolhida uma vez; Claude aquecido ao abrir e sempre que a página volta ao foco
  // (o servidor encerra o processo depois de 15 min parado)
  useEffect(() => {
    if (window.speechSynthesis) void vozesProntas().then((v) => (vozRef.current = escolherVoz(v)))
    aquecer()
    const volta = () => {
      if (document.visibilityState === 'visible') aquecer()
    }
    document.addEventListener('visibilitychange', volta)
    window.addEventListener('focus', volta)
    return () => {
      document.removeEventListener('visibilitychange', volta)
      window.removeEventListener('focus', volta)
      abortRef.current?.abort()
    }
  }, [aquecer])

  // música ao abrir a página + saudação; se o autoplay for barrado, vale o primeiro gesto
  useEffect(() => {
    const audio = new Audio(MUSICA)
    audio.loop = false
    let introTimer = 0
    audio.volume = VOLUME_MUSICA
    audioRef.current = audio

    const tocar = () => {
      if (musicaRef.current !== 'espera') return
      audio.play().then(
        () => {
          // o Jarvis já pode ter começado a ouvir/falar enquanto o play() resolvia
          if (musicaRef.current !== 'espera') return audio.pause()
          musicaRef.current = 'tocando'
          introTimer = window.setTimeout(fadeOutMusica, INTRO_MS)
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
      clearTimeout(introTimer)
      clearInterval(fadeRef.current)
      audio.pause()
      audioRef.current = null
      recRef.current?.abort()
      pararMic()
      window.speechSynthesis?.cancel()
    }
  }, [fadeOutMusica, pararMic, saudar])

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
