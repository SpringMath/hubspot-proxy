// This is an allowlisted adapter. Never turn `url` or request headers into an upstream destination.
const ORIGIN = 'https://api.hubapi.com'
const TICKETS = '/crm/v3/objects/tickets'
const CONTACTS = '/crm/v3/objects/contacts'
const NOTES = '/crm/v3/objects/notes'
const NOTE_ASSOCIATIONS = ['tickets', 'contacts', 'companies', 'deals']
const MAX_NOTES = 50
const MAX_CONCURRENT_NOTES = 3
const ID = /^[0-9]{1,30}$/
const validId = value => typeof value === 'string' && ID.test(value)
const EXTERNAL_ID = /^[a-zA-Z0-9_-]{8,160}$/
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export class BrokerError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
const fail = (status, code) => { throw new BrokerError(status, code) }
const invalid = () => fail(400, 'INVALID_REQUEST')
const missing = () => fail(404, 'NOT_FOUND')
const malformed = () => fail(502, 'UPSTREAM_INVALID_RESPONSE')
function keys(value, allowed) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /\u0000/.test(value)) invalid()
  return value
}
function email(value) {
  text(value, 254, true)
  if (!/^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(value)) invalid()
  return value.toLowerCase()
}
function integer(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  if (!/^[0-9]+$/.test(String(value))) invalid()
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid()
  return result
}

