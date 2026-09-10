import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBroker, BrokerError } from '../src/broker.js'
import { loadConfig } from '../src/config.js'

const TICKETS = '/crm/v3/objects/tickets'
const CONTACTS = '/crm/v3/objects/contacts'
const ACCOUNT = '/account-info/v3/details'
const PIPELINE = '/crm/v3/pipelines/tickets/20'
const EXTERNAL = 'springmath-au-123-conversation-synthetic'
const EMAIL = 'synthetic@example.test'

function config(overrides = {}) {
  return loadConfig({
    HUBSPOT_ACCESS_TOKEN: 'synthetic-upstream-token-not-a-secret',
    HUBSPOT_ACCOUNT_ID: '123', HUBSPOT_PIPELINE_ID: '20',
    HUBSPOT_SCOPE_PROPERTY: 'sm_brand', HUBSPOT_SCOPE_VALUE: 'springmath',
    HUBSPOT_REQUESTER_EMAIL_PROPERTY: 'sm_requester',
    HUBSPOT_CONVERSATION_ID_PROPERTY: 'sm_conversation',
    HUBSPOT_SUMMARY_PROPERTY: 'sm_summary',
    BROKER_TOKEN_SHA256: 'a'.repeat(64),
    BROKER_INITIAL_STAGE_ID: '100', BROKER_CLOSED_STAGE_ID: '103',
    BROKER_ALLOWED_STAGE_IDS: '100,101,102,103',
    ...overrides,
  })
}

function record(id = '1', properties = {}, extra = {}) {
  return {
    id, archived: false,
    properties: {
      hs_pipeline: '20', sm_brand: 'springmath', hs_pipeline_stage: '100',
      subject: `Synthetic ticket ${id}`, content: 'Synthetic issue',
      hs_lastmodifieddate: '2026-09-10T12:00:00.000Z',
      sm_summary: 'Synthetic summary', sm_requester: EMAIL, sm_conversation: EXTERNAL,
      private_other_brand_notes: 'MUST_NOT_LEAK', ...properties,
    },
    associations: { contacts: { results: [{ id: '900' }, { id: '901' }] } },
    secretVendorField: 'MUST_NOT_LEAK', ...extra,
  }
}

function pipeline() {
  return { id: '20', archived: false, secretVendorField: 'MUST_NOT_LEAK', stages: [
    { id: '100', label: 'Ochre Tier 1', metadata: { ticketState: 'OPEN', private: 'MUST_NOT_LEAK' } },
    { id: '101', label: 'SpringMath Tier 2', metadata: { ticketState: 'OPEN' } },
    { id: '102', label: 'Returned to Ochre', metadata: { ticketState: 'OPEN' } },
    { id: '103', label: 'Closed', metadata: { ticketState: 'CLOSED' } },
    { id: '999', label: 'Unapproved stage', metadata: { ticketState: 'OPEN' } },
  ] }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function fixture({ rows = [record()], hook, accountId = 123, contactMissing = false,
  searchPages, archivePages, settings = {} } = {}) {
  const state = new Map(rows.map(row => [row.id, structuredClone(row)]))
  const calls = []
  let missingContact = contactMissing
  const cfg = config(settings)
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl)
    const call = { url, rawUrl, method: options.method, options,
      body: options.body === undefined ? undefined : JSON.parse(options.body) }
    calls.push(call)
    assert.equal(url.origin, 'https://api.hubapi.com', 'never send upstream token to another origin')
    assert.equal(options.redirect, 'error', 'upstream redirects must never be followed')
    assert.equal(options.headers.Authorization, `Bearer ${cfg.upstreamToken}`)
    const intercepted = await hook?.(call, { state, calls })
    if (intercepted !== undefined) return intercepted
    if (url.pathname === ACCOUNT) return json({ portalId: accountId, private: 'MUST_NOT_LEAK' })
    if (url.pathname === PIPELINE) return json(pipeline())
    if (url.pathname === '/crm/v3/properties/tickets/sm_conversation') {
      return json({ name: 'sm_conversation', type: 'string', hasUniqueValue: true, private: 'MUST_NOT_LEAK' })
    }
    if (url.pathname === `${TICKETS}/search`) {
      const pageIndex = Number(call.body.after ?? 0)
      return json(searchPages?.[pageIndex] ?? { total: 987654, results: [...state.values()].filter(row => !row.archived) })
    }
    if (url.pathname === `${TICKETS}/batch/read`) {
      return json({ results: call.body.inputs.map(input => state.get(input.id)).filter(Boolean) })
    }
    if (url.pathname === TICKETS && call.method === 'GET') {
      const pageIndex = Number(url.searchParams.get('after') ?? 0)
      return json(archivePages?.[pageIndex] ?? { results: [...state.values()].filter(row => row.archived) })
    }
    if (url.pathname === CONTACTS && call.method === 'POST') {
      missingContact = false
      return json({ id: '900', archived: false, properties: { email: call.body.properties.email, private: 'MUST_NOT_LEAK' } }, 201)
    }
    if (url.pathname.startsWith(`${CONTACTS}/`)) {
      if (missingContact) return json({ message: 'private vendor missing details' }, 404)
      return json({ id: '900', archived: false, properties: { email: EMAIL, private: 'MUST_NOT_LEAK' } })
    }
    if (url.pathname === TICKETS && call.method === 'POST') {
      const created = record('500', call.body.properties, {
        associations: { contacts: { results: call.body.associations.map(item => ({ id: item.to.id })) } },
      })
      state.set('500', created)
      return json(created, 201)
    }
    if (url.pathname.startsWith(`${TICKETS}/`)) {
      const id = decodeURIComponent(url.pathname.slice(TICKETS.length + 1))
      const idProperty = url.searchParams.get('idProperty')
      const row = idProperty ? [...state.values()].find(item => item.properties[idProperty] === id) : state.get(id)
      if (!row || row.archived !== (url.searchParams.get('archived') === 'true')) {
        return json({ message: 'private upstream message', contactId: 'OTHER_BRAND' }, 404)
      }
      if (call.method === 'PATCH') {
        Object.assign(row.properties, call.body.properties)
        return json(row)
      }
      if (call.method === 'DELETE') {
        row.archived = true
        return new Response(null, { status: 204 })
      }
      return json(row)
    }
    assert.fail(`Unexpected upstream request ${call.method} ${url.pathname}`)
  }
  return { broker: createBroker(cfg, { fetchImpl }), cfg, calls, state }
}

