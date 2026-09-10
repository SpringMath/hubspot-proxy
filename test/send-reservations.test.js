import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSendReservations } from '../src/send-reservations.js'
import { BrokerError } from '../src/errors.js'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)
const expected = (status, code) => error => {
  assert.ok(error instanceof BrokerError)
  assert.equal(error.status, status)
  assert.equal(error.code, code)
  assert.equal(error.message, code)
  assert.equal(error.cause, undefined)
  return true
}
const unavailable = expected(503, 'REPLY_RESERVATION_UNAVAILABLE')
const reserved = expected(409, 'REPLY_DISPATCH_ALREADY_RESERVED')

async function fixture(t) {
  // Resolve macOS's /var -> /private/var alias; production rejects aliases too.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'broker-reservations-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'claims')
  return { root, directory, store: createSendReservations(directory) }
}

test('readiness creates only the private final directory and no claim files', async t => {
  const { directory, store } = await fixture(t)
  assert.equal(await store.ready(), true)
  assert.equal(await store.ready(), true)
  assert.equal((await lstat(directory)).mode & 0o777, 0o700)
  assert.deepEqual(await readdir(directory), [])
})

test('reservation survives a new store instance and contains no identity or body data', async t => {
  const { directory, store } = await fixture(t)
  assert.equal(await store.reserve(KEY), true)
  const path = join(directory, `${KEY}.json`)
  assert.equal((await lstat(path)).mode & 0o777, 0o600)
  const contents = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(Object.keys(contents).sort(), ['reservedAt', 'state'])
  assert.equal(contents.state, 'reserved')
  assert.ok(Number.isFinite(Date.parse(contents.reservedAt)))
  await assert.rejects(createSendReservations(directory).reserve(KEY), reserved)
  assert.equal(await createSendReservations(directory).reserve(OTHER_KEY), true)
})

test('concurrent independent instances allow exactly one reservation', async t => {
  const { directory } = await fixture(t)
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => createSendReservations(directory).reserve(KEY)))
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  for (const result of outcomes.filter(outcome => outcome.status === 'rejected')) reserved(result.reason)
  assert.deepEqual(await readdir(directory), [`${KEY}.json`])
})

