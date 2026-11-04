import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Fala com o Piper local (binário e voz ficam fora do repo, em ~/.local/share/jarvis). O texto
// vai pelo stdin; os args são fixos, em array, sem shell.

const BASE = process.env.JARVIS_PIPER_DIR || join(homedir(), '.local', 'share', 'jarvis')
const PIPER = join(BASE, 'piper', 'piper')
const VOZ = join(BASE, 'voices', 'pt_BR-cadu-medium.onnx')
export const MAX_TEXTO = 1000
const TEMPO_MS = 20_000
const MAX_WAV = 20 * 1024 * 1024
const MAX_SIMULTANEOS = 2
let ativos = 0

export class TextoGrande extends Error {
  constructor() {
    super(`texto acima de ${MAX_TEXTO} caracteres`)
  }
}
export class TextoInvalido extends Error {}
export class TtsOcupado extends Error {
  constructor() {
    super('síntese de voz ocupada, tente em instantes')
  }
}
export class TtsFalhou extends Error {
  constructor() {
    super('falha ao gerar a voz')
  }
}

// Devolve um WAV (mono, 22,05 kHz). Erros do Piper viram TtsFalhou, sem caminho nem stderr na mensagem.
export function sintetizar(entrada: unknown): Promise<Buffer> {
  if (typeof entrada !== 'string') throw new TextoInvalido('text obrigatório')
  // tira caracteres de controle (menos quebra de linha) e espaços nas pontas
  const texto = entrada.replace(/[^\P{Cc}\n]/gu, ' ').trim()
  if (!texto) throw new TextoInvalido('text obrigatório')
  if ([...texto].length > MAX_TEXTO) throw new TextoGrande()
  if (ativos >= MAX_SIMULTANEOS) throw new TtsOcupado()
  ativos++

  return new Promise((resolve, reject) => {
    const p = spawn(PIPER, ['--model', VOZ, '--output_file', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const partes: Buffer[] = []
    let tam = 0
    let err = ''
    let fim = false
    const terminar = (e?: Error, wav?: Buffer) => {
      if (fim) return
      fim = true
      ativos--
      clearTimeout(timer)
      if (e) {
        p.kill('SIGKILL')
        reject(e)
      } else resolve(wav!)
    }
    const timer = setTimeout(() => {
      console.error('jarvis: piper estourou o tempo')
      terminar(new TtsFalhou())
    }, TEMPO_MS)
    p.stdout.on('data', (d: Buffer) => {
      tam += d.length
      if (tam > MAX_WAV) return terminar(new TtsFalhou())
      partes.push(d)
    })
    p.stderr.on('data', (d) => (err = (err + d).slice(-500)))
    p.stdin.on('error', () => {}) // o 'close' abaixo trata a morte do processo
    p.on('error', (e) => {
      console.error('jarvis: piper não iniciou:', (e as NodeJS.ErrnoException).code ?? 'erro')
      terminar(new TtsFalhou())
    })
    p.on('close', (code) => {
      if (code === 0 && tam > 44) return terminar(undefined, Buffer.concat(partes))
      console.error(`jarvis: piper falhou (código ${code}):`, err.trim().slice(-200))
      terminar(new TtsFalhou())
    })
    p.stdin.end(texto + '\n')
  })
}
