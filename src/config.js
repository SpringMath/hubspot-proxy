import { isAbsolute, resolve } from 'node:path'

const propertyPattern = /^[a-z][a-z0-9_]{0,99}$/
const idPattern = /^[0-9]{1,30}$/

export function loadConfig(env = process.env) {
  const required = name => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`Missing configuration: ${name}`)
    return value
  }
  const property = name => {
    const value = required(name)
    if (!propertyPattern.test(value)) throw new Error(`Invalid property configuration: ${name}`)
    return value
  }
  const numericId = name => {
    const value = required(name)
    if (!idPattern.test(value)) throw new Error(`Invalid ID configuration: ${name}`)
    return value
  }
  const boolean = name => {
    if (env[name] && !['true', 'false'].includes(env[name])) throw new Error(`Invalid boolean: ${name}`)
    return env[name] === 'true'
  }
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name])
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid integer: ${name}`)
    return value
  }
  const tokenHash = required('BROKER_TOKEN_SHA256')
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('BROKER_TOKEN_SHA256 must be a lowercase SHA-256 hex digest')
  const scopeProperty = property('HUBSPOT_SCOPE_PROPERTY')
  const requesterProperty = property('HUBSPOT_REQUESTER_EMAIL_PROPERTY')
  const conversationProperty = property('HUBSPOT_CONVERSATION_ID_PROPERTY')
  const summaryProperty = property('HUBSPOT_SUMMARY_PROPERTY')
  const customProperties = [scopeProperty, requesterProperty, conversationProperty, summaryProperty]
  if (new Set(customProperties).size !== 4 || customProperties.some(p => p.startsWith('hs_') || ['subject', 'content', 'createdate', 'closed_date'].includes(p))) {
    throw new Error('Integration properties must be distinct custom HubSpot properties')
  }
  const scopeValue = required('HUBSPOT_SCOPE_VALUE')
  if (scopeValue.length > 200 || /[\x00-\x1f]/.test(scopeValue)) throw new Error('Invalid scope value')
  const stages = (env.BROKER_ALLOWED_STAGE_IDS || '').split(',').filter(Boolean)
  if (!stages.length || stages.some(id => !idPattern.test(id))) throw new Error('BROKER_ALLOWED_STAGE_IDS must contain explicit stage IDs')
  const writes = boolean('BROKER_ENABLE_WRITES')
  const notesEnabled = boolean('BROKER_ENABLE_NOTES')
  const repliesEnabled = boolean('BROKER_ENABLE_REPLIES')
  const immutable = boolean('BROKER_SCOPE_IS_IMMUTABLE')
  if (writes && !immutable) throw new Error('Writes require an operator assertion that the ownership marker is immutable')
  let inboxId, channelAccountId, senderActorId, sendReservationDir
  if (repliesEnabled) {
    inboxId = numericId('HUBSPOT_EMAIL_INBOX_ID')
    channelAccountId = numericId('HUBSPOT_EMAIL_CHANNEL_ACCOUNT_ID')
    senderActorId = required('HUBSPOT_EMAIL_SENDER_ACTOR_ID')
    if (!/^A-[0-9]{1,30}$/.test(senderActorId)) throw new Error('Invalid sending agent configuration')
    sendReservationDir = required('BROKER_SEND_RESERVATION_DIR')
    if (!isAbsolute(sendReservationDir) || sendReservationDir === '/' || resolve(sendReservationDir) !== sendReservationDir
      || /[\x00-\x1f\x7f]/.test(sendReservationDir)) throw new Error('Reply reservations require a normalized absolute persistent directory')
  }
  const closedStage = env.BROKER_CLOSED_STAGE_ID || undefined
  if (closedStage && !stages.includes(closedStage)) throw new Error('Closed stage must be allowed')
  const initialStage = numericId('BROKER_INITIAL_STAGE_ID')
  if (!stages.includes(initialStage)) throw new Error('Initial stage must be allowed')
  return Object.freeze({
    upstreamToken: required('HUBSPOT_ACCESS_TOKEN'),
    accountId: numericId('HUBSPOT_ACCOUNT_ID'), pipelineId: numericId('HUBSPOT_PIPELINE_ID'),
    tokenHash, scopeProperty, scopeValue, requesterProperty, conversationProperty,
    summaryProperty, stages, initialStage, closedStage, writes, immutable, notesEnabled,
    repliesEnabled, inboxId, channelAccountId, senderActorId, sendReservationDir,
    host: env.HOST || '127.0.0.1', port: integer('PORT', 8080, 1, 65535),
    maxSearchRecords: integer('BROKER_MAX_SEARCH_RECORDS', 1000, 1, 10000),
    maxBodyBytes: 65536, upstreamTimeoutMs: 10000, operationTimeoutMs: 45000,
    requestsPerMinute: integer('BROKER_REQUESTS_PER_MINUTE', 120, 1, 10000),
    readProperties: ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_lastmodifieddate',
      'createdate', 'hs_object_id', 'hs_ticket_priority', 'closed_date', ...customProperties],
  })
}
