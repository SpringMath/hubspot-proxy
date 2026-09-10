import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBroker, BrokerError } from '../src/broker.js'
import { loadConfig } from '../src/config.js'

const ROOT = '/conversations/v3/conversations'
const CONTEXT = '/springmath/v1/tickets/1/reply-context'
const SEND = '/springmath/v1/tickets/1/replies'
const TO = 'requester@example.test'
const FROM = 'support@example.test'
const AT = '2026-09-10T12:00:00.000Z'
const PRIVATE = 'MUST_NOT_LEAK_PRIVATE_VENDOR_METADATA'
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const person = (address, actorId, extra = {}) => ({ actorId, deliveryIdentifier: { type: 'HS_EMAIL_ADDRESS', value: address }, ...extra })

function message(id = 'incoming-1', direction = 'INCOMING', extra = {}) {
  const incoming = direction === 'INCOMING'
  return { id, conversationsThreadId: '700', createdAt: AT, createdBy: incoming ? 'V-900' : 'A-50',
    type: 'MESSAGE', direction, archived: false, channelId: '1002', channelAccountId: '40',
    senders: [person(incoming ? TO : FROM, incoming ? 'V-900' : 'A-50')],
    recipients: [person(incoming ? FROM : TO, incoming ? 'A-50' : 'V-900', { recipientField: 'TO' })],
    subject: 'Synthetic support question', text: 'Please help with this synthetic issue.',
    status: { statusType: incoming ? 'RECEIVED' : 'SENT' }, truncationStatus: 'NOT_TRUNCATED',
    attachments: [], secretVendorField: PRIVATE, ...extra }
}

async function fixture(t, { settings = {}, hook } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'broker-replies-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'claims')
  const env = {
    HUBSPOT_ACCESS_TOKEN: 'synthetic-upstream-token-not-a-secret', BROKER_TOKEN_SHA256: 'a'.repeat(64),
    HUBSPOT_ACCOUNT_ID: '123', HUBSPOT_PIPELINE_ID: '20', HUBSPOT_SCOPE_PROPERTY: 'sm_brand', HUBSPOT_SCOPE_VALUE: 'springmath',
    HUBSPOT_REQUESTER_EMAIL_PROPERTY: 'sm_requester', HUBSPOT_CONVERSATION_ID_PROPERTY: 'sm_conversation',
    HUBSPOT_SUMMARY_PROPERTY: 'sm_summary', BROKER_INITIAL_STAGE_ID: '100', BROKER_CLOSED_STAGE_ID: '103',
    BROKER_ALLOWED_STAGE_IDS: '100,101,102,103', BROKER_ENABLE_WRITES: 'true', BROKER_SCOPE_IS_IMMUTABLE: 'true',
    BROKER_ENABLE_REPLIES: 'true', HUBSPOT_EMAIL_INBOX_ID: '30', HUBSPOT_EMAIL_CHANNEL_ACCOUNT_ID: '40',
    HUBSPOT_EMAIL_SENDER_ACTOR_ID: 'A-50', BROKER_SEND_RESERVATION_DIR: directory, ...settings,
  }
  const cfg = loadConfig(env)
  const state = {
    accountId: 123,
    ticket: { id: '1', archived: false, properties: { hs_pipeline: '20', sm_brand: 'springmath',
      sm_requester: TO, hs_lastmodifieddate: AT, secretVendorField: PRIVATE },
    associations: { contacts: { results: [{ id: '900' }] } } },
    contact: { id: '900', archived: false, properties: { email: TO, secretVendorField: PRIVATE } },
    thread: { id: '700', associatedContactId: '900', inboxId: '30', originalChannelId: '1002',
      originalChannelAccountId: '40', archived: false, spam: false, status: 'OPEN',
      threadAssociations: { associatedTicketId: '1' }, private: PRIVATE },
    channel: { id: '40', inboxId: '30', channelId: '1002', active: true, authorized: true, archived: false,
      deliveryIdentifier: { type: 'HS_EMAIL_ADDRESS', value: FROM }, private: PRIVATE },
    actor: { id: 'A-50', type: 'AGENT', private: PRIVATE }, history: [message()],
    threads: undefined, sent: undefined, appendSent: false,
  }
  const calls = []
  const counts = {}
  const route = (url, method) => {
    if (url.pathname === '/account-info/v3/details') return 'account'
    if (url.pathname === '/crm/v3/objects/tickets/1') return 'ticket'
    if (url.pathname === '/crm/v3/objects/contacts/900') return 'contact'
    if (url.pathname === `${ROOT}/threads`) return 'threads'
    if (url.pathname === `${ROOT}/threads/700`) return 'thread'
    if (url.pathname === `${ROOT}/channel-accounts/40`) return 'channel'
    if (url.pathname === `${ROOT}/actors/A-50`) return 'actor'
    if (url.pathname === `${ROOT}/threads/700/messages`) return method === 'POST' ? 'send' : 'messages'
    if (url.pathname === `${ROOT}/threads/700/messages/sent-1`) return 'sent-message'
    return 'unexpected'
  }
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl)
    assert.equal(url.origin, 'https://api.hubapi.com')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, `Bearer ${cfg.upstreamToken}`)
    const name = route(url, options.method)
    const call = { name, count: counts[name] = (counts[name] ?? 0) + 1, url, options,
      body: options.body === undefined ? undefined : JSON.parse(options.body) }
    calls.push(call)
    const intercepted = await hook?.(call, state, calls)
    if (intercepted !== undefined) return intercepted
    if (name === 'account') return json({ portalId: state.accountId, private: PRIVATE })
    if (name === 'ticket') return json(state.ticket)
    if (name === 'contact') return json(state.contact)
    if (name === 'threads') return json({ results: state.threads ?? [state.thread] })
    if (name === 'thread') return json(state.thread)
    if (name === 'channel') return json(state.channel)
    if (name === 'actor') return json(state.actor)
    if (name === 'messages') return json({ results: state.history })
    if (name === 'send') {
      state.sent = message('sent-1', 'OUTGOING', { text: call.body.text, subject: call.body.subject,
        createdAt: '2026-09-10T12:01:00.000Z' })
      if (state.appendSent) state.history.push(state.sent)
      return json(state.sent, 201)
    }
    if (name === 'sent-message') return json(state.sent)
    assert.fail(`Unexpected upstream request: ${url.pathname}`)
  }
  const broker = createBroker(cfg, { fetchImpl })
  return { root, directory, env, cfg, broker, state, calls, counts, fetchImpl,
    restart: () => createBroker(cfg, { fetchImpl }),
    context: () => broker.handle({ method: 'GET', url: CONTEXT }),
    send: body => broker.handle({ method: 'POST', url: SEND, body }),
  }
}