const writes = { BROKER_ENABLE_WRITES: 'true', BROKER_SCOPE_IS_IMMUTABLE: 'true' }
const createBody = () => ({ properties: { subject: 'Synthetic customer issue', content: 'Synthetic description only',
  sm_conversation: EXTERNAL, sm_requester: EMAIL } })

async function reject(operation, status, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof BrokerError, `expected controlled BrokerError, got ${error}`)
    assert.equal(error.status, status)
    if (code !== undefined) assert.equal(error.code, code)
    assert.ok(!error.message.includes('MUST_NOT_LEAK'))
    return true
  })
}

test('account and pipeline metadata project only the configured account, stages and public fields', async () => {
  const { broker } = fixture()
  assert.deepEqual(await broker.ready(), { portalId: 123 })
  assert.deepEqual(await broker.handle({ method: 'GET', url: ACCOUNT }), { status: 200, body: { portalId: 123 } })
  const response = await broker.handle({ method: 'GET', url: PIPELINE })
  assert.deepEqual(response.body.stages.map(stage => stage.id), ['100', '101', '102', '103'])
  assert.ok(!JSON.stringify(response).includes('MUST_NOT_LEAK'))
  assert.ok(!JSON.stringify(response).includes('999'))
})

test('wrong upstream account fails readiness and prevents all ticket access', async () => {
  const { broker, calls } = fixture({ accountId: 456 })
  await reject(() => broker.ready(), 503, 'UPSTREAM_ACCOUNT_MISMATCH')
  await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}/1` }), 503, 'UPSTREAM_ACCOUNT_MISMATCH')
  assert.ok(calls.every(call => call.url.pathname === ACCOUNT))
})

test('single-ticket response strips unrequested properties, contact IDs, vendor metadata and links', async () => {
  const { broker } = fixture()
  const response = await broker.handle({ method: 'GET', url: `${TICKETS}/1?properties=subject` })
  assert.deepEqual(response, { status: 200, body: { id: '1', archived: false,
    properties: { subject: 'Synthetic ticket 1', hs_pipeline: '20', sm_brand: 'springmath' } } })
  assert.ok(!JSON.stringify(response).includes('900'))
})

for (const [name, foreign] of [
  ['another pipeline', record('2', { hs_pipeline: '21' })],
  ['another brand', record('2', { sm_brand: 'another-brand' })],
  ['missing marker', record('2', { sm_brand: null })],
]) {
  test(`foreign ticket in ${name} is indistinguishable from a nonexistent ticket`, async () => {
    const { broker } = fixture({ rows: [foreign] })
    await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}/2` }), 404, 'NOT_FOUND')
    await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}/99999` }), 404, 'NOT_FOUND')
  })
}

test('archived ticket reads are opt-in and retain brand checks', async () => {
  const { broker } = fixture({ rows: [record('1', {}, { archived: true }), record('2', { sm_brand: 'foreign' }, { archived: true })] })
  await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}/1` }), 404)
  assert.equal((await broker.handle({ method: 'GET', url: `${TICKETS}/1?archived=true` })).body.archived, true)
  await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}/2?archived=true` }), 404)
})

for (const [method, path] of [
  ['GET', `${CONTACTS}/${EMAIL}?idProperty=email&properties=email`],
  ['POST', CONTACTS], ['PATCH', `${CONTACTS}/900`],
  ['POST', `${TICKETS}/batch/read`], ['GET', `${TICKETS}/1/associations/contacts`],
  ['GET', '/crm/v3/pipelines/tickets/999'], ['GET', '/crm/v3/objects/companies'],
  ['POST', '/crm/v3/objects/notes'], ['GET', '/conversations/v3/conversations/threads'],
]) {
  test(`unexposed route ${method} ${path} never reaches upstream`, async () => {
    const { broker, calls } = fixture()
    await reject(() => broker.handle({ method, url: path }), 404, 'NOT_FOUND')
    assert.equal(calls.length, 0)
  })
}

for (const path of [
  `${TICKETS}/1?associations=contacts`, `${TICKETS}/1?properties=private_other_brand_notes`,
  `${TICKETS}/1?properties=subject&properties=content`, `${TICKETS}/1?idProperty=email`,
  `${TICKETS}/1?archived=1`, `${TICKETS}/1?verifyRequester=false`,
  '//evil.example/crm/v3/objects/tickets/1', 'https://evil.example/tickets/1',
  `${TICKETS}/%2faccount-info`, `${TICKETS}/%2e%2e`,
  `${TICKETS}/1?properties=subject#fragment`, `${TICKETS}/1\\anything`,
]) {
  test(`invalid read/route request is rejected: ${path}`, async () => {
    const { broker } = fixture()
    await reject(() => broker.handle({ method: 'GET', url: path }), 400, 'INVALID_REQUEST')
  })
}

