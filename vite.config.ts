import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { aquecer, matarTodas, perguntar, UUID } from './server/claude-pool.ts'
import { sintetizar, TextoGrande, TextoInvalido, TtsFalhou, TtsOcupado } from './server/tts.ts'

const MAX_BODY = 8 * 1024

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

// Data/hora local que a página manda junto: só letras, números e pontuação de data, curto.
const AGORA = /^[\p{L}\p{N} :+\-/,.()|_]{1,120}$/u

function jsonBody(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  const b = JSON.parse(raw)
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SyntaxError('JSON inválido')
  return b
}

// conversationId opcional: UUID gerado pelo servidor. Devolve undefined se ausente e lança se inválido.
class Invalido extends Error {}
function lerConversa(v: unknown): string | undefined {
  if (v == null || v === '') return undefined
  if (typeof v !== 'string' || !UUID.test(v)) throw new Invalido('conversationId inválido')
  return v
}

function jarvisApi(): Plugin {
  return {
    name: 'jarvis-api',
    configureServer(server) {
      // nenhum processo `claude` sobrevive ao servidor
      server.httpServer?.once('close', matarTodas)
      process.once('exit', matarTodas)

      // aquece um processo (CLI + MCP do ClickUp) enquanto a página carrega
      server.middlewares.use('/api/warm', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
        try {
          const body = jsonBody(await readBody(req))
          send(res, 200, { conversationId: aquecer(lerConversa(body.conversationId)) })
        } catch (e) {
          erroJson(res, e)
        }
      })

      // fala com o Piper local: {text} -> audio/wav
      server.middlewares.use('/api/tts', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
        try {
          const wav = await sintetizar(jsonBody(await readBody(req)).text)
          res.statusCode = 200
          res.setHeader('content-type', 'audio/wav')
          res.setHeader('content-length', wav.length)
          res.setHeader('cache-control', 'no-store')
          res.end(wav)
        } catch (e) {
          erroJson(res, e)
        }
      })

      // resposta em NDJSON: {conversationId} no começo, {delta} conforme o texto chega, depois
      // {done, conversationId} — ou {error}
      server.middlewares.use('/api/chat', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
        let conversationId: string | undefined
        try {
          const body = jsonBody(await readBody(req))
          const message = typeof body.message === 'string' ? body.message.trim() : ''
          if (!message) return send(res, 400, { error: 'message obrigatória' })
          conversationId = lerConversa(body.conversationId)
          let agora = new Date().toString() // sem o campo (curl), vale o relógio desta máquina
          if (body.agora != null && body.agora !== '') {
            if (typeof body.agora !== 'string' || !AGORA.test(body.agora)) return send(res, 400, { error: 'agora inválido' })
            agora = body.agora
          }

          const linha = (o: unknown) => {
            if (res.writableEnded) return
            if (!res.headersSent) {
              res.statusCode = 200
              res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
              res.setHeader('cache-control', 'no-cache, no-transform')
              res.setHeader('x-accel-buffering', 'no')
              res.flushHeaders()
            }
            res.write(JSON.stringify(o) + '\n')
          }
          // cliente que fechou/abortou: interrompe a resposta em andamento
          const ac = new AbortController()
          res.on('close', () => {
            if (!res.writableFinished) ac.abort()
          })

          let id = conversationId ?? ''
          try {
            await perguntar(
              conversationId,
              `[agora: ${agora}] ${message}`,
              (delta) => linha({ delta }),
              (novo) => {
                id = novo
                linha({ conversationId: id })
              },
              ac.signal,
            )
            linha({ done: true, conversationId: id })
          } catch (e) {
            linha({ error: e instanceof Error ? e.message : String(e) })
          }
          res.end()
        } catch (e) {
          erroJson(res, e)
        }
      })
    },
  }
}

function erroJson(res: ServerResponse, e: unknown) {
  if (e instanceof BodyGrande) return send(res, 413, { error: e.message })
  if (e instanceof SyntaxError) return send(res, 400, { error: 'JSON inválido' })
  if (e instanceof TextoGrande) return send(res, 413, { error: e.message })
  if (e instanceof TextoInvalido) return send(res, 400, { error: e.message })
  if (e instanceof TtsFalhou) return send(res, 500, { error: e.message })
  if (e instanceof TtsOcupado) return send(res, 503, { error: e.message })
  if (e instanceof Invalido) return send(res, 400, { error: e.message })
  send(res, 500, { error: e instanceof Error ? e.message : String(e) })
}

export default defineConfig({
  plugins: [react(), jarvisApi()],
  // a rota /api/chat executa o `claude`: nunca expor na rede
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