export function createBroker(config, { fetchImpl = fetch } = {}) {
  const transferredBytes = new WeakMap()
  const boundary = ['hs_pipeline', config.scopeProperty]
  const allowed = config.readProperties
  const inScope = (row, archived = false) => isObject(row) && validId(row.id)
    && row.archived === archived && isObject(row.properties)
    && row.properties.hs_pipeline === config.pipelineId
    && row.properties[config.scopeProperty] === config.scopeValue
  function properties(value) {
    const list = value === undefined || value === null ? allowed : value
    if (!Array.isArray(list) || list.length > allowed.length || list.some(p => typeof p !== 'string' || !allowed.includes(p))) invalid()
    return [...new Set([...list, ...boundary])]
  }
  function project(row, props) {
    const result = { id: row.id, archived: row.archived, properties: {} }
    for (const name of props) {
      const value = row.properties[name]
      if (value !== undefined && value !== null && typeof value !== 'string') malformed()
      if (typeof value === 'string' && value.length > 100000) malformed()
      result.properties[name] = value ?? null
    }
    return result
  }
  async function upstream(path, { method = 'GET', body, signal, allow404 = false, expectedStatus } = {}) {
    const isMutation = ['PATCH', 'DELETE'].includes(method) || (method === 'POST' && [TICKETS, CONTACTS, NOTES].includes(path))
    // `path` is built only from constants and individually validated/encoded values below.
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/.test(path)) malformed()
    let response
    try {
      response = await fetchImpl(ORIGIN + path, {
        method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.upstreamTimeoutMs)]) : AbortSignal.timeout(config.upstreamTimeoutMs),
        headers: { Authorization: `Bearer ${config.upstreamToken}`, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch { fail(502, isMutation ? 'WRITE_OUTCOME_UNKNOWN' : 'UPSTREAM_UNAVAILABLE') }
    const discard = () => { void response.body?.cancel().catch(() => {}) }
    if (allow404 && response.status === 404) { discard(); return null }
    if (!response.ok) {
      discard()
      // Never forward error bodies, vendor links, headers, messages or correlation IDs.
      if (response.status === 429) fail(503, 'UPSTREAM_BUSY')
      if ([401, 403].includes(response.status)) fail(503, 'UPSTREAM_NOT_READY')
      if (response.status === 404) missing()
      if (response.status === 409) fail(409, 'CONFLICT_RECONCILE_FIRST')
      if ([400, 422].includes(response.status)) fail(400, 'UPSTREAM_REJECTED')
      fail(502, isMutation ? 'WRITE_OUTCOME_UNKNOWN' : 'UPSTREAM_UNAVAILABLE')
    }
    if (expectedStatus && response.status !== expectedStatus) { discard(); fail(502, 'WRITE_OUTCOME_UNKNOWN') }
    if (response.status === 204) { discard(); return null }
    // Bound successful bodies before JSON parsing too; never trust content-length alone.
    const reader = response.body?.getReader()
    if (!reader) { if (isMutation) fail(502, 'WRITE_OUTCOME_UNKNOWN'); malformed() }
    let bytes = 0
    const chunks = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 2097152) { await reader.cancel(); malformed() }
        if (signal) {
          const total = (transferredBytes.get(signal) ?? 0) + value.byteLength
          transferredBytes.set(signal, total)
          if (total > 8388608) { await reader.cancel(); fail(503, 'QUERY_BOUND_EXCEEDED') }
        }
        chunks.push(Buffer.from(value))
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      if (isMutation) fail(502, 'WRITE_OUTCOME_UNKNOWN')
      if (error instanceof BrokerError) throw error
      malformed()
    }
  }
  async function account(signal) {
    const details = await upstream('/account-info/v3/details', { signal })
    if (String(details?.portalId) !== config.accountId) fail(503, 'UPSTREAM_ACCOUNT_MISMATCH')
    return { portalId: Number(config.accountId) }
  }
  async function pipeline(signal) {
    const data = await upstream(`/crm/v3/pipelines/tickets/${config.pipelineId}`, { signal })
    if (!isObject(data) || data.id !== config.pipelineId || data.archived === true || !Array.isArray(data.stages) || data.stages.length > 250 || data.stages.some(stage => !isObject(stage))) malformed()
    const stages = data.stages.filter(stage => config.stages.includes(stage.id)).map(stage => {
      if (!validId(stage.id) || typeof stage.label !== 'string' || stage.label.length > 250
        || stage.archived === true || !['OPEN', 'CLOSED'].includes(stage.metadata?.ticketState)) malformed()
      return { id: stage.id, label: stage.label, archived: false, metadata: { ticketState: stage.metadata.ticketState } }
    })
    if (stages.length !== config.stages.length || new Set(stages.map(stage => stage.id)).size !== config.stages.length) fail(503, 'STAGE_CONFIGURATION_INVALID')
    if (stages.find(stage => stage.id === config.initialStage)?.metadata.ticketState !== 'OPEN') fail(503, 'STAGE_CONFIGURATION_INVALID')
    if (config.closedStage && stages.find(stage => stage.id === config.closedStage)?.metadata.ticketState !== 'CLOSED') fail(503, 'STAGE_CONFIGURATION_INVALID')
    return { id: config.pipelineId, archived: false, stages }
  }
  async function readTicket(id, { props = allowed, archived = false, idProperty, associations = false, signal } = {}) {
    const query = new URLSearchParams({ properties: [...new Set([...props, ...boundary])].join(','), archived: String(archived) })
    if (idProperty) query.set('idProperty', idProperty)
    if (associations) query.set('associations', 'contacts')
    const row = await upstream(`${TICKETS}/${encodeURIComponent(id)}?${query}`, { signal, allow404: true })
    if (!inScope(row, archived)) missing()
    if (!idProperty && row.id !== id) malformed()
    if (idProperty && row.properties[idProperty] !== id) malformed()
    return row
  }
  async function contact(requesterEmail, { signal, create = false } = {}) {
    const path = `${CONTACTS}/${encodeURIComponent(requesterEmail)}?idProperty=email&properties=email`
    let result = await upstream(path, { signal, allow404: true })
    if (!result && create) {
      try { result = await upstream(CONTACTS, { method: 'POST', body: { properties: { email: requesterEmail } }, signal }) }
      catch (error) {
        // A contact POST is never blindly retried; only one exact-email reconciliation read.
        if (!(error instanceof BrokerError) || ![409, 502].includes(error.status)) throw error
        result = await upstream(path, { signal, allow404: true })
      }
    }
    if (!result || !validId(result.id) || result.archived !== false || typeof result.properties?.email !== 'string' || result.properties.email.toLowerCase() !== requesterEmail) {
      fail(502, 'REQUESTER_ASSOCIATION_UNVERIFIED')
    }
    return result.id
  }
  async function requesterVerified(row, signal) {
    const requesterEmail = email(row.properties[config.requesterProperty])
    const contactId = await contact(requesterEmail, { signal })
    const associations = row.associations?.contacts?.results
    if (!Array.isArray(associations) || !associations.some(item => item.id === contactId)) fail(502, 'REQUESTER_ASSOCIATION_UNVERIFIED')
  }
  function pagination(rows, offset, limit, props, includeTotal) {
    const page = rows.slice(offset, offset + limit).map(row => project(row, props))
    return { ...(includeTotal ? { total: rows.length } : {}), results: page,
      ...(offset + limit < rows.length ? { paging: { next: { after: String(offset + limit) } } } : {}) }
  }
  function vendorAfter(data) {
    const next = data?.paging?.next?.after
    if (next === undefined) return undefined
    if (!/^[a-zA-Z0-9_+=/-]{1,256}$/.test(String(next))) malformed()
    return String(next)
  }
  function validateSearch(body) {
    keys(body, ['filterGroups', 'query', 'properties', 'sorts', 'limit', 'after'])
    const props = properties(body.properties)
    const limit = integer(body.limit, 10, 1, 100)
    const offset = integer(body.after, 0, 0, config.maxSearchRecords)
    if (body.filterGroups !== undefined && !Array.isArray(body.filterGroups)) invalid()
    const groups = !body.filterGroups?.length ? [{ filters: [] }] : body.filterGroups
    if (!Array.isArray(groups) || groups.length > 3) invalid()
    const filterGroups = groups.map(group => {
      keys(group, ['filters'])
      if (!Array.isArray(group.filters) || group.filters.length > 4) invalid()
      const filters = group.filters.filter(filter => {
        keys(filter, ['propertyName', 'operator', 'value', 'values'])
        if (!allowed.includes(filter.propertyName)) invalid()
        if (boundary.includes(filter.propertyName)) {
          const expected = filter.propertyName === 'hs_pipeline' ? config.pipelineId : config.scopeValue
          if (filter.operator !== 'EQ' || filter.value !== expected || filter.values !== undefined) invalid()
          return false
        }
        if (filter.operator === 'EQ') {
          text(filter.value, 200, true)
          if (filter.values !== undefined) invalid()
        } else if (filter.operator === 'IN') {
          if (!Array.isArray(filter.values) || !filter.values.length || filter.values.length > 30 || filter.value !== undefined) invalid()
          filter.values.forEach(value => text(value, 200, true))
        } else invalid()
        return true
      })
      return { filters: [...filters, { propertyName: 'hs_pipeline', operator: 'EQ', value: config.pipelineId },
        { propertyName: config.scopeProperty, operator: 'EQ', value: config.scopeValue }] }
    })
    let query
    if (body.query !== undefined) query = text(body.query, 200, true)
    const sorts = body.sorts ?? ['-hs_lastmodifieddate']
    if (!Array.isArray(sorts) || sorts.length !== 1 || !['-hs_lastmodifieddate', 'hs_lastmodifieddate', 'subject', '-subject'].includes(sorts[0])) invalid()
    return { props, limit, offset, request: { filterGroups, sorts, properties: boundary, ...(query ? { query } : {}) } }
  }
  function matchesFilters(row, groups) {
    return groups.some(group => group.filters.every(filter => {
      const value = row.properties[filter.propertyName]
      if (typeof value !== 'string') return false
      return filter.operator === 'EQ' ? value.toLowerCase() === filter.value.toLowerCase()
        : filter.values.some(candidate => candidate.toLowerCase() === value.toLowerCase())
    }))
  }
  async function search(body, signal) {
    const { props, limit, offset, request } = validateSearch(body)
    const ids = []
    let scanned = 0
    const seen = new Set()
    const cursors = new Set()
    let after
    do {
      const data = await upstream(`${TICKETS}/search`, { method: 'POST', body: { ...request, limit: 100, ...(after ? { after } : {}) }, signal })
      if (!Array.isArray(data?.results) || data.results.length > 100) malformed()
      scanned += data.results.length
      for (const row of data.results) {
        if (!validId(row?.id) || seen.has(row.id)) malformed()
        seen.add(row.id); ids.push(row.id)
      }
      after = vendorAfter(data)
      if (scanned > config.maxSearchRecords || (after && scanned >= config.maxSearchRecords)) fail(503, 'QUERY_BOUND_EXCEEDED')
      if (after && (cursors.has(after) || !data.results.length)) malformed()
      cursors.add(after)
    } while (after)
    // Search indexes can lag ownership changes. Fresh reads, not search payloads/totals,
    // define both returned rows AND the total. Internal batch route is never exposed.
    const verified = new Map()
    let retainedBytes = 0
    for (let i = 0; i < ids.length; i += 100) {
      const input = ids.slice(i, i + 100)
      const checkProperties = [...new Set([...props, request.sorts[0].replace(/^-/, ''), ...request.filterGroups.flatMap(group => group.filters.map(filter => filter.propertyName))])]
      const data = await upstream(`${TICKETS}/batch/read`, { method: 'POST', body: { properties: checkProperties, inputs: input.map(id => ({ id })) }, signal })
      if (!Array.isArray(data?.results) || data.results.length !== input.length || data.results.some(row => !input.includes(row?.id)) || new Set(data.results.map(row => row.id)).size !== data.results.length || data.errors?.length) malformed()
      for (const row of data.results) if (inScope(row) && matchesFilters(row, request.filterGroups)) {
        const retained = project(row, [...new Set([...props, request.sorts[0].replace(/^-/, '')])])
        retainedBytes += Buffer.byteLength(JSON.stringify(retained))
        if (retainedBytes > 4194304) fail(503, 'QUERY_BOUND_EXCEEDED')
        verified.set(row.id, retained)
      }
    }
    const sort = request.sorts[0]
    const property = sort.replace(/^-/, '')
    const rows = ids.filter(id => verified.has(id)).map(id => verified.get(id))
    rows.sort((a, b) => {
      const order = String(a.properties[property] ?? '').localeCompare(String(b.properties[property] ?? ''))
      return (sort.startsWith('-') ? -order : order) || a.id.localeCompare(b.id)
    })
    return pagination(rows, offset, limit, props, true)
  }
  async function archivedList(query, signal) {
    if (query.get('archived') !== 'true') invalid()
    const props = properties(query.has('properties') ? query.get('properties').split(',') : undefined)
    const limit = integer(query.get('limit'), 100, 1, 100)
    const offset = integer(query.get('after'), 0, 0, config.maxSearchRecords)
    const candidates = new Set()
    const cursors = new Set()
    let count = 0
    let after
    do {
      // The upstream archive endpoint has no brand filter: request boundary metadata ONLY.
      const params = new URLSearchParams({ archived: 'true', limit: '100', properties: boundary.join(',') })
      if (after) params.set('after', after)
      const data = await upstream(`${TICKETS}?${params}`, { signal })
      if (!Array.isArray(data?.results) || data.results.length > 100) malformed()
      count += data.results.length
      for (const row of data.results) if (inScope(row, true)) candidates.add(row.id)
      after = vendorAfter(data)
      if (count > config.maxSearchRecords || (after && count >= config.maxSearchRecords)) fail(503, 'QUERY_BOUND_EXCEEDED')
      if (after && (cursors.has(after) || !data.results.length)) malformed()
      cursors.add(after)
    } while (after)
    const rows = []
    let retainedBytes = 0
    for (const id of candidates) {
      try {
        const retained = project(await readTicket(id, { props, archived: true, signal }), props)
        retainedBytes += Buffer.byteLength(JSON.stringify(retained))
        if (retainedBytes > 4194304) fail(503, 'QUERY_BOUND_EXCEEDED')
        rows.push(retained)
      }
      catch (error) { if (!(error instanceof BrokerError) || error.status !== 404) throw error }
    }
    return pagination(rows, offset, limit, props, false)
  }
  function writeAllowed() { if (!config.writes || !config.immutable) fail(403, 'WRITES_DISABLED') }
  function createProperties(body) {
    keys(body, ['properties']) // Caller-supplied contact IDs/associations are deliberately forbidden.
    keys(body.properties, ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', config.scopeProperty,
      config.requesterProperty, config.conversationProperty])
    const p = body.properties
    for (const [name, expected] of [['hs_pipeline', config.pipelineId], [config.scopeProperty, config.scopeValue], ['hs_pipeline_stage', config.initialStage]]) {
      if (p[name] !== undefined && p[name] !== expected) invalid()
    }
    if (!EXTERNAL_ID.test(p[config.conversationProperty] ?? '')) invalid()
    return { subject: text(p.subject, 250, true), content: text(p.content, 10000, true),
      hs_pipeline: config.pipelineId, hs_pipeline_stage: config.initialStage,
      [config.scopeProperty]: config.scopeValue,
      [config.requesterProperty]: email(p[config.requesterProperty]),
      [config.conversationProperty]: p[config.conversationProperty] }
  }
  async function create(body, signal) {
    writeAllowed()
    const props = createProperties(body)
    await pipeline(signal)
    const externalProperty = await upstream(`/crm/v3/properties/tickets/${config.conversationProperty}`, { signal })
    if (externalProperty?.name !== config.conversationProperty || externalProperty.hasUniqueValue !== true || externalProperty.type !== 'string') {
      fail(503, 'UNIQUE_EXTERNAL_ID_REQUIRED')
    }
    // Integration external-ID property MUST be unique in HubSpot. No list/search-based dedup.
    // Reject repeat requests, rather than claiming an old ticket is a newly applied write.
    try {
      await readTicket(props[config.conversationProperty], { props: [...boundary, config.conversationProperty], idProperty: config.conversationProperty, signal })
      fail(409, 'CONFLICT_RECONCILE_FIRST')
    } catch (error) { if (!(error instanceof BrokerError) || error.status !== 404) throw error }
    const contactId = await contact(props[config.requesterProperty], { signal, create: true })
    const created = await upstream(TICKETS, { method: 'POST', body: { properties: props, associations: [{
      to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }],
    }] }, signal, expectedStatus: 201 })
    // Anything after POST is uncertain if verification fails. Do not report a definite
    // rejection that would cause the client to retry a ticket POST.
    try {
      if (!created || !validId(created.id)) malformed()
      const row = await readTicket(created.id, { associations: true, signal })
      if (Object.entries(props).some(([key, value]) => row.properties[key] !== value)) malformed()
      if (!row.associations?.contacts?.results?.some(item => item.id === contactId)) malformed()
      return { ...project(row, allowed), broker: { requesterAssociated: true, emailDelivery: 'not_verified' } }
    } catch { fail(502, 'WRITE_OUTCOME_UNKNOWN') }
  }
  async function update(id, body, signal) {
    writeAllowed()
    keys(body, ['properties'])
    keys(body.properties, [config.summaryProperty, 'hs_pipeline_stage'])
    if (!Object.keys(body.properties).length) invalid()
    if (body.properties[config.summaryProperty] !== undefined) text(body.properties[config.summaryProperty], 10000)
    const stage = body.properties.hs_pipeline_stage
    if (stage !== undefined) {
      if (!config.stages.includes(stage)) invalid()
      await pipeline(signal)
    }
    await readTicket(id, { props: boundary, signal })
    await upstream(`${TICKETS}/${id}`, { method: 'PATCH', body: { properties: body.properties }, signal })
    try {
      const row = await readTicket(id, { signal })
      if (Object.entries(body.properties).some(([key, value]) => row.properties[key] !== value)) malformed()
      return project(row, allowed)
    } catch { fail(502, 'WRITE_OUTCOME_UNKNOWN') }
  }
  async function archive(id, signal) {
    writeAllowed()
    await readTicket(id, { props: boundary, signal })
    const result = await upstream(`${TICKETS}/${id}`, { method: 'DELETE', signal, expectedStatus: 204 })
    try {
      if (result !== null) malformed()
      await readTicket(id, { props: boundary, archived: true, signal })
    } catch { fail(502, 'WRITE_OUTCOME_UNKNOWN') }
  }
  function notesAllowed() { if (!config.notesEnabled) missing() }
  function noteBoundary(row, noteId, ticketId) {
    if (!isObject(row) || row.id !== noteId || row.archived !== false || !isObject(row.associations)
      || !isObject(row.associations.tickets)) missing()
    // Notes shared with any other ticket or standard CRM record are deliberately
    // withheld. Missing association pages mean empty; an absent tickets page does
    // not prove ownership. The broker never exposes generic note-ID access.
    let eligible = true
    for (const [kind, page] of Object.entries(row.associations)) {
      if (!NOTE_ASSOCIATIONS.includes(kind) || !isObject(page) || !Array.isArray(page.results)
        || (page.paging !== undefined && page.paging !== null)
        || page.results.some(record => !isObject(record) || !validId(record.id))
        || new Set(page.results.map(record => record.id)).size !== page.results.length) missing()
      if (kind === 'tickets') {
        if (page.results.length !== 1 || page.results[0]?.id !== ticketId) eligible = false
      } else if (page.results.length) eligible = false
    }
    // Do not turn a malformed later page into an apparently valid omission.
    return eligible
  }
  function projectNote(row, ticketId) {
    const timestamp = row.properties?.hs_timestamp
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))
      || typeof row.properties?.hs_note_body !== 'string' || row.properties.hs_note_body.length > 65536) malformed()
    return {
      id: row.id, archived: false, createdAt: row.createdAt, updatedAt: row.updatedAt,
      properties: { hs_timestamp: timestamp, hs_note_body: row.properties.hs_note_body },
      associations: { tickets: { results: [{ id: ticketId, type: 'note_to_ticket' }] } },
    }
  }
  async function readNote(noteId, ticketId, signal, withholdIneligible = false) {
    const params = new URLSearchParams({ archived: 'false', associations: NOTE_ASSOCIATIONS.join(','), properties: 'hs_timestamp' })
    const boundary = await upstream(`${NOTES}/${noteId}?${params}`, { signal, allow404: true })
    if (!noteBoundary(boundary, noteId, ticketId)) {
      if (withholdIneligible) return null
      missing()
    }
    params.set('properties', 'hs_timestamp,hs_note_body')
    const row = await upstream(`${NOTES}/${noteId}?${params}`, { signal, allow404: true })
    if (!noteBoundary(row, noteId, ticketId)) missing()
    return projectNote(row, ticketId)
  }
  async function listNotes(id, signal) {
    notesAllowed()
    await readTicket(id, { props: boundary, signal })
    const page = await upstream(`${TICKETS}/${id}/associations/notes?limit=${MAX_NOTES}`, { signal })
    if (!isObject(page) || !Array.isArray(page.results) || page.results.length > MAX_NOTES
      || (page.paging !== undefined && page.paging !== null)) fail(503, 'QUERY_BOUND_EXCEEDED')
    const ids = page.results.map(row => row?.id)
    if (ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) malformed()
    const results = []
    let totalBody = 0
    let notesWithheld = false
    let next = 0
    let failed = false
    let failure
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_NOTES, ids.length) }, async () => {
      while (!failed && next < ids.length) {
        const noteId = ids[next++]
        try {
          const note = await readNote(noteId, id, signal, true)
          if (!note) { notesWithheld = true; continue }
          totalBody += Buffer.byteLength(note.properties.hs_note_body)
          if (totalBody > 200000) fail(503, 'QUERY_BOUND_EXCEEDED')
          results.push(note)
        } catch (error) { if (!failed) failure = error; failed = true }
      }
    }))
    if (failed) throw failure
    // Never return partial results after reassignment, archival or pagination.
    await readTicket(id, { props: boundary, signal })
    results.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    return { results, notesWithheld }
  }
  async function createNote(id, body, signal) {
    notesAllowed()
    writeAllowed()
    keys(body, ['accountId', 'expectedUpdatedAt', 'body'])
    if (body.accountId !== config.accountId) invalid()
    const expectedAt = text(body.expectedUpdatedAt, 100, true)
    if (!Number.isFinite(Date.parse(expectedAt))) invalid()
    const plain = text(body.body, 10000, true).replace(/\r\n?/g, '\n').trim()
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(plain)) invalid()
    const current = await readTicket(id, { props: [...boundary, 'hs_lastmodifieddate'], signal })
    if (typeof current.properties.hs_lastmodifieddate !== 'string') malformed()
    if (current.properties.hs_lastmodifieddate !== expectedAt) fail(409, 'STALE_APPROVAL')
    const escaped = plain.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
    const html = `<p>${escaped.replace(/\n/g, '<br>')}</p>`
    const created = await upstream(NOTES, { method: 'POST', signal, expectedStatus: 201, body: {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: html },
      associations: [{ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 228 }] }],
    } })
    try {
      if (!validId(created?.id)) malformed()
      const note = await readNote(created.id, id, signal)
      if (note.properties.hs_note_body !== html) malformed()
      await readTicket(id, { props: boundary, signal })
      // Return the single verified created note rather than requiring a full
      // history listing, which may exceed the bounded notes-list limit.
      return { id: note.id, note }
    } catch { fail(502, 'WRITE_OUTCOME_UNKNOWN') }
  }
  function parseRoute(method, rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length > 4096 || !rawUrl.startsWith('/') || rawUrl.startsWith('//')
      || /[\\\x00-\x20#]/.test(rawUrl) || /%2f|%5c|%2e|%00/i.test(rawUrl) || rawUrl.split('?')[0].split('/').some(part => part === '.' || part === '..')) invalid()
    const url = new URL(rawUrl, 'http://broker.invalid')
    if (url.pathname.includes('..') || url.pathname.includes('//')) invalid()
    const query = url.searchParams
    if ([...new Set(query.keys())].some(key => query.getAll(key).length !== 1)) invalid()
    const path = url.pathname
    let kind, id
    if (method === 'GET' && path === '/account-info/v3/details') kind = 'account'
    else if (method === 'GET' && path === `/crm/v3/pipelines/tickets/${config.pipelineId}`) kind = 'pipeline'
    else if (method === 'POST' && path === `${TICKETS}/search`) kind = 'search'
    else if (path === TICKETS && method === 'POST') kind = 'create'
    else if (path === TICKETS && method === 'GET') kind = 'archive-list'
    else if (/^\/springmath\/v1\/tickets\/[0-9]{1,30}\/notes$/.test(path) && config.notesEnabled) {
      id = path.split('/')[4]
      if (method === 'GET') kind = 'notes-list'
      else if (method === 'POST') kind = 'notes-create'
    }
    else if (path.startsWith(`${TICKETS}/`) && !path.slice(TICKETS.length + 1).includes('/')) {
      try { id = decodeURIComponent(path.slice(TICKETS.length + 1)) } catch { invalid() }
      const lookup = query.get('idProperty') === config.conversationProperty
      if (method === 'GET' && (ID.test(id) || (lookup && EXTERNAL_ID.test(id)))) kind = 'read'
      else if (ID.test(id) && method === 'PATCH') kind = 'update'
      else if (ID.test(id) && method === 'DELETE') kind = 'archive'
    }
    if (!kind) missing()
    const queryAllowed = kind === 'read' ? ['properties', 'archived', 'idProperty', 'verifyRequester']
      : kind === 'archive-list' ? ['properties', 'archived', 'limit', 'after'] : []
    if ([...query.keys()].some(key => !queryAllowed.includes(key))) invalid()
    return { kind, id, query }
  }
  async function handle({ method, url, body }) {
    const { kind, id, query } = parseRoute(method, url)
    if (!['create', 'update', 'search', 'notes-create'].includes(kind) && body !== undefined) invalid()
    const signal = AbortSignal.timeout(config.operationTimeoutMs)
    await account(signal)
    if (kind === 'account') return { status: 200, body: { portalId: Number(config.accountId) } }
    if (kind === 'pipeline') return { status: 200, body: await pipeline(signal) }
    if (kind === 'search') return { status: 200, body: await search(body, signal) }
    if (kind === 'archive-list') return { status: 200, body: await archivedList(query, signal) }
    if (kind === 'create') return { status: 201, body: await create(body, signal) }
    if (kind === 'update') return { status: 200, body: await update(id, body, signal) }
    if (kind === 'archive') { await archive(id, signal); return { status: 204 } }
    if (kind === 'notes-list') return { status: 200, body: await listNotes(id, signal) }
    if (kind === 'notes-create') return { status: 201, body: await createNote(id, body, signal) }
    const idProperty = query.get('idProperty') || undefined
    if (idProperty && idProperty !== config.conversationProperty) invalid()
    if (query.has('archived') && !['true', 'false'].includes(query.get('archived'))) invalid()
    if (query.has('verifyRequester') && query.get('verifyRequester') !== 'true') invalid()
    const verify = query.get('verifyRequester') === 'true'
    const props = properties(query.has('properties') ? query.get('properties').split(',') : undefined)
    const fetchProps = [...new Set([...props, ...(idProperty ? [idProperty] : []), ...(verify ? [config.requesterProperty] : [])])]
    const row = await readTicket(id, { props: fetchProps, archived: query.get('archived') === 'true', idProperty, associations: verify, signal })
    if (verify) await requesterVerified(row, signal)
    return { status: 200, body: { ...project(row, props), ...(verify ? { broker: { requesterAssociated: true } } : {}) } }
  }
  return { handle, ready: () => account(AbortSignal.timeout(config.upstreamTimeoutMs)) }
}
