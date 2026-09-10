import { constants } from 'node:fs'
import { access, lstat, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { BrokerError } from './errors.js'

const KEY = /^[a-f0-9]{64}$/
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const claimFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const unavailable = () => new BrokerError(503, 'REPLY_RESERVATION_UNAVAILABLE')
const sameDirectory = (left, right) => left.dev === right.dev && left.ino === right.ino

// This store requires a trusted, persistent local filesystem. A host/storage
// administrator can remove claims; Node does not expose openat-style operations
// to protect against a hostile ancestor being swapped between filesystem calls.
// Never delete, expire or release a reservation, including after failed sends.
export function createSendReservations(directory) {
  let identity

  function validatePath() {
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory !== resolve(directory)
      || directory === parse(directory).root || /[\x00-\x1f\x7f]/.test(directory)) throw unavailable()
  }

  async function realDirectories(path) {
    let current = parse(path).root
    for (const component of path.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, component)
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
    }
  }

  async function inspect() {
    await realDirectories(directory)
    const stat = await lstat(directory)
    // A dedicated child of an fsGroup-owned volume can be created by the
    // unprivileged service, without making the reservation store group-readable.
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || typeof process.getuid !== 'function' || stat.uid !== process.getuid()
      || (identity && !sameDirectory(identity, stat))) throw unavailable()
    return stat
  }

  async function withDirectory(operation) {
    let handle
    try {
      validatePath()
      const parent = dirname(directory)
      // Only the final component may be created. Missing parents, relative
      // paths and even otherwise harmless symlink ancestors fail closed.
      await realDirectories(parent)
      try { await mkdir(directory, { mode: 0o700 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      const stat = await inspect()
      handle = await open(directory, directoryFlags)
      const opened = await handle.stat()
      if (!opened.isDirectory() || !sameDirectory(stat, opened)) throw unavailable()
      identity ??= opened
      // Persist a newly created directory's parent entry, including concurrent
      // initialization where another caller observed mkdir's EEXIST result.
      const parentHandle = await open(parent, directoryFlags)
      try { await parentHandle.sync() }
      finally { await parentHandle.close() }
      await access(directory, constants.W_OK | constants.X_OK)
      await handle.sync()
      await inspect()
      return await operation(handle)
    } finally {
      await handle?.close()
    }
  }

  async function guarded(operation) {
    try { return await withDirectory(operation) }
    catch (error) {
      if (error instanceof BrokerError && error.code === 'REPLY_DISPATCH_ALREADY_RESERVED') throw error
      // Raw filesystem errors can contain the absolute path or storage details.
      // No vendor data, caller key, filesystem path or original cause escapes.
      throw unavailable()
    }
  }

  return {
    async ready() {
      await guarded(async () => {})
      return true
    },
    async reserve(key) {
      if (typeof key !== 'string' || !KEY.test(key)) throw new BrokerError(400, 'INVALID_REQUEST')
      await guarded(async handle => {
        let claim
        try {
          await inspect()
          try { claim = await open(join(directory, `${key}.json`), claimFlags, 0o600) }
          catch (error) {
            if (error.code === 'EEXIST') throw new BrokerError(409, 'REPLY_DISPATCH_ALREADY_RESERVED')
            throw error
          }
          const stat = await claim.stat()
          if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
            || stat.uid !== process.getuid()) throw unavailable()
          await claim.writeFile(JSON.stringify({ state: 'reserved', reservedAt: new Date().toISOString() }) + '\n')
          await claim.sync()
          // fsync the file AND its directory before any upstream dispatch.
          await handle.sync()
          await inspect()
        } finally {
          await claim?.close()
        }
      })
      return true
    },
  }
}
