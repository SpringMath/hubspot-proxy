import http from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { BrokerError, createBroker } from './broker.js'

export function createServer(config, { fetchImpl, logger = line => process.stdout.write(`${JSON.stringify(line)}\n`) } = {}) {
  const broker = createBroker(config, { fetchImpl })
  let inFlight = 0
  let windowStart = Date.now()
  let requests = 0
  let readinessAt = 0
  let readinessOk = false
  let readinessPending
  const tokenDigest = Buffer.from(config.tokenHash, 'hex')
  function authenticated(request) {
    let count = 0
    for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === 'authorization') count++
    if (count !== 1) return false
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !/^Bearer [a-zA-Z0-9_-]{32,256}$/.test(authorization)) return false
    return timingSafeEqual(createHash('sha256').update(authorization.slice(7)).digest(), tokenDigest)
  }
  async function readBody(request) {
    if (request.headers['content-encoding'] !== undefined) throw new BrokerError(415, 'ENCODING_NOT_SUPPORTED')
    if (Number(request.headers['content-length'] || 0) > config.maxBodyBytes) throw new BrokerError(413, 'BODY_TOO_LARGE')
    const chunks = []
    let length = 0
    for await (const chunk of request) {
      length += chunk.length
      if (length > config.maxBodyBytes) throw new BrokerError(413, 'BODY_TOO_LARGE')
      chunks.push(chunk)
    }
    if (!length) return undefined
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) throw new BrokerError(415, 'JSON_REQUIRED')
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new BrokerError(400, 'INVALID_JSON') }
  }
  function send(response, status, body, requestId) {
    if (response.destroyed || response.writableEnded || response.headersSent) return
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId,
      ...(status >= 400 ? { Connection: 'close' } : {}),
    })
    response.end(status === 204 ? undefined : JSON.stringify(body))
  }
  async function ready() {
    if (Date.now() - readinessAt < 15000) return readinessOk
    if (!readinessPending) {
      readinessPending = broker.ready().then(() => { readinessOk = true }, () => { readinessOk = false })
        .finally(() => { readinessAt = Date.now(); readinessPending = undefined })
    }
    await readinessPending
    return readinessOk
  }
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 }, async (request, response) => {
    const requestId = randomUUID()
    const started = Date.now()
    let counted = false
    let status = 500
    let outcome = 'INTERNAL_ERROR'
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        status = 200; outcome = 'HEALTH'; send(response, status, { ok: true }, requestId); return
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        const ok = await ready()
        status = ok ? 200 : 503; outcome = 'READINESS'; send(response, status, { ok }, requestId); return
      }
      if (!authenticated(request)) throw new BrokerError(401, 'UNAUTHORIZED')
      if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requests = 0 }
      if (++requests > config.requestsPerMinute) throw new BrokerError(429, 'RATE_LIMITED')
      if (inFlight >= 8) throw new BrokerError(503, 'BROKER_BUSY')
      inFlight++; counted = true
      const body = await readBody(request)
      const result = await broker.handle({ method: request.method, url: request.url, body })
      status = result.status; outcome = 'OK'
      send(response, status, result.body, requestId)
    } catch (error) {
      if (error instanceof BrokerError) { status = error.status; outcome = error.code }
      send(response, status, { status: 'error', category: outcome, message: outcome, correlationId: requestId }, requestId)
    } finally {
      if (counted) inFlight--
      // Never log URL, query, request/response body, email, ticket IDs, tokens or raw errors.
      if (!['HEALTH', 'READINESS'].includes(outcome)) {
        try { logger({ event: 'broker_request', requestId, method: request.method, status, outcome, durationMs: Date.now() - started }) }
        catch { /* Logging failure must not expose request content or reject the HTTP callback. */ }
      }
    }
  })
  server.maxConnections = 128
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let config
  try { config = loadConfig() }
  catch (error) { process.stderr.write(`Configuration error: ${error.message}\n`); process.exit(1) }
  const server = createServer(config)
  server.listen(config.port, config.host, () => process.stdout.write('HubSpot broker listening\n'))
  const stop = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
