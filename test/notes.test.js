import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBroker, BrokerError } from '../src/broker.js'
import { loadConfig } from '../src/config.js'

const ROOT = 'https://api.hubapi.com'
const TICKETS = '/crm/v3/objects/tickets'
const NOTES = '/crm/v3/objects/notes'
const ROUTE = '/springmath/v1/tickets/1/notes'
const TIME = '2026-09-10T12:00:00.000Z'
const write = { accountId: '123', expectedUpdatedAt: TIME, body: 'Verified the Reports instructions.' }
const environment = {
  HUBSPOT_ACCESS_TOKEN: 'synthetic-upstream-token', HUBSPOT_ACCOUNT_ID: '123', HUBSPOT_PIPELINE_ID: '20',
  HUBSPOT_SCOPE_PROPERTY: 'sm_brand', HUBSPOT_SCOPE_VALUE: 'springmath',
  HUBSPOT_REQUESTER_EMAIL_PROPERTY: 'sm_requester', HUBSPOT_CONVERSATION_ID_PROPERTY: 'sm_conversation',
  HUBSPOT_SUMMARY_PROPERTY: 'sm_summary', BROKER_TOKEN_SHA256: 'a'.repeat(64),
  BROKER_INITIAL_STAGE_ID: '100', BROKER_ALLOWED_STAGE_IDS: '100,101,102,103',
  BROKER_CLOSED_STAGE_ID: '103', BROKER_ENABLE_WRITES: 'true', BROKER_SCOPE_IS_IMMUTABLE: 'true', BROKER_ENABLE_NOTES: 'true',
}
const ticket = { id: '1', archived: false, properties: {
  hs_pipeline: '20', sm_brand: 'springmath', hs_lastmodifieddate: TIME, sm_summary: 'Original summary',
} }
function note(id = '2') {
  return { id, archived: false, createdAt: TIME, updatedAt: TIME,
    properties: { hs_timestamp: TIME, hs_note_body: `<p>${write.body}</p>`, secret_property: 'MUST_NOT_LEAK' },
    associations: { tickets: { results: [{ id: '1', type: 'note_to_ticket' }] } }, secretField: 'MUST_NOT_LEAK' }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function fixture(settings = {}, hook) {
  const config = loadConfig({ ...environment, ...settings })
  const calls = []
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl)
    const call = { url, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body) }
    calls.push(call)
    assert.equal(url.origin, ROOT)
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, `Bearer ${config.upstreamToken}`)
    const intercepted = await hook?.(call, calls)
    if (intercepted !== undefined) return intercepted
    if (url.pathname === '/account-info/v3/details') return json({ portalId: 123 })
    if (url.pathname === `${TICKETS}/1`) return json(ticket)
    if (url.pathname === `${TICKETS}/1/associations/notes`) return json({ results: [{ id: '2', type: 'ticket_to_note' }] })
    if (url.pathname === `${NOTES}/2`) return json(note())
    if (url.pathname === NOTES && call.method === 'POST') return json({ id: '2' }, 201)
    assert.fail(`Unexpected upstream ${call.method} ${url.pathname}`)
  }
  return { broker: createBroker(config, { fetchImpl }), calls }
}
async function reject(operation, status, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof BrokerError)
    assert.equal(error.status, status)
    if (code) assert.equal(error.code, code)
    assert.ok(!error.message.includes('MUST_NOT_LEAK'))
    return true
  })
}

test('notes feature is disabled by default and strict boolean validated', async () => {
  for (const enabled of [undefined, '', 'false']) {
    const { broker, calls } = fixture({ BROKER_ENABLE_NOTES: enabled })
    await reject(() => broker.handle({ method: 'GET', url: ROUTE }), 404)
    await reject(() => broker.handle({ method: 'POST', url: ROUTE, body: write }), 404)
    assert.equal(calls.length, 0)
  }
  assert.throws(() => loadConfig({ ...environment, BROKER_ENABLE_NOTES: 'TRUE' }), /Invalid boolean/)
})