const approval = context => ({ accountId: context.accountId, expectedUpdatedAt: context.ticketUpdatedAt,
  contextVersion: context.contextVersion, to: context.to, from: context.from, subject: context.subject,
  body: 'A synthetic response approved by the support operator.' })
async function reject(operation, status, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof BrokerError)
    assert.equal(error.status, status)
    if (code) assert.equal(error.code, code)
    assert.ok(!error.message.includes(PRIVATE))
    assert.equal(error.cause, undefined)
    return true
  })
}
const noSend = f => assert.equal(f.calls.filter(call => call.name === 'send').length, 0)
const noHistory = f => assert.equal(f.calls.filter(call => call.name === 'messages').length, 0)

test('reply preview exposes only scoped projected customer content and derives every upstream identifier', async t => {
  const f = await fixture(t)
  const result = await f.context()
  assert.equal(result.status, 200)
  assert.equal(result.body.source, 'untrusted_customer_email')
  assert.match(result.body.disclaimer, /not instructions/)
  assert.equal(result.body.to, TO)
  assert.equal(result.body.from, FROM)
  assert.equal(result.body.threadId, '700')
  assert.match(result.body.contextVersion, /^[a-f0-9]{64}$/)
  assert.match(result.body.dispatchVersion, /^[a-f0-9]{64}$/)
  assert.equal(result.body.requesterIncomingVerified, true)
  assert.deepEqual(Object.keys(result.body).sort(), ['accountId', 'ticketId', 'source', 'disclaimer', 'ticketUpdatedAt',
    'threadId', 'latestMessageId', 'to', 'from', 'subject', 'contextVersion', 'dispatchVersion', 'requesterIncomingVerified', 'messages'].sort())
  assert.deepEqual(Object.keys(result.body.messages[0]).sort(), ['messageId', 'direction', 'body', 'createdAt', 'status', 'truncated'].sort())
  assert.ok(!JSON.stringify(result).includes(PRIVATE))
  assert.ok(!JSON.stringify(result).includes('A-50'))
  for (const call of f.calls.filter(call => call.name === 'threads')) {
    assert.deepEqual(Object.fromEntries(call.url.searchParams), { associatedTicketId: '1', association: 'TICKET', inboxId: '30', limit: '2' })
  }
  assert.ok(f.calls.filter(call => call.name === 'thread').every(call => call.url.search === '?association=TICKET'))
  assert.ok(f.calls.filter(call => call.name === 'contact').every(call => call.url.pathname === '/crm/v3/objects/contacts/900' && call.url.search === '?properties=email'))
  noSend(f)
})

