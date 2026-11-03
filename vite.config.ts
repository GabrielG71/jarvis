import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JARVIS_PROMPT } from './server/jarvis-prompt.ts'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MAX_BODY = 8 * 1024
const TIMEOUT_MS = 120_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

class BodyGrande extends Error {
  constructor() {
    super('body grande demais')
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    let estourou = false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      if (estourou) return // descarta o resto sem guardar
      size += c.length
      if (size > MAX_BODY) {
        estourou = true
        chunks.length = 0
        reject(new BodyGrande())
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function runClaude(message: string, sessionId?: string): Promise<{ text: string; sessionId: string }> {
  // sem shell: array de args. Só ferramentas do ClickUp liberadas.
  // `--` antes da mensagem: --allowedTools é variadico e a mensagem pode começar com "-".
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', 'sonnet',
    '--append-system-prompt', JARVIS_PROMPT,
    '--allowedTools', 'mcp__clickup__*',
  ]
  if (sessionId) args.push('--resume', sessionId)
  args.push('--', message)

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('o Claude demorou demais para responder'))
    }, TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out)
        if (j.is_error || typeof j.result !== 'string') {
          return reject(new Error(typeof j.result === 'string' ? j.result : 'resposta inválida do Claude'))
        }
        resolve({ text: j.result, sessionId: j.session_id })
      } catch {
        reject(new Error(`claude saiu com código ${code}: ${(err || out).slice(0, 300)}`))
      }
    })
  })
}

function jarvisApi(): Plugin {
  return {
    name: 'jarvis-api',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
        try {
          const body = JSON.parse(await readBody(req))
          const message = typeof body.message === 'string' ? body.message.trim() : ''
          if (!message) return send(res, 400, { error: 'message obrigatória' })
          let sessionId: string | undefined
          if (body.sessionId != null && body.sessionId !== '') {
            if (typeof body.sessionId !== 'string' || !UUID.test(body.sessionId)) {
              return send(res, 400, { error: 'sessionId inválido' })
            }
            sessionId = body.sessionId
          }
          send(res, 200, await runClaude(message, sessionId))
        } catch (e) {
          if (e instanceof BodyGrande) return send(res, 413, { error: e.message })
          if (e instanceof SyntaxError) return send(res, 400, { error: 'JSON inválido' })
          send(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), jarvisApi()],
  // a rota /api/chat executa o `claude`: nunca expor na rede
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
