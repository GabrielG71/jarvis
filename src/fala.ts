// Fala do Jarvis: voz Piper (POST /api/tts) tocada em fila via Web Audio, com efeito leve.
// Se o TTS falhar numa frase, essa frase cai para speechSynthesis (nunca fica mudo).

// --- efeito "assistente de IA": sutil. Ajuste aqui ou desligue com EFEITO.ligado = false ---
export const EFEITO = {
  ligado: true,
  graveCorteHz: 90, // filtro passa-altas: tira o grave que embola
  presencaHz: 3200, // realce de presença (clareza)
  presencaDb: 2.5,
  ecoMs: 28, // eco curto (dá o timbre sintético)
  ecoRealimentacao: 0.28,
  ecoMistura: 0.16, // 0 = sem eco, 0.3 = bem marcado
}

const MAX_SIMULTANEAS = 2 // a rota devolve 503 acima disso
const MAX_CHARS = 1000

export interface CallbacksFala {
  aoComecar?: () => void
  aoTerminar?: () => void
  aoRecusar?: () => void // navegador bloqueou o áudio (sem gesto do usuário)
}

interface Item {
  texto: string
  audio: Promise<AudioBuffer | null> | null
  cb: CallbacksFala
}

function partir(texto: string): string[] {
  const partes: string[] = []
  let resto = texto.trim()
  while (resto.length > MAX_CHARS) {
    let corte = resto.lastIndexOf(' ', MAX_CHARS)
    if (corte < MAX_CHARS / 2) corte = MAX_CHARS
    partes.push(resto.slice(0, corte).trim())
    resto = resto.slice(corte).trim()
  }
  if (resto) partes.push(resto)
  return partes
}

export class Fala {
  private ctx: AudioContext | null = null
  private entrada: AudioNode | null = null
  private analisador: AnalyserNode | null = null
  private buf: Uint8Array<ArrayBuffer> | null = null
  private fila: Item[] = []
  private ativa: Item | null = null
  private fonte: AudioBufferSourceNode | null = null
  private geracao = 0
  private abort = new AbortController()
  private emVoo = 0
  private esperando: (() => void)[] = []

  private contexto(): AudioContext {
    if (this.ctx) return this.ctx
    const ctx = new AudioContext()
    const an = ctx.createAnalyser()
    an.fftSize = 512
    an.connect(ctx.destination)
    let entrada: AudioNode = an
    if (EFEITO.ligado) {
      const alta = ctx.createBiquadFilter()
      alta.type = 'highpass'
      alta.frequency.value = EFEITO.graveCorteHz
      const pres = ctx.createBiquadFilter()
      pres.type = 'peaking'
      pres.frequency.value = EFEITO.presencaHz
      pres.Q.value = 0.9
      pres.gain.value = EFEITO.presencaDb
      const soma = ctx.createGain()
      const eco = ctx.createDelay(0.1)
      eco.delayTime.value = EFEITO.ecoMs / 1000
      const real = ctx.createGain()
      real.gain.value = EFEITO.ecoRealimentacao
      const molhado = ctx.createGain()
      molhado.gain.value = EFEITO.ecoMistura
      alta.connect(pres)
      pres.connect(soma) // seco
      pres.connect(eco)
      eco.connect(real)
      real.connect(eco)
      eco.connect(molhado)
      molhado.connect(soma)
      soma.connect(an)
      entrada = alta
    }
    this.ctx = ctx
    this.entrada = entrada
    this.analisador = an
    this.buf = new Uint8Array(an.fftSize)
    return ctx
  }

  /** nível 0..1 do que está tocando agora (para o orbe) */
  nivel(): number {
    if (!this.analisador || !this.buf || !this.fonte) return 0
    this.analisador.getByteTimeDomainData(this.buf)
    let soma = 0
    for (const b of this.buf) soma += ((b - 128) / 128) ** 2
    return Math.min(1, Math.sqrt(soma / this.buf.length) * 4)
  }

  /** interrompe tudo: fila, requisições, áudio e fala de reserva */
  cancelar() {
    this.geracao++
    this.abort.abort()
    this.abort = new AbortController()
    this.fila = []
    this.ativa = null
    this.esperando = []
    this.emVoo = 0
    try {
      this.fonte?.stop()
    } catch {
      /* já parou */
    }
    this.fonte = null
    window.speechSynthesis?.cancel()
  }