test('a new process cannot reserve a previously dispatched key', async t => {
  const { directory, store } = await fixture(t)
  await store.reserve(KEY)
  const moduleUrl = new URL('../src/send-reservations.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createSendReservations } from ${JSON.stringify(moduleUrl)}
    try { await createSendReservations(process.argv[1]).reserve(process.argv[2]); process.exitCode = 1 }
    catch (error) { process.exitCode = error.status === 409 && error.code === 'REPLY_DISPATCH_ALREADY_RESERVED' ? 0 : 2 }
  `, directory, KEY], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, '')
})

test('invalid keys are rejected before creating or opening the store', async t => {
  const { directory, store } = await fixture(t)
  for (const key of [null, 123, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '../secret', `${KEY}\n`, `${KEY}/x`]) {
    await assert.rejects(store.reserve(key), expected(400, 'INVALID_REQUEST'))
  }
  await assert.rejects(lstat(directory), { code: 'ENOENT' })
})

test('relative, root, unnormalized and missing-parent paths fail closed without exposing paths', async t => {
  const { root } = await fixture(t)
  for (const directory of [undefined, '', '/', 'relative', `${root}/../secret`, `${root}/claims/`, `${root}/missing/claims`, `${root}/secret\n`]) {
    const store = createSendReservations(directory)
    await assert.rejects(store.ready(), unavailable)
    await assert.rejects(store.reserve(KEY), unavailable)
  }
  assert.deepEqual(await readdir(root), [])
})

test('rejects a symlink store and symlink ancestors without touching their targets', async t => {
  const { root, directory } = await fixture(t)
  const target = join(root, 'target')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, directory)
  await assert.rejects(createSendReservations(directory).ready(), unavailable)
  await assert.rejects(createSendReservations(join(directory, 'nested')).reserve(KEY), unavailable)
  assert.deepEqual(await readdir(target), [])
})

test('existing non-directory and non-private stores are not repaired or overwritten', async t => {
  const { root } = await fixture(t)
  const file = join(root, 'file')
  await writeFile(file, 'private-storage-detail')
  await assert.rejects(createSendReservations(file).ready(), unavailable)
  assert.equal(await readFile(file, 'utf8'), 'private-storage-detail')
  const publicDirectory = join(root, 'public')
  await mkdir(publicDirectory, { mode: 0o755 })
  await chmod(publicDirectory, 0o755)
  await assert.rejects(createSendReservations(publicDirectory).reserve(KEY), unavailable)
  assert.deepEqual(await readdir(publicDirectory), [])
})

test('a symlink claim is treated as reserved and its destination is untouched', async t => {
  const { root, directory, store } = await fixture(t)
  await store.ready()
  const target = join(root, 'do-not-overwrite')
  await writeFile(target, 'unchanged')
  await symlink(target, join(directory, `${KEY}.json`))
  await assert.rejects(store.reserve(KEY), reserved)
  assert.equal(await readFile(target, 'utf8'), 'unchanged')
})

test('a replaced store directory is rejected by an already initialized instance', async t => {
  const { root, directory, store } = await fixture(t)
  await store.reserve(KEY)
  await rename(directory, join(root, 'original-claims'))
  await mkdir(directory, { mode: 0o700 })
  await assert.rejects(store.ready(), unavailable)
  await assert.rejects(store.reserve(OTHER_KEY), unavailable)
  assert.deepEqual(await readdir(directory), [])
})

test('read-only storage fails closed and does not broaden permissions', async t => {
  const { directory, store } = await fixture(t)
  await store.ready()
  await chmod(directory, 0o500)
  t.after(() => chmod(directory, 0o700).catch(() => {}))
  await assert.rejects(store.ready(), unavailable)
  await assert.rejects(store.reserve(KEY), unavailable)
  assert.equal((await lstat(directory)).mode & 0o777, 0o500)
})

test('failed file fsync retains the claim and returns a redacted unavailable error', async t => {
  const { directory, store } = await fixture(t)
  await store.ready()
  const sample = await open(directory, 'r')
  const prototype = Object.getPrototypeOf(sample)
  const sync = prototype.sync
  await sample.close()
  const mock = t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isFile()) throw new Error(`secret filesystem details ${directory}`)
    return sync.call(this)
  })
  await assert.rejects(store.reserve(KEY), unavailable)
  mock.mock.restore()
  assert.deepEqual(await readdir(directory), [`${KEY}.json`])
  await assert.rejects(createSendReservations(directory).reserve(KEY), reserved)
})

test('failed directory fsync blocks readiness without creating a real reservation', async t => {
  const { directory, store } = await fixture(t)
  await store.ready()
  const sample = await open(directory, 'r')
  const prototype = Object.getPrototypeOf(sample)
  await sample.close()
  t.mock.method(prototype, 'sync', async () => { throw new Error(`secret mount path ${directory}`) })
  await assert.rejects(store.ready(), unavailable)
  await assert.rejects(store.reserve(KEY), unavailable)
  assert.deepEqual(await readdir(directory), [])
})

test('directory durability must succeed after file fsync and an ambiguous claim is never released', async t => {
  const { directory, store } = await fixture(t)
  await store.ready()
  const sample = await open(directory, 'r')
  const prototype = Object.getPrototypeOf(sample)
  const sync = prototype.sync
  await sample.close()
  let fileSynced = false
  const mock = t.mock.method(prototype, 'sync', async function () {
    const stat = await this.stat()
    if (stat.isDirectory() && fileSynced) throw new Error(`private storage outage ${directory}`)
    await sync.call(this)
    if (stat.isFile()) fileSynced = true
  })
  await assert.rejects(store.reserve(KEY), unavailable)
  assert.equal(fileSynced, true)
  mock.mock.restore()
  assert.deepEqual(await readdir(directory), [`${KEY}.json`])
  await assert.rejects(createSendReservations(directory).reserve(KEY), reserved)
})

test('failed claim content write leaves its exclusive file in place', async t => {
  const { directory, store } = await fixture(t)
  await store.ready()
  const sample = await open(directory, 'r')
  const prototype = Object.getPrototypeOf(sample)
  await sample.close()
  const mock = t.mock.method(prototype, 'writeFile', async () => { throw new Error(`private storage full ${directory}`) })
  await assert.rejects(store.reserve(KEY), unavailable)
  mock.mock.restore()
  assert.deepEqual(await readdir(directory), [`${KEY}.json`])
  await assert.rejects(createSendReservations(directory).reserve(KEY), reserved)
})