test('lists only exclusive same-ticket notes and projects away raw vendor metadata', async () => {
  const { broker, calls } = fixture()
  const result = await broker.handle({ method: 'GET', url: ROUTE })
  assert.deepEqual(result, { status: 200, body: { results: [{
    id: '2', archived: false, createdAt: TIME, updatedAt: TIME,
    properties: { hs_timestamp: TIME, hs_note_body: `<p>${write.body}</p>` },
    associations: { tickets: { results: [{ id: '1', type: 'note_to_ticket' }] } },
  }], notesWithheld: false } })
  assert.ok(!JSON.stringify(result).includes('MUST_NOT_LEAK'))
  const reads = calls.filter(call => call.url.pathname.startsWith(`${NOTES}/`))
  assert.deepEqual(reads.map(call => call.url.searchParams.get('properties')), ['hs_timestamp', 'hs_timestamp,hs_note_body'])
  assert.ok(calls.every(call => call.method === 'GET'))
  assert.equal(calls.at(-1).url.pathname, `${TICKETS}/1`)
})

test('creates only a native note with one server-selected ticket association and no summary or email changes', async () => {
  const { broker, calls } = fixture()
  assert.deepEqual(await broker.handle({ method: 'POST', url: ROUTE, body: write }), { status: 201, body: { id: '2', note: {
    id: '2', archived: false, createdAt: TIME, updatedAt: TIME,
    properties: { hs_timestamp: TIME, hs_note_body: `<p>${write.body}</p>` },
    associations: { tickets: { results: [{ id: '1', type: 'note_to_ticket' }] } },
  } } })
  const posts = calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url.pathname, NOTES)
  assert.deepEqual(posts[0].body, {
    properties: { hs_timestamp: posts[0].body.properties.hs_timestamp, hs_note_body: `<p>${write.body}</p>` },
    associations: [{ to: { id: '1' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 228 }] }],
  })
  assert.ok(Number.isFinite(Date.parse(posts[0].body.properties.hs_timestamp)))
  assert.ok(!calls.some(call => ['PATCH', 'DELETE'].includes(call.method)))
  assert.equal(calls.at(-1).url.pathname, `${TICKETS}/1`)
})

test('escapes approved plain text so it cannot inject markup, links or HubSpot mentions', async () => {
  const raw = '<b>hello</b> & "test"\r\nnext'
  const html = '<p>&lt;b&gt;hello&lt;/b&gt; &amp; &quot;test&quot;<br>next</p>'
  const { broker } = fixture({}, call => {
    if (call.url.pathname === NOTES && call.method === 'POST') {
      assert.equal(call.body.properties.hs_note_body, html)
      return json({ id: '2' }, 201)
    }
    if (call.url.pathname === `${NOTES}/2`) return json({ ...note(), properties: { hs_timestamp: TIME, hs_note_body: html } })
  })
  await broker.handle({ method: 'POST', url: ROUTE, body: { ...write, body: raw } })
})

test('notes reads work with writes disabled but creation requires the immutable ownership assertion', async () => {
  const { broker, calls } = fixture({ BROKER_ENABLE_WRITES: 'false', BROKER_SCOPE_IS_IMMUTABLE: 'false' })
  await broker.handle({ method: 'GET', url: ROUTE })
  await reject(() => broker.handle({ method: 'POST', url: ROUTE, body: write }), 403, 'WRITES_DISABLED')
  assert.ok(!calls.some(call => call.method === 'POST'))
  assert.throws(() => loadConfig({ ...environment, BROKER_SCOPE_IS_IMMUTABLE: 'false' }), /immutable/)
})

for (const path of [NOTES, `${NOTES}/2`, `${NOTES}/search`, `${NOTES}/batch/read`,
  `${TICKETS}/1/associations/notes`, '/springmath/v1/tickets/../notes', '/springmath/v1/tickets/1/notes/2']) {
  test(`generic note/association or arbitrary-note route stays denied: ${path}`, async () => {
    const { broker, calls } = fixture()
    await assert.rejects(() => broker.handle({ method: 'GET', url: path }), BrokerError)
    assert.equal(calls.length, 0)
  })
}