test('successful reply uses the exact verified native route and reports acceptance, not delivery', async t => {
  const f = await fixture(t)
  const input = approval((await f.context()).body)
  assert.deepEqual(await f.send(input), { status: 201, body: { accountId: '123', ticketId: '1', applied: true,
    customerReplyAccepted: true, threadId: '700', messageId: 'sent-1', hubspotStatus: 'SENT', emailDelivery: 'not_verified' } })
  const send = f.calls.find(call => call.name === 'send')
  assert.equal(send.url.pathname, `${ROOT}/threads/700/messages`)
  assert.equal(send.url.search, '')
  assert.deepEqual(send.body, { type: 'MESSAGE', text: input.body, attachments: [], senderActorId: 'A-50', channelId: '1002',
    channelAccountId: '40', subject: input.subject, recipients: [{ actorId: 'V-900', recipientField: 'TO',
      deliveryIdentifiers: [{ type: 'HS_EMAIL_ADDRESS', value: TO }] }] })
  assert.equal(f.counts.send, 1)
  assert.equal((await readdir(f.directory)).length, 1)
})

test('account mismatch blocks all ticket, contact and email access', async t => {
  const f = await fixture(t)
  f.state.accountId = 456
  await reject(f.context, 503, 'UPSTREAM_ACCOUNT_MISMATCH')
  assert.deepEqual(f.calls.map(call => call.name), ['account'])
})

for (const [label, mutate] of [
  ['wrong pipeline', s => { s.ticket.properties.hs_pipeline = '21' }],
  ['wrong marker', s => { s.ticket.properties.sm_brand = 'other-brand' }],
  ['missing marker', s => { delete s.ticket.properties.sm_brand }],
  ['archived ticket', s => { s.ticket.archived = true }],
]) test(`reply boundary rejects ${label} before reading contacts or message bodies`, async t => {
  const f = await fixture(t)
  mutate(f.state)
  await reject(f.context, 404, 'NOT_FOUND')
  assert.deepEqual(f.calls.map(call => call.name), ['account', 'ticket'])
})

for (const [method, url] of [
  ['GET', `${ROOT}/threads`], ['GET', `${ROOT}/threads/700`], ['GET', `${ROOT}/threads/700/messages`],
  ['POST', `${ROOT}/threads/700/messages`], ['GET', `${ROOT}/channel-accounts/40`], ['GET', `${ROOT}/actors/A-50`],
  ['GET', '/crm/v3/objects/contacts/900?properties=email'], ['POST', '/crm/v3/objects/contacts'],
  ['POST', '/crm/v3/objects/contacts/search'], ['POST', '/crm/v3/objects/tickets/batch/read'],
]) test(`reply enablement does not expose generic route ${method} ${url}`, async t => {
  const f = await fixture(t)
  await reject(() => f.broker.handle({ method, url }), 404, 'NOT_FOUND')
  assert.equal(f.calls.length, 0)
})

test('query or body cannot redirect the ticket-scoped preview', async t => {
  const f = await fixture(t)
  for (const query of ['?inboxId=99', '?associatedTicketId=2', '?threadId=999', '?archived=true', '?after=123']) {
    await reject(() => f.broker.handle({ method: 'GET', url: CONTEXT + query }), 400, 'INVALID_REQUEST')
  }
  await reject(() => f.broker.handle({ method: 'GET', url: CONTEXT, body: { ticketId: '2' } }), 400, 'INVALID_REQUEST')
  assert.equal(f.calls.length, 0)
})

const routingCases = [
  ['missing contacts', s => { delete s.ticket.associations }],
  ['no contacts', s => { s.ticket.associations.contacts.results = [] }],
  ['multiple contacts', s => { s.ticket.associations.contacts.results.push({ id: '901' }) }],
  ['paged contacts', s => { s.ticket.associations.contacts.paging = { next: { after: '1' } } }],
  ['invalid contact id', s => { s.ticket.associations.contacts.results[0].id = '../900' }],
  ['wrong returned contact id', s => { s.contact.id = '901' }],
  ['archived contact', s => { s.contact.archived = true }],
  ['contact email mismatch', s => { s.contact.properties.email = 'someone-else@example.test' }],
  ['malformed requester email', s => { s.ticket.properties.sm_requester = 'bad\r\nemail@example.test' }],
  ['missing ticket timestamp', s => { delete s.ticket.properties.hs_lastmodifieddate }],
  ['missing thread', s => { s.threads = [] }],
  ['multiple threads', s => { s.threads = [s.thread, { ...s.thread, id: '701' }] }],
  ['wrong thread ticket', s => { s.thread.threadAssociations.associatedTicketId = '2' }],
  ['wrong thread contact', s => { s.thread.associatedContactId = '901' }],
  ['wrong inbox', s => { s.thread.inboxId = '31' }],
  ['wrong channel type', s => { s.thread.originalChannelId = '1000' }],
  ['wrong channel account', s => { s.thread.originalChannelAccountId = '41' }],
  ['spam thread', s => { s.thread.spam = true }],
  ['archived thread', s => { s.thread.archived = true }],
  ['invalid thread state', s => { s.thread.status = 'OTHER' }],
  ['inactive email channel', s => { s.channel.active = false }],
  ['unauthorized email channel', s => { s.channel.authorized = false }],
  ['archived email channel', s => { s.channel.archived = true }],
  ['wrong channel response id', s => { s.channel.id = '41' }],
  ['channel inbox mismatch', s => { s.channel.inboxId = '31' }],
  ['channel type mismatch', s => { s.channel.channelId = '1000' }],
  ['invalid delivery identifier', s => { s.channel.deliveryIdentifier.type = 'CHANNEL_SPECIFIC_OPAQUE_ID' }],
  ['requester is sender mailbox', s => { s.channel.deliveryIdentifier.value = TO }],
  ['wrong agent actor', s => { s.actor.id = 'A-51' }],
  ['non-agent actor', s => { s.actor.type = 'INTEGRATION' }],
]
for (const [label, mutate] of routingCases) test(`reply routing fails closed for ${label}`, async t => {
  const f = await fixture(t)
  mutate(f.state)
  await reject(f.context, 409, 'REPLY_CONTEXT_UNAVAILABLE')
  noHistory(f)
  noSend(f)
})