test('custom external-ID reconciliation accepts only the configured property and checks ownership', async () => {
  const { broker } = fixture()
  const response = await broker.handle({ method: 'GET', url: `${TICKETS}/${EXTERNAL}?idProperty=sm_conversation&properties=subject` })
  assert.equal(response.body.id, '1')
  assert.equal(response.body.properties.sm_conversation, undefined, 'unrequested lookup property is not projected')
  await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}/${EXTERNAL}?idProperty=foreign_unique_id` }), 404)
  const foreign = fixture({ rows: [record('1', { sm_brand: 'foreign' })] })
  await reject(() => foreign.broker.handle({ method: 'GET', url: `${TICKETS}/${EXTERNAL}?idProperty=sm_conversation` }), 404)
})

test('private requester verification returns a boolean without public contact records or association IDs', async () => {
  const { broker, calls } = fixture()
  const response = await broker.handle({ method: 'GET', url: `${TICKETS}/1?verifyRequester=true&properties=subject` })
  assert.deepEqual(response.body.broker, { requesterAssociated: true })
  assert.equal(response.body.associations, undefined)
  assert.equal(response.body.properties.sm_requester, undefined)
  assert.ok(!JSON.stringify(response).includes('900'))
  const contactCall = calls.find(call => call.url.pathname.startsWith(`${CONTACTS}/`))
  assert.equal(decodeURIComponent(contactCall.url.pathname.slice(CONTACTS.length + 1)), EMAIL)
  assert.equal(contactCall.url.searchParams.get('properties'), 'email')
})

test('requester verification does not accept a different primary email or a missing association', async () => {
  const wrongEmail = fixture({ hook: call => call.url.pathname.startsWith(`${CONTACTS}/`)
    ? json({ id: '900', archived: false, properties: { email: 'someone-else@example.test' } }) : undefined })
  await reject(() => wrongEmail.broker.handle({ method: 'GET', url: `${TICKETS}/1?verifyRequester=true` }), 502, 'REQUESTER_ASSOCIATION_UNVERIFIED')
  const missingAssociation = fixture({ rows: [record('1', {}, { associations: { contacts: { results: [{ id: '901' }] } } })] })
  await reject(() => missingAssociation.broker.handle({ method: 'GET', url: `${TICKETS}/1?verifyRequester=true` }), 502, 'REQUESTER_ASSOCIATION_UNVERIFIED')
})

test('search injects both ownership restrictions into every OR group and never trusts upstream total or links', async () => {
  const { broker, calls } = fixture({ rows: [record('1'), record('2'), record('3', { sm_brand: 'foreign' })] })
  const response = await broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: {
    filterGroups: [
      { filters: [{ propertyName: 'subject', operator: 'EQ', value: 'Synthetic ticket 1' }] },
      { filters: [{ propertyName: 'subject', operator: 'EQ', value: 'Synthetic ticket 2' }] },
    ], properties: ['subject'], limit: 1,
  } })
  const outbound = calls.find(call => call.url.pathname === `${TICKETS}/search`).body
  assert.equal(outbound.filterGroups.length, 2)
  for (const group of outbound.filterGroups) {
    assert.ok(group.filters.some(filter => filter.propertyName === 'hs_pipeline' && filter.operator === 'EQ' && filter.value === '20'))
    assert.ok(group.filters.some(filter => filter.propertyName === 'sm_brand' && filter.operator === 'EQ' && filter.value === 'springmath'))
  }
  assert.equal(response.body.total, 2)
  assert.deepEqual(response.body.results.map(row => row.id), ['1'])
  assert.deepEqual(response.body.paging, { next: { after: '1' } })
  assert.ok(!JSON.stringify(response).includes('MUST_NOT_LEAK'))
})

for (const filter of [
  { propertyName: 'hs_pipeline', operator: 'EQ', value: '999' },
  { propertyName: 'sm_brand', operator: 'NEQ', value: 'springmath' },
  { propertyName: 'sm_brand', operator: 'IN', values: ['springmath', 'foreign'] },
  { propertyName: 'private_other_brand_notes', operator: 'EQ', value: 'secret' },
]) {
  test(`search rejects boundary override or unauthorized predicate ${JSON.stringify(filter)}`, async () => {
    const { broker, calls } = fixture()
    await reject(() => broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: { filterGroups: [{ filters: [filter] }] } }), 400)
    assert.equal(calls.filter(call => call.url.pathname === `${TICKETS}/search`).length, 0)
  })
}

test('search counts only fresh in-scope records and applies scoped numeric paging', async () => {
  const indexRows = [record('1'), record('2'), record('3')]
  const { broker } = fixture({ rows: [record('1'), record('2', { sm_brand: 'moved-away' }), record('3')],
    searchPages: [{ total: 3000, results: indexRows }] })
  const response = await broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: { properties: ['subject'], limit: 1, after: '1' } })
  assert.equal(response.body.total, 2)
  assert.deepEqual(response.body.results.map(row => row.id), ['3'])
  assert.equal(response.body.paging, undefined)
})

test('search follows bounded upstream paging internally without returning foreign cursors or metadata', async () => {
  const { broker } = fixture({ rows: [record('1'), record('2')], searchPages: [
    { total: 9999, results: [record('1')], paging: { next: { after: '1', link: 'https://evil.example/MUST_NOT_LEAK' } } },
    { total: 9999, results: [record('2')] },
  ] })
  const response = await broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: { limit: 100 } })
  assert.equal(response.body.total, 2)
  assert.deepEqual(response.body.results.map(row => row.id), ['1', '2'])
  assert.ok(!JSON.stringify(response).includes('evil.example'))
})

test('bounded searches and repeated cursors fail closed instead of returning partial results', async () => {
  const bounded = fixture({ rows: [record('1'), record('2'), record('3')], settings: { BROKER_MAX_SEARCH_RECORDS: '2' } })
  await reject(() => bounded.broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: {} }), 503, 'QUERY_BOUND_EXCEEDED')
  const repeated = fixture({ searchPages: [
    { results: [record('1')], paging: { next: { after: '1' } } },
    { results: [record('2')], paging: { next: { after: '1' } } },
  ] })
  await reject(() => repeated.broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: {} }), 502, 'UPSTREAM_INVALID_RESPONSE')
})

test('archived collection filters inside broker, fills scoped pages and strips upstream paging links', async () => {
  const own1 = record('1', {}, { archived: true })
  const own2 = record('2', {}, { archived: true })
  const foreign = record('999', { sm_brand: 'foreign' }, { archived: true })
  const { broker, calls } = fixture({ rows: [own1, own2, foreign], archivePages: [
    { results: [foreign], paging: { next: { after: '1', link: 'https://evil.example/MUST_NOT_LEAK' } } },
    { results: [own1, own2] },
  ] })
  const response = await broker.handle({ method: 'GET', url: `${TICKETS}?archived=true&limit=1&properties=subject` })
  assert.deepEqual(response.body.results.map(row => row.id), ['1'])
  assert.deepEqual(response.body.paging, { next: { after: '1' } })
  assert.ok(!JSON.stringify(response).includes('999'))
  assert.ok(!JSON.stringify(response).includes('MUST_NOT_LEAK'))
  for (const call of calls.filter(call => call.url.pathname === TICKETS)) {
    assert.deepEqual(call.url.searchParams.get('properties').split(','), ['hs_pipeline', 'sm_brand'])
  }
  assert.ok(!calls.some(call => call.url.pathname === `${TICKETS}/999`))
})

test('archived scan suppresses candidates moved out of scope before full read and fails at the bound', async () => {
  const archived = record('1', {}, { archived: true })
  const { broker } = fixture({ rows: [record('1', { sm_brand: 'moved' }, { archived: true })], archivePages: [{ results: [archived] }] })
  assert.deepEqual((await broker.handle({ method: 'GET', url: `${TICKETS}?archived=true` })).body.results, [])
  const bounded = fixture({ rows: [archived, record('2', {}, { archived: true })], settings: { BROKER_MAX_SEARCH_RECORDS: '1' } })
  await reject(() => bounded.broker.handle({ method: 'GET', url: `${TICKETS}?archived=true` }), 503, 'QUERY_BOUND_EXCEEDED')
})

test('all writes are disabled by default and perform no upstream mutation', async () => {
  const { broker, calls } = fixture()
  for (const [method, url, body] of [
    ['POST', TICKETS, createBody()], ['PATCH', `${TICKETS}/1`, { properties: { sm_summary: 'changed' } }],
    ['DELETE', `${TICKETS}/1`, undefined],
  ]) await reject(() => broker.handle({ method, url, body }), 403, 'WRITES_DISABLED')
  assert.ok(calls.every(call => call.method === 'GET'))
})

for (const forbidden of [
  { hs_pipeline: '21' }, { sm_brand: 'foreign' }, { sm_requester: 'other@example.test' },
  { sm_conversation: 'changed-conversation' }, { subject: 'changed issue' }, { content: 'changed issue' },
  { hubspot_owner_id: '999' }, { hs_pipeline_stage: '999' }, { private_other_brand_notes: 'changed' },
]) {
  test(`PATCH denies unauthorized field or stage ${JSON.stringify(forbidden)}`, async () => {
    const { broker, calls } = fixture({ settings: writes })
    await reject(() => broker.handle({ method: 'PATCH', url: `${TICKETS}/1`, body: { properties: forbidden } }), 400)
    assert.ok(!calls.some(call => call.method === 'PATCH'))
  })
}

test('foreign and archived tickets cannot be updated or archived again', async () => {
  for (const row of [record('1', { sm_brand: 'foreign' }), record('1', {}, { archived: true })]) {
    const { broker, calls } = fixture({ rows: [row], settings: writes })
    await reject(() => broker.handle({ method: 'PATCH', url: `${TICKETS}/1`, body: { properties: { sm_summary: 'no' } } }), 404)
    await reject(() => broker.handle({ method: 'DELETE', url: `${TICKETS}/1` }), 404)
    assert.ok(calls.every(call => call.method === 'GET'))
  }
})

test('approved summary/stage update is read back and no other ticket fields change', async () => {
  const { broker, calls, state } = fixture({ settings: writes })
  const response = await broker.handle({ method: 'PATCH', url: `${TICKETS}/1`, body: { properties: { sm_summary: 'Resolved safely', hs_pipeline_stage: '103' } } })
  assert.equal(response.status, 200)
  assert.equal(response.body.properties.sm_summary, 'Resolved safely')
  assert.equal(response.body.properties.hs_pipeline_stage, '103')
  assert.equal(state.get('1').properties.content, 'Synthetic issue')
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1)
  assert.equal(response.body.associations, undefined)
})

test('PATCH uncertainty or failed readback never reports success or retries mutation', async () => {
  const { broker, calls } = fixture({ settings: writes,
    hook: call => call.method === 'PATCH' ? json({ private: 'MUST_NOT_LEAK' }) : undefined })
  await reject(() => broker.handle({ method: 'PATCH', url: `${TICKETS}/1`, body: { properties: { sm_summary: 'not committed' } } }), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1)
})

test('archive returns 204 only after scoped archived readback, never exposes permanent delete', async () => {
  const { broker, calls } = fixture({ settings: writes })
  assert.deepEqual(await broker.handle({ method: 'DELETE', url: `${TICKETS}/1` }), { status: 204 })
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1)
  assert.ok(calls.some(call => call.url.pathname === `${TICKETS}/1` && call.url.searchParams.get('archived') === 'true'))
})

test('archive without verified archived readback is uncertain and is not retried', async () => {
  const { broker, calls } = fixture({ settings: writes,
    hook: call => call.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined })
  await reject(() => broker.handle({ method: 'DELETE', url: `${TICKETS}/1` }), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1)
})

test('ticket create privately ensures requester contact and forces initial ownership/stage', async () => {
  const { broker, calls } = fixture({ rows: [], settings: writes, contactMissing: true })
  const response = await broker.handle({ method: 'POST', url: TICKETS, body: createBody() })
  assert.equal(response.status, 201)
  assert.equal(response.body.id, '500')
  assert.deepEqual(response.body.broker, { requesterAssociated: true, emailDelivery: 'not_verified' })
  assert.equal(response.body.associations, undefined)
  const outbound = calls.find(call => call.url.pathname === TICKETS && call.method === 'POST')
  assert.equal(outbound.body.properties.hs_pipeline, '20')
  assert.equal(outbound.body.properties.sm_brand, 'springmath')
  assert.equal(outbound.body.properties.hs_pipeline_stage, '100')
  assert.deepEqual(outbound.body.associations, [{ to: { id: '900' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }] }])
  const contactCreate = calls.find(call => call.url.pathname === CONTACTS && call.method === 'POST')
  assert.deepEqual(contactCreate.body, { properties: { email: EMAIL } })
  assert.ok(!JSON.stringify(response).includes('900'))
})

test('existing contact is reused without profile update and uppercase requester is normalized', async () => {
  const { broker, calls } = fixture({ rows: [], settings: writes })
  const body = createBody()
  body.properties.sm_requester = EMAIL.toUpperCase()
  await broker.handle({ method: 'POST', url: TICKETS, body })
  assert.ok(!calls.some(call => call.url.pathname === CONTACTS && call.method === 'POST'))
  assert.ok(!calls.some(call => call.url.pathname.startsWith(CONTACTS) && call.method === 'PATCH'))
  assert.equal(calls.find(call => call.url.pathname === TICKETS && call.method === 'POST').body.properties.sm_requester, EMAIL)
})

for (const alteration of [
  body => { body.associations = [{ to: { id: 'OTHER_BRAND' } }] },
  body => { body.properties.hs_pipeline = '21' }, body => { body.properties.sm_brand = 'foreign' },
  body => { body.properties.hs_pipeline_stage = '101' }, body => { body.properties.hubspot_owner_id = '999' },
  body => { body.properties.sm_requester = 'invalid email' }, body => { body.properties.sm_conversation = '../escape' },
]) {
  test(`ticket creation rejects ownership, association, field or identity override: ${alteration}`, async () => {
    const { broker, calls } = fixture({ rows: [], settings: writes })
    const body = createBody()
    alteration(body)
    await reject(() => broker.handle({ method: 'POST', url: TICKETS, body }), 400)
    assert.ok(!calls.some(call => call.method === 'POST'))
  })
}

test('repeat external ID refuses to create another ticket or claim a previous write is new', async () => {
  const { broker, calls } = fixture({ settings: writes })
  await reject(() => broker.handle({ method: 'POST', url: TICKETS, body: createBody() }), 409, 'CONFLICT_RECONCILE_FIRST')
  assert.ok(!calls.some(call => call.method === 'POST'))
})

test('contact identity failure prevents ticket POST', async () => {
  const { broker, calls } = fixture({ rows: [], settings: writes, hook: call => call.url.pathname.startsWith(`${CONTACTS}/`)
    ? json({ id: '900', archived: false, properties: { email: 'foreign@example.test' } }) : undefined })
  await reject(() => broker.handle({ method: 'POST', url: TICKETS, body: createBody() }), 502, 'REQUESTER_ASSOCIATION_UNVERIFIED')
  assert.ok(!calls.some(call => call.url.pathname === TICKETS && call.method === 'POST'))
})

test('uncertain ticket-create transport and missing association readback are never retried', async () => {
  const transport = fixture({ rows: [], settings: writes, hook: call => {
    if (call.url.pathname === TICKETS && call.method === 'POST') throw new Error('MUST_NOT_LEAK')
  } })
  await reject(() => transport.broker.handle({ method: 'POST', url: TICKETS, body: createBody() }), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(transport.calls.filter(call => call.url.pathname === TICKETS && call.method === 'POST').length, 1)
  const association = fixture({ rows: [], settings: writes, hook: (call, { state }) => {
    if (call.url.pathname === `${TICKETS}/500`) return json({ ...state.get('500'), associations: { contacts: { results: [] } } })
  } })
  await reject(() => association.broker.handle({ method: 'POST', url: TICKETS, body: createBody() }), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(association.calls.filter(call => call.url.pathname === TICKETS && call.method === 'POST').length, 1)
})

test('failed contact POST gets one exact reconciliation read, not another POST', async () => {
  let lookup = 0
  const { broker, calls } = fixture({ rows: [], settings: writes, hook: call => {
    if (call.url.pathname.startsWith(`${CONTACTS}/`)) {
      lookup += 1
      if (lookup === 1) return json({}, 404)
    }
    if (call.url.pathname === CONTACTS && call.method === 'POST') return json({ private: 'MUST_NOT_LEAK' }, 409)
  } })
  assert.equal((await broker.handle({ method: 'POST', url: TICKETS, body: createBody() })).status, 201)
  assert.equal(calls.filter(call => call.url.pathname === CONTACTS && call.method === 'POST').length, 1)
  assert.equal(lookup, 2)
})

for (const [upstreamStatus, expectedStatus, expectedCode] of [
  [301, 502, 'UPSTREAM_UNAVAILABLE'], [403, 503, 'UPSTREAM_NOT_READY'],
  [429, 503, 'UPSTREAM_BUSY'], [500, 502, 'UPSTREAM_UNAVAILABLE'],
]) {
  test(`upstream ${upstreamStatus} is sanitized without forwarding vendor error data`, async () => {
    const { broker, calls } = fixture({ hook: () => json({ message: 'MUST_NOT_LEAK', email: 'foreign@example.test' }, upstreamStatus) })
    await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}/1` }), expectedStatus, expectedCode)
    assert.equal(calls.length, 1)
  })
}