for (const body of [
  { ...write, accountId: '456' }, { ...write, expectedUpdatedAt: 'nonsense' }, { ...write, body: '' },
  { ...write, body: 'x'.repeat(10001) }, { ...write, body: 'null\u0000body' },
  { ...write, associations: [{ to: { id: 'foreign' } }] }, { ...write, properties: { hs_note_body: 'other' } },
  { ...write, noteId: '2' }, { ...write, hubspot_owner_id: '3' },
]) {
  test(`strict note create parameters reject injected fields or malformed values ${JSON.stringify(body).slice(0, 100)}`, async () => {
    const { broker, calls } = fixture()
    await reject(() => broker.handle({ method: 'POST', url: ROUTE, body }), 400)
    assert.ok(calls.every(call => call.url.pathname === '/account-info/v3/details'))
  })
}

for (const foreign of [
  { ...ticket, archived: true }, { ...ticket, id: '99' },
  { ...ticket, properties: { ...ticket.properties, hs_pipeline: '21' } },
  { ...ticket, properties: { ...ticket.properties, sm_brand: 'another-brand' } },
  { ...ticket, properties: { ...ticket.properties, sm_brand: null } },
]) {
  test(`denies parent outside active account/pipeline/brand before notes access ${JSON.stringify(foreign)}`, async () => {
    const { broker, calls } = fixture({}, call => call.url.pathname === `${TICKETS}/1` ? json(foreign) : undefined)
    await assert.rejects(() => broker.handle({ method: 'GET', url: ROUTE }), BrokerError)
    await assert.rejects(() => broker.handle({ method: 'POST', url: ROUTE, body: write }), BrokerError)
    assert.ok(!calls.some(call => call.url.pathname.includes('/notes')))
  })
}

test('checks the credential account before parent or notes access', async () => {
  const { broker, calls } = fixture({}, call => call.url.pathname === '/account-info/v3/details' ? json({ portalId: 999 }) : undefined)
  await reject(() => broker.handle({ method: 'GET', url: ROUTE }), 503, 'UPSTREAM_ACCOUNT_MISMATCH')
  assert.equal(calls.length, 1)
})

test('rejects stale note approval without POST', async () => {
  const { broker, calls } = fixture()
  await reject(() => broker.handle({ method: 'POST', url: ROUTE, body: { ...write, expectedUpdatedAt: '2020-01-01' } }), 409, 'STALE_APPROVAL')
  assert.ok(calls.every(call => call.method === 'GET'))
})

for (const associations of [undefined, {},
  { tickets: { results: [{ id: '1' }], paging: { next: { after: '1' } } } },
  { tickets: note().associations.tickets, contacts: { results: [{ id: '../foreign' }] } },
  { tickets: note().associations.tickets, contacts: { results: [null] } },
  { tickets: note().associations.tickets, contacts: { results: [{ id: '9' }, { id: '9' }] } },
  { tickets: note().associations.tickets, contacts: { results: [{ id: '9' }] }, deals: { results: [], paging: {} } },
  { tickets: note().associations.tickets, other: { results: [] } },
]) {
  test(`does not retrieve note body if note lacks exclusive same-ticket binding ${JSON.stringify(associations)}`, async () => {
    const { broker, calls } = fixture({}, call => call.url.pathname === `${NOTES}/2` ? json({ ...note(), associations }) : undefined)
    await reject(() => broker.handle({ method: 'GET', url: ROUTE }), 404, 'NOT_FOUND')
    const noteCalls = calls.filter(call => call.url.pathname.startsWith(`${NOTES}/`))
    assert.equal(noteCalls.length, 1)
    assert.equal(noteCalls[0].url.searchParams.get('properties'), 'hs_timestamp')
  })
}