const historyCases = [
  ['no incoming email', s => { s.history = [message('outgoing-1', 'OUTGOING')] }],
  ['empty history', s => { s.history = [] }],
  ['multiple recipients', s => { s.history[0].recipients.push(person('other@example.test', 'E-other@example.test')) }],
  ['CC recipient', s => { s.history[0].recipients[0].recipientField = 'CC' }],
  ['BCC recipient', s => { s.history[0].recipients[0].recipientField = 'BCC' }],
  ['wrong sender email', s => { s.history[0].senders[0].deliveryIdentifier.value = 'other@example.test' }],
  ['wrong recipient email', s => { s.history[0].recipients[0].deliveryIdentifier.value = 'other@example.test' }],
  ['incoming actor mismatch', s => { s.history[0].senders[0].actorId = 'V-901' }],
  ['wrong message thread', s => { s.history[0].conversationsThreadId = '701' }],
  ['wrong message channel', s => { s.history[0].channelId = '1000' }],
  ['wrong message channel account', s => { s.history[0].channelAccountId = '41' }],
  ['archived message', s => { s.history[0].archived = true }],
  ['duplicate message ID', s => { s.history.push(structuredClone(s.history[0])) }],
  ['invalid message ID', s => { s.history[0].id = '../message' }],
  ['missing message timestamp', s => { delete s.history[0].createdAt }],
  ['invalid delivery state', s => { s.history[0].status.statusType = 'QUEUED' }],
  ['invalid truncation state', s => { s.history[0].truncationStatus = 'OTHER' }],
  ['header injection in subject', s => { s.history[0].subject = 'Subject\r\nBcc: other@example.test' }],
  ['body control characters', s => { s.history[0].text = 'bad\u0000body' }],
  ['oversized body', s => { s.history[0].text = 'x'.repeat(10001) }],
  ['oversized combined history', s => { s.history = Array.from({ length: 21 }, (_, i) => message(`incoming-${i}`, 'INCOMING', { text: 'x'.repeat(10000) })) }],
]
for (const [label, mutate] of historyCases) test(`reply history rejects ${label}`, async t => {
  const f = await fixture(t)
  mutate(f.state)
  await reject(f.context, 409, 'REPLY_CONTEXT_UNAVAILABLE')
  noSend(f)
})

test('paged thread discovery and message history are refused rather than returning partial contexts', async t => {
  for (const target of ['threads', 'messages']) await t.test(target, async t => {
    const f = await fixture(t, { hook: (call, state) => call.name === target
      ? json({ results: target === 'threads' ? [state.thread] : state.history, paging: { next: { after: 'opaque', link: PRIVATE } } }) : undefined })
    await reject(f.context, 409, 'REPLY_CONTEXT_UNAVAILABLE')
    noSend(f)
  })
})

test('malformed non-object provider bodies fail closed without reflecting vendor text', async t => {
  for (const target of ['ticket', 'contact', 'threads', 'thread', 'channel', 'actor', 'messages']) await t.test(target, async t => {
    const f = await fixture(t, { hook: call => call.name === target ? json([PRIVATE]) : undefined })
    await reject(f.context, target === 'ticket' ? 404 : 409)
    noSend(f)
  })
})

test('preview bounds output and sorts latest email without exposing internal comments', async t => {
  const f = await fixture(t)
  f.state.history = Array.from({ length: 25 }, (_, i) => message(`incoming-${i}`, 'INCOMING', {
    createdAt: new Date(Date.parse(AT) + i * 1000).toISOString(), text: i === 24 ? 'x'.repeat(2500) : `Body ${i}`,
  })).reverse()
  f.state.history.push({ id: 'internal-1', conversationsThreadId: '700', createdAt: AT, type: 'COMMENT', text: PRIVATE })
  const { body } = await f.context()
  assert.equal(body.messages.length, 20)
  assert.equal(body.messages[0].messageId, 'incoming-5')
  assert.equal(body.latestMessageId, 'incoming-24')
  assert.equal(body.messages.at(-1).body.length, 2000)
  assert.equal(body.messages.at(-1).truncated, true)
  assert.ok(!JSON.stringify(body).includes(PRIVATE))
})