test('upstream malformed or oversized JSON fails closed', async () => {
  const malformed = fixture({ hook: () => new Response('not JSON: MUST_NOT_LEAK') })
  await reject(() => malformed.broker.ready(), 502, 'UPSTREAM_INVALID_RESPONSE')
  const oversized = fixture({ hook: () => json({ value: 'x'.repeat(2097153) }) })
  await reject(() => oversized.broker.ready(), 502, 'UPSTREAM_INVALID_RESPONSE')
})

for (const filterGroups of [null, '', false, 1, {}, [null], [{ filters: null }]]) {
  test(`malformed filterGroups ${JSON.stringify(filterGroups)} is controlled 400, never broadened search`, async () => {
    const { broker, calls } = fixture()
    await reject(() => broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: { filterGroups } }), 400, 'INVALID_REQUEST')
    assert.ok(!calls.some(call => call.url.pathname === `${TICKETS}/search`))
  })
}

test('escalated count excludes fresh stage changes even when the search index still matches', async () => {
  const { broker, calls } = fixture({ rows: [record('1', { hs_pipeline_stage: '103' }), record('2', { hs_pipeline_stage: '101' })],
    searchPages: [{ total: 2, results: [record('1', { hs_pipeline_stage: '101' }), record('2', { hs_pipeline_stage: '101' })] }] })
  const response = await broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: {
    filterGroups: [{ filters: [{ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: '101' }] }],
    properties: ['subject'], limit: 1,
  } })
  assert.equal(response.body.total, 1)
  assert.deepEqual(response.body.results.map(row => row.id), ['2'])
  assert.equal(response.body.results[0].properties.hs_pipeline_stage, undefined, 'predicate fields stay private unless requested')
  assert.ok(calls.find(call => call.url.pathname === `${TICKETS}/batch/read`).body.properties.includes('hs_pipeline_stage'))
})

