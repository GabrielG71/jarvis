import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JARVIS_PROMPT } from './jarvis-prompt.ts'

// Um processo `claude` long-lived por conversa: o custo de subir o CLI e conectar o MCP do
// ClickUp é pago uma vez (no aquecimento), não a cada pergunta.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MAX_CONVERSAS = 3
const OCIOSO_MS = 15 * 60_000
const TURNO_MS = 120_000
const INTERRUPCAO_MS = 4_000
const AQUECIMENTO = '[aquecimento] responda só: ok'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class Ocupado extends Error {
  constructor() {
    super('o Jarvis está atendendo outras conversas, tente em instantes')
  }
}

interface Turno {
  texto: ((delta: string) => void) | null // null: aquecimento ou cancelado — o texto é descartado
  fim: (erro?: Error) => void
  timer: NodeJS.Timeout
  emitiu: boolean // já saiu texto neste turno
  separar: boolean // nova mensagem do assistente depois de texto: separa com espaço
  streamados: Set<string> // ids das mensagens que chegaram em deltas parciais
}

interface Conversa {
  id: string
  proc: ChildProcess | null
  claudeSession: string | null // para --resume se o processo morrer
  buf: string
  fila: Promise<void> // turnos em série
  turno: Turno | null
  ocioso: NodeJS.Timeout | null
  ultimoUso: number
  virgem: boolean // aquecida e ainda sem pergunta
}

const conversas = new Map<string, Conversa>()

function matar(p: ChildProcess | null) {
  if (!p || p.exitCode !== null || p.signalCode) return
  p.kill('SIGTERM')
  setTimeout(() => p.kill('SIGKILL'), 2000).unref()
}

function encerrar(c: Conversa) {
  if (c.ocioso) clearTimeout(c.ocioso)
  c.ocioso = null
  conversas.delete(c.id)
  matar(c.proc)
}

export function matarTodas() {
  for (const c of [...conversas.values()]) encerrar(c)
}

function renovar(c: Conversa) {
  c.ultimoUso = Date.now()
  if (c.ocioso) clearTimeout(c.ocioso)
  c.ocioso = setTimeout(() => encerrar(c), OCIOSO_MS)
  c.ocioso.unref()
}

function emitir(t: Turno, delta: string) {
  if (!delta) return
  if (t.texto) {
    t.texto(t.separar ? ' ' + delta : delta)
    t.emitiu = true
  }
  t.separar = false
}

function aoEvento(c: Conversa, j: any) {
  if (typeof j.session_id === 'string' && UUID.test(j.session_id)) c.claudeSession = j.session_id
  const t = c.turno
  if (!t) return
  if (j.type === 'stream_event' && !j.parent_tool_use_id) {
    const e = j.event
    if (e?.type === 'message_start') t.separar = t.emitiu
    else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      if (typeof j.api_message_id === 'string') t.streamados.add(j.api_message_id)
      emitir(t, e.delta.text)
    }
  } else if (j.type === 'assistant' && !j.parent_tool_use_id) {
    // sem deltas parciais para esta mensagem: usa os blocos de texto dela inteira
    const m = j.message
    if (m && !t.streamados.has(m.id)) {
      t.separar = t.emitiu
      for (const b of m.content ?? []) if (b.type === 'text') emitir(t, b.text)
    }
  } else if (j.type === 'result') {
    clearTimeout(t.timer)
    c.turno = null
    if (j.is_error && t.texto) {
      console.error('jarvis: claude devolveu erro:', typeof j.result === 'string' ? j.result.slice(0, 300) : j.subtype)
      t.fim(new Error('o Claude não conseguiu responder'))
    } else t.fim()
  }
}