test('delivery status, internal comments, vendor key order and unrelated metadata do not change dispatch identity', async t => {
  const f = await fixture(t)
  const initial = (await f.context()).body
  f.state.history[0].status.statusType = 'READ'
  f.state.history[0].newVendorMetadata = PRIVATE
  f.state.history.push({ id: 'internal-1', conversationsThreadId: '700', createdAt: AT, type: 'COMMENT', text: PRIVATE })
  f.state.thread.latestMessageTimestamp = '2026-09-10T12:10:00.000Z'
  f.state.channel = Object.fromEntries(Object.entries(f.state.channel).reverse())
  const updated = (await f.context()).body
  assert.equal(initial.dispatchVersion, updated.dispatchVersion)
  assert.equal(initial.contextVersion, updated.contextVersion)
  f.state.history[0].text = 'Customer edited the relevant email content.'
  const edited = (await f.context()).body
  assert.equal(initial.dispatchVersion, edited.dispatchVersion)
  assert.notEqual(initial.contextVersion, edited.contextVersion)
  f.state.history.push(message('incoming-2', 'INCOMING', { createdAt: '2026-09-10T12:20:00.000Z' }))
  assert.notEqual((await f.context()).body.dispatchVersion, initial.dispatchVersion)
})

function historyWithOlderIncoming() {
  return [message('incoming-older', 'INCOMING', { text: 'Older requester content outside the preview.' }),
    ...Array.from({ length: 20 }, (_, i) => message(`outgoing-${i}`, 'OUTGOING', {
      createdAt: new Date(Date.parse(AT) + (i + 1) * 1000).toISOString(),
    }))]
}

test('requester proof covers incoming email older than the latest 20 outgoing preview messages', async t => {
  const f = await fixture(t)
  f.state.history = historyWithOlderIncoming()
  const { body } = await f.context()
  assert.equal(body.requesterIncomingVerified, true)
  assert.equal(body.messages.length, 20)
  assert.ok(body.messages.every(item => item.direction === 'OUTGOING'))
  assert.equal(body.messages[0].messageId, 'outgoing-0')
  assert.equal(body.latestMessageId, 'outgoing-19')
  assert.ok(!JSON.stringify(body).includes('Older requester content'))
  assert.equal(f.counts.messages, 2, 'proof requires both complete history inspections')
  await f.send(approval(body))
  assert.equal(f.calls.find(call => call.name === 'send').body.recipients[0].actorId, 'V-900')
})

for (const [label, mutate] of [
  ['no incoming anywhere in the full history', s => { s.history.shift() }],
  ['incoming sender email mismatches requester', s => { s.history[0].senders[0].deliveryIdentifier.value = 'other@example.test' }],
  ['incoming contact actor mismatches requester', s => { s.history[0].senders[0].actorId = 'V-901' }],
  ['incoming email actor mismatches requester', s => { s.history[0].senders[0].actorId = 'E-other@example.test' }],
  ['associated contact has another email', s => { s.contact.properties.email = 'other@example.test' }],
  ['thread belongs to another contact', s => { s.thread.associatedContactId = '901' }],
  ['incoming-looking internal comment is not email', s => { s.history[0].type = 'COMMENT' }],
]) test(`older requester proof fails closed when ${label}`, async t => {
  const f = await fixture(t)
  f.state.history = historyWithOlderIncoming()
  mutate(f.state)
  // An upstream lookalike proof cannot bypass the broker's own inspection.
  f.state.thread.requesterIncomingVerified = true
  await reject(f.context, 409, 'REPLY_CONTEXT_UNAVAILABLE')
  noSend(f)
})

test('older incoming disappearing during the final history recheck withholds the entire preview', async t => {
  const f = await fixture(t, { hook: (call, state) => {
    if (call.name === 'messages' && call.count === 2) state.history.shift()
  } })
  f.state.history = historyWithOlderIncoming()
  await reject(f.context, 409, 'STALE_APPROVAL')
  noSend(f)
})