for (const associations of [
  { tickets: { results: [] } }, { tickets: { results: [{ id: '99' }] } },
  { tickets: { results: [{ id: '1' }, { id: '99' }] } },
  { tickets: note().associations.tickets, contacts: { results: [{ id: '9' }] } },
  { tickets: note().associations.tickets, companies: { results: [{ id: '9' }] } },
  { tickets: note().associations.tickets, deals: { results: [{ id: '9' }] } },
]) {
  test(`withholds a definitively cross-record note without retrieving its body ${JSON.stringify(associations)}`, async () => {
    const { broker, calls } = fixture({}, call => call.url.pathname === `${NOTES}/2` ? json({ ...note(), associations }) : undefined)
    assert.deepEqual(await broker.handle({ method: 'GET', url: ROUTE }), { status: 200, body: { results: [], notesWithheld: true } })
    const noteCalls = calls.filter(call => call.url.pathname.startsWith(`${NOTES}/`))
    assert.equal(noteCalls.length, 1)
    assert.equal(noteCalls[0].url.searchParams.get('properties'), 'hs_timestamp')
  })
}

test('returns permitted notes with a presence-only notice but never foreign IDs or counts', async () => {
  const { broker, calls } = fixture({}, call => {
    if (call.url.pathname === `${TICKETS}/1/associations/notes`) return json({ results: [{ id: '2' }, { id: '900000' }] })
    if (call.url.pathname === `${NOTES}/900000`) return json({ ...note('900000'), associations: {
      tickets: note().associations.tickets, contacts: { results: [{ id: '9999999' }] },
    } })
  })
  const result = await broker.handle({ method: 'GET', url: ROUTE })
  assert.equal(result.body.notesWithheld, true)
  assert.deepEqual(result.body.results.map(row => row.id), ['2'])
  assert.ok(!/900000|9999999|count/i.test(JSON.stringify(result)))
  assert.equal(calls.filter(call => call.url.pathname === `${NOTES}/900000`).length, 1)
})

test('uses at most three concurrent per-note reads through the fifty-note bound', async () => {
  let active = 0
  let peak = 0
  const boundaries = new Set()
  const { broker } = fixture({}, async call => {
    if (call.url.pathname === `${TICKETS}/1/associations/notes`) return json({ results: Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1) })) })
    if (call.url.pathname.startsWith(`${NOTES}/`)) {
      const id = call.url.pathname.split('/').at(-1)
      if (call.url.searchParams.get('properties').includes('hs_note_body')) assert.ok(boundaries.has(id))
      else boundaries.add(id)
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return json(note(id))
    }
  })
  const result = await broker.handle({ method: 'GET', url: ROUTE })
  assert.equal(result.body.results.length, 50)
  assert.equal(result.body.notesWithheld, false)
  assert.equal(peak, 3)
  assert.equal(active, 0)
})

test('confirms a created note directly even when its ticket has more than fifty notes', async () => {
  const { broker, calls } = fixture({}, call => {
    if (call.url.pathname === `${TICKETS}/1/associations/notes`) return json({ results: Array.from({ length: 51 }, (_, index) => ({ id: String(index + 1) })), paging: { next: { after: '52' } } })
  })
  const result = await broker.handle({ method: 'POST', url: ROUTE, body: write })
  assert.equal(result.body.id, '2')
  assert.equal(result.body.note.id, '2')
  assert.ok(!calls.some(call => call.url.pathname === `${TICKETS}/1/associations/notes`))
})

test('bounds cumulative response bytes across concurrent notes including discarded JSON whitespace', async () => {
  const { broker } = fixture({}, call => {
    if (call.url.pathname === `${TICKETS}/1/associations/notes`) return json({ results: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1) })) })
    if (call.url.pathname.startsWith(`${NOTES}/`)) return new Response(' '.repeat(1000000) + JSON.stringify(note(call.url.pathname.split('/').at(-1))), { headers: { 'Content-Type': 'application/json' } })
  })
  await reject(() => broker.handle({ method: 'GET', url: ROUTE }), 503, 'QUERY_BOUND_EXCEEDED')
})

test('never returns a partial successful list when another note has malformed association metadata', async () => {
  const { broker } = fixture({}, call => {
    if (call.url.pathname === `${TICKETS}/1/associations/notes`) return json({ results: [{ id: '2' }, { id: '3' }] })
    if (call.url.pathname === `${NOTES}/3`) return json({ ...note('3'), associations: {
      tickets: note().associations.tickets, contacts: { results: [{ id: '9' }] }, deals: { results: [], paging: {} },
    } })
  })
  await reject(() => broker.handle({ method: 'GET', url: ROUTE }), 404, 'NOT_FOUND')
})

