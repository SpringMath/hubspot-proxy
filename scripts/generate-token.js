import { createHash, randomBytes } from 'node:crypto'

// Intentionally emits a NEW credential only when an operator explicitly runs it.
// Redirect to a permission-restricted secret file; never commit or log the output.
const token = `smhb_${randomBytes(32).toString('base64url')}`
process.stdout.write(JSON.stringify({
  brokerToken: token,
  BROKER_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
}, null, 2) + '\n')
