import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

const TOKEN = 'a'.repeat(48)
const ENV = {
  HUBSPOT_ACCESS_TOKEN: 'fake-upstream-secret-never-log', HUBSPOT_ACCOUNT_ID: '123', HUBSPOT_PIPELINE_ID: '99',
  HUBSPOT_SCOPE_PROPERTY: 'sm_brand', HUBSPOT_SCOPE_VALUE: 'springmath', HUBSPOT_REQUESTER_EMAIL_PROPERTY: 'sm_email',
  HUBSPOT_CONVERSATION_ID_PROPERTY: 'sm_conversation', HUBSPOT_SUMMARY_PROPERTY: 'sm_summary',
  BROKER_INITIAL_STAGE_ID: '1', BROKER_ALLOWED_STAGE_IDS: '1,2,3', BROKER_CLOSED_STAGE_ID: '3',
  BROKER_TOKEN_SHA256: createHash('sha256').update(TOKEN).digest('hex'),
}
const AUTH = { Authorization: `Bearer ${TOKEN}` }
async function fixture(t, env = {}, fetchOverride) {
  const logs = [], calls = []
  const config = loadConfig({ ...ENV, ...env })
  const server = createServer(config, { logger: line => logs.push(line), fetchImpl: async (url, options) => {
    calls.push({ url, options })
    if (fetchOverride) return fetchOverride(url, options)
    if (url.endsWith('/account-info/v3/details')) return Response.json({ portalId: 123, secret: 'foreign-account-data' })
    return Response.json({ message: 'foreign-sensitive-detail', token: ENV.HUBSPOT_ACCESS_TOKEN }, { status: 403 })
  } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return { server, origin: `http://127.0.0.1:${server.address().port}`, logs, calls }
}

test('default config is read-only and loopback; stages and properties must be explicit', () => {
  const config = loadConfig(ENV)
  assert.equal(config.writes, false)
  assert.equal(config.host, '127.0.0.1')
  assert.throws(() => loadConfig({ ...ENV, BROKER_ENABLE_WRITES: 'true' }), /immutable/)
  assert.throws(() => loadConfig({ ...ENV, BROKER_ALLOWED_STAGE_IDS: '' }), /stage/)
  assert.throws(() => loadConfig({ ...ENV, HUBSPOT_SCOPE_PROPERTY: 'hs_pipeline' }), /custom/)
  assert.throws(() => loadConfig({ ...ENV, HUBSPOT_SUMMARY_PROPERTY: 'sm_brand' }), /distinct/)
  assert.throws(() => loadConfig({ ...ENV, BROKER_TOKEN_SHA256: TOKEN }), /SHA-256/)
  assert.throws(() => loadConfig({ ...ENV, BROKER_INITIAL_STAGE_ID: '900' }), /Initial/)
  assert.throws(() => loadConfig({ ...ENV, BROKER_ENABLE_WRITES: 'yes' }), /boolean/)
})
test('no auth, malformed token and wrong token are rejected without HubSpot calls', async t => {
  const { origin, calls } = await fixture(t)
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: `Bearer ${'b'.repeat(48)}` }, { Authorization: `Basic ${TOKEN}` }]) {
    const result = await fetch(`${origin}/account-info/v3/details`, { headers })
    assert.equal(result.status, 401)
    assert.equal((await result.json()).message, 'UNAUTHORIZED')
  }
  assert.equal(calls.length, 0)
})
test('valid bearer maps to upstream key, not caller headers, and minimal result', async t => {
  const { origin, calls } = await fixture(t)
  const result = await fetch(`${origin}/account-info/v3/details`, { headers: { ...AUTH, Cookie: 'secret-cookie', 'X-Forwarded-Host': 'evil.invalid' } })
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { portalId: 123 })
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.equal(result.headers.get('access-control-allow-origin'), null)
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${ENV.HUBSPOT_ACCESS_TOKEN}`)
  assert.equal(calls[0].options.headers.Cookie, undefined)
  assert.equal(calls[0].options.headers['X-Forwarded-Host'], undefined)
  assert.equal(calls[0].options.redirect, 'error')
})
test('duplicate Authorization headers fail closed', async t => {
  const { server, calls } = await fixture(t)
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/account-info/v3/details',
      headers: ['Host', '127.0.0.1', 'Authorization', `Bearer ${TOKEN}`, 'Authorization', `Bearer ${TOKEN}`] }, response => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject); request.end()
  })
  assert.equal(status, 401)
  assert.equal(calls.length, 0)
})
test('rejects malformed, encoded, oversized and non-JSON request bodies', async t => {
  const { origin, calls } = await fixture(t)
  for (const entry of [
    { body: '{broken', headers: { 'Content-Type': 'application/json' }, status: 400 },
    { body: '{}', headers: { 'Content-Type': 'text/plain' }, status: 415 },
    { body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, status: 415 },
    { body: 'x'.repeat(70000), headers: { 'Content-Type': 'application/json' }, status: 413 },
  ]) {
    const response = await fetch(`${origin}/crm/v3/objects/tickets/search`, { method: 'POST', body: entry.body, headers: { ...AUTH, ...entry.headers } })
    assert.equal(response.status, entry.status)
    await response.arrayBuffer()
  }
  assert.equal(calls.length, 0)
})
test('error bodies and audit logs never contain request/response content or credentials', async t => {
  const { origin, logs } = await fixture(t)
  const response = await fetch(`${origin}/crm/v3/objects/tickets/123?properties=subject`, { headers: AUTH })
  const body = await response.text()
  assert.equal(response.status, 503)
  for (const secret of [TOKEN, ENV.HUBSPOT_ACCESS_TOKEN, 'foreign-sensitive-detail', 'properties=subject', '/crm/v3']) {
    assert.ok(!body.includes(secret)); assert.ok(!JSON.stringify(logs).includes(secret))
  }
})
test('health is local, readiness is coalesced and cached', async t => {
  const { origin, calls } = await fixture(t)
  assert.equal((await fetch(`${origin}/healthz`)).status, 200)
  assert.equal(calls.length, 0)
  const results = await Promise.all(Array.from({ length: 12 }, () => fetch(`${origin}/readyz`)))
  assert.ok(results.every(result => result.status === 200))
  assert.equal(calls.length, 1)
})
test('wrong account makes readiness fail with no account metadata', async t => {
  const { origin } = await fixture(t, {}, async () => Response.json({ portalId: 999, company: 'other-brand' }))
  const response = await fetch(`${origin}/readyz`)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { ok: false })
})
test('bounded per-credential request rate', async t => {
  const { origin, calls } = await fixture(t, { BROKER_REQUESTS_PER_MINUTE: '1' })
  assert.equal((await fetch(`${origin}/account-info/v3/details`, { headers: AUTH })).status, 200)
  assert.equal((await fetch(`${origin}/account-info/v3/details`, { headers: AUTH })).status, 429)
  assert.equal(calls.length, 1)
})
test('bounds concurrent authenticated work independently of request rate', async t => {
  let release
  const latch = new Promise(resolve => { release = resolve })
  const { origin, calls } = await fixture(t, {}, async () => { await latch; return Response.json({ portalId: 123 }) })
  const pending = Array.from({ length: 8 }, () => fetch(`${origin}/account-info/v3/details`, { headers: AUTH }))
  for (let attempt = 0; calls.length < 8 && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(calls.length, 8)
  const extra = await fetch(`${origin}/account-info/v3/details`, { headers: AUTH })
  assert.equal(extra.status, 503)
  assert.equal((await extra.json()).message, 'BROKER_BUSY')
  release(); await Promise.all(pending)
})