function subir(c: Conversa): ChildProcess {
  // sem shell: array de args. Só ferramentas do ClickUp liberadas (e sem as de apagar);
  // `--tools ""` tira Bash/Edit/Write do contexto. Com ENABLE_TOOL_SEARCH=false as ferramentas do
  // MCP já entram no prompt, sem a ida extra ao ToolSearch.
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', 'sonnet',
    '--append-system-prompt', JARVIS_PROMPT,
    '--tools', '',
    '--disable-slash-commands',
    '--allowedTools', 'mcp__clickup__*',
    '--disallowedTools',
    'mcp__clickup__clickup_delete_task',
    'mcp__clickup__clickup_delete_comment',
    'mcp__clickup__clickup_delete_chat_message',
  ]
  if (c.claudeSession) args.push('--resume', c.claudeSession)

  const p = spawn('claude', args, {
    cwd: ROOT,
    env: { ...process.env, ENABLE_TOOL_SEARCH: 'false' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let err = ''
  p.stdin.on('error', () => {}) // EPIPE: o 'close' abaixo trata a morte do processo
  p.stderr.on('data', (d) => (err = (err + d).slice(-500)))
  p.stdout.on('data', (d: Buffer) => {
    if (c.proc !== p) return
    c.buf += d.toString('utf8')
    let i: number
    while ((i = c.buf.indexOf('\n')) >= 0) {
      const linha = c.buf.slice(0, i)
      c.buf = c.buf.slice(i + 1)
      if (!linha.trim()) continue
      try {
        aoEvento(c, JSON.parse(linha))
      } catch {
        /* linha que não é JSON: ignora */
      }
    }
  })
  const morreu = (motivo: string) => {
    if (c.proc !== p) return
    c.proc = null
    c.buf = ''
    const t = c.turno
    if (!t) return
    clearTimeout(t.timer)
    c.turno = null
    console.error(`jarvis: claude encerrou (${motivo}):`, err.trim().slice(0, 300))
    t.fim(t.texto ? new Error('o Claude encerrou inesperadamente') : undefined)
  }
  p.on('error', (e) => morreu(e.message))
  p.on('close', (code, sinal) => morreu(`código ${code ?? sinal}`))
  return p
}

// Descarta o processo de um turno que não terminou (estouro de tempo ou interrupção ignorada):
// a próxima pergunta recria com --resume.
function abandonar(c: Conversa, t: Turno, proc: ChildProcess) {
  if (c.turno !== t) return
  clearTimeout(t.timer)
  c.turno = null
  c.proc = null
  c.buf = ''
  matar(proc)
}

// Um turno: manda a mensagem e espera o `result`. Se `sinal` abortar no meio (o cliente
// desistiu ou fez outra pergunta), interrompe o claude e descarta o texto que faltava.
function rodarTurno(c: Conversa, mensagem: string, texto: ((d: string) => void) | null, sinal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sinal?.aborted) return resolve()
    if (!c.proc) c.proc = subir(c)
    const proc = c.proc
    const t: Turno = {
      texto,
      fim: (erro) => (erro ? reject(erro) : resolve()),
      emitiu: false,
      separar: false,
      streamados: new Set(),
      timer: setTimeout(() => {
        console.error('jarvis: turno estourou o tempo, descartando o processo')
        const ainda = c.turno === t
        abandonar(c, t, proc)
        if (ainda) t.fim(t.texto ? new Error('o Claude demorou demais para responder') : undefined)
      }, TURNO_MS),
    }
    c.turno = t
    sinal?.addEventListener(
      'abort',
      () => {
        t.texto = null
        if (c.turno !== t) return
        proc.stdin?.write(
          JSON.stringify({ type: 'control_request', request_id: 'int_' + randomUUID(), request: { subtype: 'interrupt' } }) + '\n',
        )
        setTimeout(() => {
          if (c.turno !== t) return
          abandonar(c, t, proc)
          t.fim()
        }, INTERRUPCAO_MS).unref()
      },
      { once: true },
    )
    proc.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: mensagem } }) + '\n')
  })
}

function nova(): Conversa {
  if (conversas.size >= MAX_CONVERSAS) {
    // libera a ociosa mais antiga; se todas estiverem atendendo, recusa
    const livres = [...conversas.values()].filter((x) => !x.turno).sort((a, b) => a.ultimoUso - b.ultimoUso)
    if (!livres.length) throw new Ocupado()
    encerrar(livres[0])
  }
  const c: Conversa = {
    id: randomUUID(),
    proc: null,
    claudeSession: null,
    buf: '',
    fila: Promise.resolve(),
    turno: null,
    ocioso: null,
    ultimoUso: Date.now(),
    virgem: false,
  }
  conversas.set(c.id, c)
  renovar(c)
  return c
}

// id desconhecido (servidor reiniciado, conversa ociosa já encerrada): reaproveita a conversa
// aquecida e ainda sem uso, ou cria outra. Vários abas/chamadas de aquecimento dividem uma só.
function obter(id?: string): Conversa {
  const c = (id && conversas.get(id)) || [...conversas.values()].find((x) => x.virgem) || nova()
  renovar(c)
  return c
}

// Aquece: sobe o processo e manda uma mensagem boba para o MCP já estar conectado quando a
// primeira pergunta chegar. Devolve o id efetivo da conversa.
export function aquecer(id?: string): string {
  const c = obter(id)
  if (!c.proc && !c.turno) {
    c.virgem = c.virgem || !c.claudeSession
    c.fila = c.fila.then(() => (c.proc ? undefined : rodarTurno(c, AQUECIMENTO, null))).catch(() => {})
  }
  return c.id
}

// Responde a uma pergunta; o texto chega aos poucos em `texto`. `aoIniciar` recebe o id
// efetivo da conversa antes do primeiro texto.
export function perguntar(
  id: string | undefined,
  mensagem: string,
  texto: (delta: string) => void,
  aoIniciar: (id: string) => void,
  sinal: AbortSignal,
): Promise<void> {
  const c = obter(id)
  c.virgem = false
  aoIniciar(c.id)
  const r = c.fila.then(() => {
    renovar(c)
    return rodarTurno(c, mensagem, texto, sinal)
  })
  c.fila = r.catch(() => {})
  return r
}