test('IN stage predicates and sort order are applied to fresh projected rows', async () => {
  const { broker } = fixture({ rows: [record('1', { subject: 'Zulu', hs_pipeline_stage: '101' }),
    record('2', { subject: 'Alpha', hs_pipeline_stage: '102' }), record('3', { hs_pipeline_stage: '103' })] })
  const response = await broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: {
    filterGroups: [{ filters: [{ propertyName: 'hs_pipeline_stage', operator: 'IN', values: ['101', '102'] }] }],
    properties: ['subject'], sorts: ['subject'],
  } })
  assert.equal(response.body.total, 2)
  assert.deepEqual(response.body.results.map(row => row.id), ['2', '1'])
})

test('search rejects numeric-coerced IDs, duplicate IDs and oversized vendor pages', async () => {
  for (const results of [[record(1)], [record('1'), record('1')],
    Array.from({ length: 101 }, (_, i) => record(String(i + 1)))]) {
    const { broker } = fixture({ searchPages: [{ results }] })
    await reject(() => broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: {} }), 502, 'UPSTREAM_INVALID_RESPONSE')
  }
})

test('fresh batch rejects duplicate, missing, unexpected and partial-error result sets', async () => {
  for (const data of [
    { results: [record('1'), record('1')] }, { results: [record('1')] },
    { results: [record('1'), record('99')] },
    { results: [record('1'), record('2')], errors: [{ message: 'MUST_NOT_LEAK' }] },
  ]) {
    const { broker } = fixture({ rows: [record('1'), record('2')],
      hook: call => call.url.pathname === `${TICKETS}/batch/read` ? json(data) : undefined })
    await reject(() => broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: {} }), 502, 'UPSTREAM_INVALID_RESPONSE')
  }
})

