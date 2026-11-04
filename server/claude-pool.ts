import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JARVIS_PROMPT } from './jarvis-prompt.ts'

// UMA conversa só, com um processo `claude` long-lived: o custo de subir o CLI e conectar o MCP
// do ClickUp é pago uma vez (no aquecimento), não a cada pergunta. O id da sessão do claude fica
// gravado em disco: se o processo for encerrado (ocioso) ou o servidor reiniciar, o próximo sobe
// com --resume na MESMA sessão, então o Habblaud vê no máximo um agente (e nenhum com o processo
// parado) em vez de uma sessão nova a cada abertura.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OCIOSO_MS = 5 * 60_000
const TURNO_MS = 120_000
const INTERRUPCAO_MS = 4_000
const AQUECIMENTO = '[aquecimento] responda só: ok'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// fora do repo e do git
const ESTADO = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'jarvis', 'claude-session')

function lerSessao(): string | null {
  try {
    const v = readFileSync(ESTADO, 'utf8').trim()
    return UUID.test(v) ? v : null
  } catch {
    return null
  }
}

function gravarSessao(id: string | null) {
  try {
    mkdirSync(dirname(ESTADO), { recursive: true })
    writeFileSync(ESTADO, id ? id + '\n' : '', { mode: 0o600 })
  } catch (e) {
    console.error('jarvis: não gravou o estado da sessão:', e instanceof Error ? e.message : e)
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
  recebeu: boolean // o processo atual já mandou algum evento
  fila: Promise<void> // turnos em série
  turno: Turno | null
  ocioso: NodeJS.Timeout | null
}

let unica: Conversa | null = null

function matar(p: ChildProcess | null) {
  if (!p || p.exitCode !== null || p.signalCode) return
  p.kill('SIGTERM')
  setTimeout(() => p.kill('SIGKILL'), 2000).unref()
}

// Encerra só o processo: a conversa (e o id da sessão) fica, para o próximo uso retomar.
function encerrar(c: Conversa) {
  if (c.ocioso) clearTimeout(c.ocioso)
  c.ocioso = null
  const p = c.proc
  c.proc = null
  c.buf = ''
  matar(p)
}

export function matarTodas() {
  if (unica) encerrar(unica)
}

function renovar(c: Conversa) {
  if (c.ocioso) clearTimeout(c.ocioso)
  // com turno em andamento não encerra: renova quando ele terminar
  c.ocioso = setTimeout(() => (c.turno ? renovar(c) : encerrar(c)), OCIOSO_MS)
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
  if (typeof j.session_id === 'string' && UUID.test(j.session_id)) {
    c.recebeu = true
    if (c.claudeSession !== j.session_id) {
      c.claudeSession = j.session_id
      gravarSessao(j.session_id)
    }
  }
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

const CAL = 'mcp__claude_ai_Google_Calendar__'

function subir(c: Conversa): ChildProcess {
  // sem shell: array de args. Só ferramentas do ClickUp (sem as de apagar) e do Google Calendar
  // (só ler + criar, por nome; update/delete/respond bloqueados);
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
    `${CAL}list_calendars`,
    `${CAL}list_events`,
    `${CAL}get_event`,
    `${CAL}search_events`,
    `${CAL}suggest_time`,
    `${CAL}create_event`,
    '--disallowedTools',
    'mcp__clickup__clickup_delete_task',
    'mcp__clickup__clickup_delete_comment',
    'mcp__clickup__clickup_delete_chat_message',
    `${CAL}update_event`,
    `${CAL}delete_event`,
    `${CAL}respond_to_event`,
  ]
  const retomando = c.claudeSession
  if (retomando) args.push('--resume', retomando)
  c.recebeu = false

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
    // morreu sem dizer nada ao retomar: a sessão gravada sumiu ou não abre mais — recomeça uma nova
    if (retomando && !c.recebeu && c.claudeSession === retomando) {
      c.claudeSession = null
      gravarSessao(null)
    }
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

// A conversa única: o id que o navegador manda (ou não) é ignorado — abas, app instalado e
// reinícios do servidor caem todos na mesma sessão.
function obter(): Conversa {
  if (!unica) {
    unica = {
      id: randomUUID(),
      proc: null,
      claudeSession: lerSessao(),
      buf: '',
      recebeu: false,
      fila: Promise.resolve(),
      turno: null,
      ocioso: null,
    }
  }
  renovar(unica)
  return unica
}

// Aquece: sobe o processo (retomando a sessão gravada) e manda uma mensagem boba para o MCP já estar conectado quando a
// primeira pergunta chegar. Devolve o id efetivo da conversa.
export function aquecer(_id?: string): string {
  const c = obter()
  if (!c.proc && !c.turno) {
    c.fila = c.fila.then(() => (c.proc ? undefined : rodarTurno(c, AQUECIMENTO, null))).catch(() => {})
  }
  return c.id
}

// Responde a uma pergunta; o texto chega aos poucos em `texto`. `aoIniciar` recebe o id
// efetivo da conversa antes do primeiro texto.
export function perguntar(
  _id: string | undefined,
  mensagem: string,
  texto: (delta: string) => void,
  aoIniciar: (id: string) => void,
  sinal: AbortSignal,
): Promise<void> {
  const c = obter()
  aoIniciar(c.id)
  const r = c.fila.then(() => {
    renovar(c)
    return rodarTurno(c, mensagem, texto, sinal)
  })
  c.fila = r.catch(() => {})
  return r
}