test('requester proof binds context approval without changing the email-ID-set dispatch reservation', async t => {
  const f = await fixture(t)
  const { body } = await f.context()
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.equal(body.dispatchVersion, digest({ accountId: '123', ticketId: '1', threadId: '700', messageIds: ['incoming-1'] }))
  const legacyContext = { dispatchVersion: body.dispatchVersion,
    identity: { contactId: '900', address: TO, updatedAt: AT },
    thread: { id: '700', ticketId: '1', contactId: '900', inboxId: '30', channelId: '1002', channelAccountId: '40',
      archived: false, spam: false, status: 'OPEN' },
    channel: { from: FROM, channelId: '1002', channelAccountId: '40', inboxId: '30', senderActorId: 'A-50', senderType: 'AGENT' },
    messages: [{ messageId: 'incoming-1', direction: 'INCOMING', body: f.state.history[0].text, createdAt: AT,
      subject: f.state.history[0].subject, sender: { email: TO, actorId: 'V-900' }, recipient: { email: FROM, actorId: 'A-50' },
      truncationStatus: 'NOT_TRUNCATED' }],
  }
  const { messages, ...binding } = legacyContext
  assert.equal(body.contextVersion, digest({ ...binding, requesterIncomingVerified: true, messages }))
  await reject(() => f.send({ ...approval(body), contextVersion: digest(legacyContext) }), 409, 'STALE_APPROVAL')
  noSend(f)
})

for (const [label, changed, status, code] of [
  ['account', { accountId: '456' }, 400, 'INVALID_REQUEST'],
  ['recipient', { to: 'other@example.test' }, 409, 'STALE_APPROVAL'],
  ['sender', { from: 'other@example.test' }, 409, 'STALE_APPROVAL'],
  ['subject', { subject: 'An unapproved subject' }, 409, 'STALE_APPROVAL'],
  ['ticket version', { expectedUpdatedAt: '2026-09-10T13:00:00.000Z' }, 409, 'STALE_APPROVAL'],
  ['context version', { contextVersion: 'f'.repeat(64) }, 409, 'STALE_APPROVAL'],
  ['unknown routing field', { threadId: '701' }, 400, 'INVALID_REQUEST'],
  ['caller-supplied incoming proof', { requesterIncomingVerified: true }, 400, 'INVALID_REQUEST'],
  ['attachments', { attachments: [{ fileId: '123' }] }, 400, 'INVALID_REQUEST'],
  ['CC', { cc: 'other@example.test' }, 400, 'INVALID_REQUEST'],
  ['empty body', { body: '  ' }, 400, 'INVALID_REQUEST'],
  ['oversized body', { body: 'x'.repeat(10001) }, 400, 'INVALID_REQUEST'],
  ['body controls', { body: 'a\u0000b' }, 400, 'INVALID_REQUEST'],
]) test(`send rejects changed approval ${label} without dispatch`, async t => {
  const f = await fixture(t)
  const body = { ...approval((await f.context()).body), ...changed }
  await reject(() => f.send(body), status, code)
  noSend(f)
})

test('disabled replies expose no routes and readonly replies cannot POST', async t => {
  const disabled = await fixture(t, { settings: { BROKER_ENABLE_REPLIES: 'false' } })
  await reject(disabled.context, 404, 'NOT_FOUND')
  await reject(() => disabled.send({}), 404, 'NOT_FOUND')
  assert.equal(disabled.calls.length, 0)
  const readonly = await fixture(t, { settings: { BROKER_ENABLE_WRITES: 'false', BROKER_SCOPE_IS_IMMUTABLE: 'false' } })
  const input = approval((await readonly.context()).body)
  await reject(() => readonly.send(input), 403, 'WRITES_DISABLED')
  noSend(readonly)
})

test('durable reservation prevents replay after success and across new broker instances', async t => {
  const f = await fixture(t)
  const input = approval((await f.context()).body)
  await f.send(input)
  await reject(() => f.send(input), 409, 'REPLY_DISPATCH_ALREADY_RESERVED')
  await reject(() => f.restart().handle({ method: 'POST', url: SEND, body: input }), 409, 'REPLY_DISPATCH_ALREADY_RESERVED')
  f.state.history[0].status.statusType = 'READ'
  f.state.history.push({ id: 'internal-1', conversationsThreadId: '700', createdAt: AT, type: 'COMMENT', text: PRIVATE })
  await reject(async () => f.send(approval((await f.context()).body)), 409, 'REPLY_DISPATCH_ALREADY_RESERVED')
  assert.equal(f.counts.send, 1)
})