test('exact read rejects numeric-coerced ticket ID even when ownership fields match', async () => {
  const { broker } = fixture({ hook: call => call.url.pathname === `${TICKETS}/1` ? json(record(1)) : undefined })
  await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}/1` }), 404, 'NOT_FOUND')
})

test('malformed and duplicate pipeline stages fail before any write', async () => {
  for (const [stages, status] of [[null, 502], [[null], 502],
    [[...pipeline().stages, pipeline().stages[0]], 503]]) {
    const { broker, calls } = fixture({ rows: [], settings: writes,
      hook: call => call.url.pathname === PIPELINE ? json({ ...pipeline(), stages }) : undefined })
    await reject(() => broker.handle({ method: 'POST', url: TICKETS, body: createBody() }), status)
    assert.ok(!calls.some(call => call.method === 'POST'))
  }
})

test('new-ticket stage must be OPEN and configured closed stage must be CLOSED', async () => {
  for (const [index, state] of [[0, 'CLOSED'], [3, 'OPEN']]) {
    const data = pipeline()
    data.stages[index].metadata.ticketState = state
    const { broker, calls } = fixture({ rows: [], settings: writes,
      hook: call => call.url.pathname === PIPELINE ? json(data) : undefined })
    await reject(() => broker.handle({ method: 'POST', url: TICKETS, body: createBody() }), 503, 'STAGE_CONFIGURATION_INVALID')
    assert.ok(!calls.some(call => call.method === 'POST'))
  }
})

test('ticket creation requires verified unique external-ID property before touching contacts or tickets', async () => {
  for (const metadata of [
    { name: 'sm_conversation', type: 'string', hasUniqueValue: false },
    { name: 'wrong_property', type: 'string', hasUniqueValue: true },
    { name: 'sm_conversation', type: 'number', hasUniqueValue: true },
  ]) {
    const { broker, calls } = fixture({ rows: [], settings: writes,
      hook: call => call.url.pathname === '/crm/v3/properties/tickets/sm_conversation' ? json(metadata) : undefined })
    await reject(() => broker.handle({ method: 'POST', url: TICKETS, body: createBody() }), 503, 'UNIQUE_EXTERNAL_ID_REQUIRED')
    assert.ok(!calls.some(call => call.url.pathname.startsWith(CONTACTS) || call.method === 'POST'))
  }
})

test('HTTP 200 null is not a valid DELETE 204 acknowledgement even if the record is archived', async () => {
  const { broker, calls } = fixture({ settings: writes, hook: (call, { state }) => {
    if (call.method === 'DELETE') {
      state.get('1').archived = true
      return json(null, 200)
    }
  } })
  await reject(() => broker.handle({ method: 'DELETE', url: `${TICKETS}/1` }), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1)
})

test('ticket create requires HTTP 201 and treats another success code as uncertain', async () => {
  const { broker, calls } = fixture({ rows: [], settings: writes,
    hook: call => call.url.pathname === TICKETS && call.method === 'POST' ? json(record('500'), 200) : undefined })
  await reject(() => broker.handle({ method: 'POST', url: TICKETS, body: createBody() }), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(calls.filter(call => call.url.pathname === TICKETS && call.method === 'POST').length, 1)
})

test('cumulative upstream-transfer budget stops individually bounded pages and resets for the next operation', async () => {
  // The vendor extension is deliberately never retained as ticket data. Each
  // response is below 2 MiB, while their aggregate exceeds the 8 MiB operation cap.
  const pages = Array.from({ length: 6 }, (_, index) => ({
    results: [{ id: String(index + 1) }],
    vendorExtension: 'x'.repeat(1500 * 1024),
    ...(index < 5 ? { paging: { next: { after: String(index + 1) } } } : {}),
  }))
  assert.ok(pages.every(page => Buffer.byteLength(JSON.stringify(page)) < 2097152))
  const { broker, calls } = fixture({ searchPages: pages })
  await reject(() => broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: { properties: ['subject'] } }), 503, 'QUERY_BOUND_EXCEEDED')
  assert.equal(calls.filter(call => call.url.pathname === `${TICKETS}/batch/read`).length, 0,
    'budget is enforced during transfer, not after all candidates were retained')
  assert.equal(calls.filter(call => call.url.pathname === `${TICKETS}/search`).length, 6)
  assert.deepEqual(await broker.handle({ method: 'GET', url: ACCOUNT }), { status: 200, body: { portalId: 123 } },
    'a failed request must not consume the next operation budget')
})

test('search fails closed at retained-data budget even when upstream responses and transfers are individually safe', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => record(String(i + 1), { content: 'x'.repeat(18000) }))
  const pages = [0, 1, 2].map(page => ({
    results: rows.slice(page * 100, (page + 1) * 100).map(row => ({ id: row.id })),
    ...(page < 2 ? { paging: { next: { after: String(page + 1) } } } : {}),
  }))
  assert.ok(Buffer.byteLength(JSON.stringify({ results: rows.slice(0, 100) })) < 2097152)
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 8388608)
  const { broker, calls } = fixture({ rows, searchPages: pages })
  await reject(() => broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: { properties: ['content'], limit: 1 } }), 503, 'QUERY_BOUND_EXCEEDED')
  assert.equal(calls.filter(call => call.url.pathname === `${TICKETS}/batch/read`).length, 3)
})

test('archive retention is bounded before partial pages can be returned', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => record(String(i + 1), { content: 'x'.repeat(100000) }, { archived: true }))
  const metadata = rows.map(row => ({ id: row.id, archived: true, properties: { hs_pipeline: '20', sm_brand: 'springmath' } }))
  const { broker, calls } = fixture({ rows, archivePages: [{ results: metadata }] })
  await reject(() => broker.handle({ method: 'GET', url: `${TICKETS}?archived=true&properties=content&limit=1` }), 503, 'QUERY_BOUND_EXCEEDED')
  const contentReads = calls.filter(call => call.url.pathname.startsWith(`${TICKETS}/`))
  assert.ok(contentReads.length > 1 && contentReads.length < 50, 'stop before retaining or reading the full oversized archive')
})

for (const path of [`${TICKETS}/search`, `${TICKETS}/batch/read`]) {
  test(`read-only POST timeout on ${path} reports unavailable, not an unknown write`, async () => {
    const { broker, calls } = fixture({ hook: call => {
      if (call.url.pathname === path) throw new DOMException('MUST_NOT_LEAK', 'TimeoutError')
    } })
    await reject(() => broker.handle({ method: 'POST', url: `${TICKETS}/search`, body: {} }), 502, 'UPSTREAM_UNAVAILABLE')
    assert.equal(calls.filter(call => call.url.pathname === path).length, 1)
  })
}

for (const [method, url, body, responseStatus] of [
  ['POST', TICKETS, createBody(), 201],
  ['PATCH', `${TICKETS}/1`, { properties: { sm_summary: 'Synthetic replacement' } }, 200],
]) {
  test(`successful ${method} with malformed JSON reports unknown write and is never retried`, async () => {
    const { broker, calls } = fixture({ rows: method === 'POST' ? [] : [record()], settings: writes,
      hook: call => call.method === method && call.url.pathname === url
        ? new Response('MUST_NOT_LEAK: malformed success', { status: responseStatus }) : undefined })
    await reject(() => broker.handle({ method, url, body }), 502, 'WRITE_OUTCOME_UNKNOWN')
    assert.equal(calls.filter(call => call.method === method && call.url.pathname === url).length, 1)
  })
}

test('post-write readback transport failure reports unknown outcome, never a definite rejection', async () => {
  let written = false
  const { broker, calls } = fixture({ settings: writes, hook: call => {
    if (call.method === 'PATCH') written = true
    else if (written && call.url.pathname === `${TICKETS}/1`) throw new Error('MUST_NOT_LEAK')
  } })
  await reject(() => broker.handle({ method: 'PATCH', url: `${TICKETS}/1`, body: { properties: { sm_summary: 'Synthetic replacement' } } }), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1)
})