  falar(texto: string, cb: CallbacksFala = {}) {
    const partes = partir(texto)
    partes.forEach((p, i) => {
      const ultima = i === partes.length - 1
      this.fila.push({
        texto: p,
        audio: null,
        cb: {
          aoComecar: i === 0 ? cb.aoComecar : undefined,
          aoTerminar: ultima ? cb.aoTerminar : undefined,
          aoRecusar: cb.aoRecusar,
        },
      })
    })
    this.prebuscar()
    void this.tocarFila()
  }

  // pré-busca: dispara a síntese das próximas frases, no máximo MAX_SIMULTANEAS ao mesmo tempo
  private prebuscar() {
    const itens = this.ativa ? [this.ativa, ...this.fila] : this.fila
    for (const it of itens) if (!it.audio) it.audio = this.buscar(it.texto)
  }

  private async vaga(sinal: AbortSignal) {
    while (this.emVoo >= MAX_SIMULTANEAS) {
      await new Promise<void>((r) => this.esperando.push(r))
      if (sinal.aborted) throw new DOMException('cancelado', 'AbortError')
    }
    this.emVoo++
  }
  private liberar() {
    this.emVoo = Math.max(0, this.emVoo - 1)
    this.esperando.shift()?.()
  }

  private async buscar(texto: string): Promise<AudioBuffer | null> {
    const geracao = this.geracao
    const sinal = this.abort.signal
    try {
      let dados: ArrayBuffer | null = null
      for (let tentativa = 0; tentativa < 2 && !dados; tentativa++) {
        await this.vaga(sinal)
        try {
          const r = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: texto }),
            signal: sinal,
          })
          if (r.ok) dados = await (await r.blob()).arrayBuffer()
          else if (r.status !== 503) throw new Error(`HTTP ${r.status}`)
        } finally {
          this.liberar()
        }
        if (!dados && tentativa === 0) await new Promise((r) => setTimeout(r, 300))
      }
      if (!dados) throw new Error('TTS ocupado (503)')
      if (geracao !== this.geracao) return null
      return await this.contexto().decodeAudioData(dados)
    } catch (e) {
      if (geracao === this.geracao) console.warn('[jarvis] /api/tts falhou, usando voz do navegador:', e)
      return null
    }
  }

  private async tocarFila() {
    if (this.ativa) return
    const geracao = this.geracao
    for (let it = this.fila.shift(); it; it = this.fila.shift()) {
      this.ativa = it
      this.prebuscar()
      const audio = await (it.audio ??= this.buscar(it.texto))
      if (geracao !== this.geracao) return
      if (audio) {
        const ok = await this.tocar(audio, it, geracao)
        if (geracao !== this.geracao) return
        if (!ok) {
          this.ativa = null
          this.fila = []
          it.cb.aoRecusar?.()
          return
        }
      } else {
        await this.falarReserva(it, geracao)
        if (geracao !== this.geracao) return
      }
      this.ativa = null
      it.cb.aoTerminar?.()
    }
    this.ativa = null
  }

  private async tocar(audio: AudioBuffer, it: Item, geracao: number): Promise<boolean> {
    const ctx = this.contexto()
    if (ctx.state !== 'running') {
      // sem gesto do usuário o Chrome mantém o contexto suspenso
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 250))])
      if (geracao !== this.geracao) return true
      if ((ctx.state as AudioContextState) !== 'running') return false
    }
    await new Promise<void>((resolve) => {
      const src = ctx.createBufferSource()
      src.buffer = audio
      src.connect(this.entrada!)
      src.onended = () => resolve()
      this.fonte = src
      it.cb.aoComecar?.()
      src.start()
    })
    this.fonte = null
    return true
  }

  // reserva: voz do navegador para esta frase
  private falarReserva(it: Item, geracao: number): Promise<void> {
    const synth = window.speechSynthesis
    return new Promise((resolve) => {
      if (!synth) return resolve()
      const u = new SpeechSynthesisUtterance(it.texto)
      u.lang = 'pt-BR'
      u.rate = 1.05
      u.onstart = () => {
        if (geracao === this.geracao) it.cb.aoComecar?.()
      }
      u.onend = () => resolve()
      u.onerror = (e) => {
        if (e.error === 'not-allowed' && geracao === this.geracao) it.cb.aoRecusar?.()
        resolve()
      }
      synth.speak(u)
    })
  }
}