test('independent broker instances sharing one store cannot concurrently dispatch the same email history', async t => {
  const f = await fixture(t)
  const input = approval((await f.context()).body)
  const other = f.restart()
  const results = await Promise.allSettled([f.send(input), other.handle({ method: 'POST', url: SEND, body: input })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REPLY_DISPATCH_ALREADY_RESERVED')
  assert.equal(f.counts.send, 1)
})

test('a new delivered history invalidates the old approval instead of reusing it for another send', async t => {
  const f = await fixture(t)
  f.state.appendSent = true
  const input = approval((await f.context()).body)
  await f.send(input)
  await reject(() => f.send(input), 409, 'STALE_APPROVAL')
  assert.equal(f.counts.send, 1)
})

for (const [label, hook] of [
  ['transport timeout', call => { if (call.name === 'send') throw new Error(PRIVATE) }],
  ['provider 500', call => call.name === 'send' ? json({ message: PRIVATE }, 500) : undefined],
  ['provider unexpected success status', call => call.name === 'send' ? json({ id: 'sent-1' }, 200) : undefined],
  ['malformed send response', call => call.name === 'send' ? json({ id: '../private' }, 201) : undefined],
  ['message readback failure', call => call.name === 'sent-message' ? json({ message: PRIVATE }, 503) : undefined],
  ['message readback content mismatch', (call, state) => call.name === 'sent-message' ? json({ ...state.sent, text: 'Different body' }) : undefined],
  ['message readback wrong recipient', (call, state) => call.name === 'sent-message' ? json({ ...state.sent, recipients: [person('other@example.test', 'V-901')] }) : undefined],
  ['message readback failed delivery', (call, state) => call.name === 'sent-message' ? json({ ...state.sent, status: { statusType: 'FAILED', failureDetails: PRIVATE } }) : undefined],
]) test(`ambiguous ${label} retains reservation and cannot send twice`, async t => {
  const f = await fixture(t, { hook })
  const input = approval((await f.context()).body)
  await reject(() => f.send(input), 502, 'WRITE_OUTCOME_UNKNOWN')
  await reject(() => f.restart().handle({ method: 'POST', url: SEND, body: input }), 409, 'REPLY_DISPATCH_ALREADY_RESERVED')
  assert.equal(f.counts.send, 1)
})

for (const [label, trigger, mutate, status, code] of [
  ['pipeline', 'ticket', s => { s.ticket.properties.hs_pipeline = '21' }, 404, 'NOT_FOUND'],
  ['marker', 'ticket', s => { s.ticket.properties.sm_brand = 'another-brand' }, 404, 'NOT_FOUND'],
  ['ticket timestamp', 'ticket', s => { s.ticket.properties.hs_lastmodifieddate = '2026-09-10T12:30:00.000Z' }, 409, 'STALE_APPROVAL'],
  ['requester email', 'ticket', s => { s.ticket.properties.sm_requester = 'different@example.test' }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['contact email', 'contact', s => { s.contact.properties.email = 'different@example.test' }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['ticket-contact association', 'ticket', s => { s.ticket.associations.contacts.results = [] }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['thread-ticket association', 'thread', s => { s.thread.threadAssociations.associatedTicketId = '2' }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['thread state', 'thread', s => { s.thread.status = 'CLOSED' }, 409, 'STALE_APPROVAL'],
  ['channel authorization', 'channel', s => { s.channel.authorized = false }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['agent actor', 'actor', s => { s.actor.type = 'INTEGRATION' }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['incoming content', 'messages', s => { s.history[0].text = 'Changed while reading' }, 409, 'STALE_APPROVAL'],
]) test(`preview detects ${label} changed during its second inspection`, async t => {
  const f = await fixture(t, { hook: (call, state) => { if (call.name === trigger && call.count === 2) mutate(state) } })
  await reject(f.context, status, code)
  noSend(f)
})

test('ticket ownership changing after POST is reported unknown, never as verified success', async t => {
  const f = await fixture(t, { hook: (call, state) => {
    if (call.name === 'sent-message') state.ticket.properties.sm_brand = 'other-brand'
  } })
  const input = approval((await f.context()).body)
  await reject(() => f.send(input), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(f.counts.send, 1)
  assert.equal((await readdir(f.directory)).length, 1)
})

for (const [label, trigger, mutate, status, code] of [
  ['product scope', 'ticket', s => { s.ticket.properties.sm_brand = 'other-brand' }, 404, 'NOT_FOUND'],
  ['contact association', 'ticket', s => { s.ticket.associations.contacts.results = [] }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['contact email', 'contact', s => { s.contact.properties.email = 'someone-else@example.test' }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['thread association', 'thread', s => { s.thread.threadAssociations.associatedTicketId = '2' }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['sender authorization', 'channel', s => { s.channel.authorized = false }, 409, 'REPLY_CONTEXT_UNAVAILABLE'],
  ['new incoming message', 'messages', s => { s.history.push(message('incoming-2', 'INCOMING', { createdAt: '2026-09-10T12:01:00.000Z' })) }, 409, 'STALE_APPROVAL'],
]) test(`send repeats its inspection and blocks ${label} changed before dispatch`, async t => {
  let armed = false
  let reads = 0
  const f = await fixture(t, { hook: (call, state) => {
    if (armed && call.name === trigger && ++reads === 2) mutate(state)
  } })
  const input = approval((await f.context()).body)
  armed = true
  await reject(() => f.send(input), status, code)
  noSend(f)
})

for (const [label, mutate] of [
  ['requester contact', s => { s.contact.properties.email = 'someone-else@example.test' }],
  ['thread association', s => { s.thread.threadAssociations.associatedTicketId = '2' }],
  ['email channel', s => { s.channel.authorized = false }],
  ['sender actor', s => { s.actor.type = 'INTEGRATION' }],
]) test(`post-send ${label} change cannot be reported as confirmed success`, async t => {
  const f = await fixture(t, { hook: (call, state) => { if (call.name === 'sent-message') mutate(state) } })
  const input = approval((await f.context()).body)
  await reject(() => f.send(input), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(f.counts.send, 1)
  assert.equal((await readdir(f.directory)).length, 1)
})

test('inbound email actor may be absent or a matching email actor without accepting caller routing', async t => {
  for (const actorId of [undefined, `E-${TO}`]) await t.test(String(actorId), async t => {
    const f = await fixture(t)
    f.state.history[0].senders[0].actorId = actorId
    const input = approval((await f.context()).body)
    await f.send(input)
    const recipient = f.calls.find(call => call.name === 'send').body.recipients[0]
    assert.equal(recipient.actorId, actorId)
    assert.deepEqual(recipient.deliveryIdentifiers, [{ type: 'HS_EMAIL_ADDRESS', value: TO }])
  })
})

test('requester and routing addresses are normalized for matching, not taken from raw customer content', async t => {
  const f = await fixture(t)
  f.state.ticket.properties.sm_requester = TO.toUpperCase()
  f.state.contact.properties.email = TO.toUpperCase()
  f.state.channel.deliveryIdentifier.value = FROM.toUpperCase()
  f.state.history[0].senders[0].deliveryIdentifier.value = TO.toUpperCase()
  f.state.history[0].recipients[0].deliveryIdentifier.value = FROM.toUpperCase()
  const context = (await f.context()).body
  assert.equal(context.to, TO)
  assert.equal(context.from, FROM)
  await f.send(approval(context))
  assert.equal(f.calls.find(call => call.name === 'send').body.recipients[0].deliveryIdentifiers[0].value, TO)
})

test('reply configuration requires explicit native routing and normalized persistent storage', async t => {
  const f = await fixture(t)
  for (const [key, value] of [
    ['HUBSPOT_EMAIL_INBOX_ID', undefined], ['HUBSPOT_EMAIL_CHANNEL_ACCOUNT_ID', undefined],
    ['HUBSPOT_EMAIL_SENDER_ACTOR_ID', undefined], ['BROKER_SEND_RESERVATION_DIR', undefined],
    ['HUBSPOT_EMAIL_INBOX_ID', ''], ['HUBSPOT_EMAIL_CHANNEL_ACCOUNT_ID', '../40'],
    ['HUBSPOT_EMAIL_SENDER_ACTOR_ID', 'I-50'], ['BROKER_SEND_RESERVATION_DIR', 'relative'],
    ['BROKER_SEND_RESERVATION_DIR', '/'], ['BROKER_SEND_RESERVATION_DIR', '/tmp/../private'],
    ['BROKER_SEND_RESERVATION_DIR', '/tmp/priva\nte'], ['BROKER_SEND_RESERVATION_DIR', '/tmp/private\u0000'],
    ['BROKER_ENABLE_REPLIES', 'yes'], ['BROKER_ENABLE_REPLIES', 'TRUE'],
    ['BROKER_ENABLE_WRITES', 'yes'], ['BROKER_SCOPE_IS_IMMUTABLE', 'yes'],
    ['BROKER_SCOPE_IS_IMMUTABLE', 'false'],
  ]) assert.throws(() => loadConfig({ ...f.env, [key]: value }))
})

test('reply-enabled readiness refuses missing-parent or unusable storage before reporting healthy', async t => {
  const f = await fixture(t)
  const missingParent = createBroker({ ...f.cfg, sendReservationDir: join(f.root, 'missing-parent', 'claims') }, { fetchImpl: f.fetchImpl })
  await reject(() => missingParent.ready(), 503, 'REPLY_RESERVATION_UNAVAILABLE')
  await writeFile(f.directory, 'private-storage-details')
  await reject(() => f.broker.ready(), 503, 'REPLY_RESERVATION_UNAVAILABLE')
  assert.equal(f.calls.length, 0)
})

test('provider echo of an existing message ID cannot count as a newly accepted reply', async t => {
  const f = await fixture(t, { hook: call => call.name === 'send' ? json({ id: 'incoming-1' }, 201) : undefined })
  const input = approval((await f.context()).body)
  await reject(() => f.send(input), 502, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(f.counts.send, 1)
  assert.equal(f.counts['sent-message'], undefined)
  assert.equal(f.counts.unexpected, undefined, 'an old message must be rejected before its readback')
  await reject(() => f.restart().handle({ method: 'POST', url: SEND, body: input }), 409, 'REPLY_DISPATCH_ALREADY_RESERVED')
})