for (const page of [{}, { results: [{ id: '../foreign' }] }, { results: [{ id: '2' }, { id: '2' }] },
  { results: [{ id: '2' }], paging: { next: { after: '1' } } },
  { results: Array.from({ length: 51 }, (_, index) => ({ id: String(index + 1) })) },
]) {
  test(`fails closed rather than return partial/malformed association list ${JSON.stringify(page).slice(0, 100)}`, async () => {
    const { broker, calls } = fixture({}, call => call.url.pathname === `${TICKETS}/1/associations/notes` ? json(page) : undefined)
    await assert.rejects(() => broker.handle({ method: 'GET', url: ROUTE }), BrokerError)
    assert.ok(!calls.some(call => call.url.pathname.startsWith(`${NOTES}/`)))
  })
}

test('bounds cumulative retained notes rather than returning a partial list', async () => {
  const { broker } = fixture({}, call => {
    if (call.url.pathname === `${TICKETS}/1/associations/notes`) return json({ results: [2, 3, 4, 5].map(id => ({ id: String(id) })) })
    if (call.url.pathname.startsWith(`${NOTES}/`)) {
      const row = note(call.url.pathname.split('/').at(-1))
      row.properties.hs_note_body = 'x'.repeat(60000)
      return json(row)
    }
  })
  await reject(() => broker.handle({ method: 'GET', url: ROUTE }), 503, 'QUERY_BOUND_EXCEEDED')
})

test('rechecks note associations after content read to deny a concurrently shared note', async () => {
  let reads = 0
  const { broker } = fixture({}, call => {
    if (call.url.pathname === `${NOTES}/2`) return json(++reads === 1 ? note() : {
      ...note(), associations: { tickets: { results: [{ id: '1' }, { id: '99' }] } },
    })
  })
  await reject(() => broker.handle({ method: 'GET', url: ROUTE }), 404)
})

test('rechecks parent ownership after note reads before responding', async () => {
  let reads = 0
  const { broker } = fixture({}, call => {
    if (call.url.pathname === `${TICKETS}/1`) return json(++reads === 1 ? ticket : {
      ...ticket, properties: { ...ticket.properties, sm_brand: 'other' },
    })
  })
  await reject(() => broker.handle({ method: 'GET', url: ROUTE }), 404)
})

for (const status of [200, 202, 500]) {
  test(`never retries unknown notes POST with status ${status}`, async () => {
    const { broker, calls } = fixture({}, call => call.url.pathname === NOTES && call.method === 'POST' ? json({ id: '2', private: 'MUST_NOT_LEAK' }, status) : undefined)
    await reject(() => broker.handle({ method: 'POST', url: ROUTE, body: write }), 502, 'WRITE_OUTCOME_UNKNOWN')
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  })
}

test('never retries a notes POST transport error', async () => {
  const { broker, calls } = fixture({}, call => {
    if (call.url.pathname === NOTES && call.method === 'POST') throw new Error('MUST_NOT_LEAK')
  })
  await reject(() => broker.handle({ method: 'POST', url: ROUTE, body: write }), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
})

for (const after of [
  { ...note(), archived: true }, { ...note(), id: '99' }, { ...note(), updatedAt: 'invalid' },
  { ...note(), associations: { tickets: { results: [{ id: '99' }] } } },
  { ...note(), properties: { hs_timestamp: TIME, hs_note_body: 'wrong body' } },
]) {
  test(`requires matching note body and association before confirming POST ${JSON.stringify(after).slice(0, 110)}`, async () => {
    const { broker, calls } = fixture({}, call => call.url.pathname === `${NOTES}/2` ? json(after) : undefined)
    await reject(() => broker.handle({ method: 'POST', url: ROUTE, body: write }), 502, 'WRITE_OUTCOME_UNKNOWN')
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  })
}
