import { pathToFileURL } from 'node:url'

const origin = 'https://hubspotproxy.springmath.au'
export async function smoke(fetchImpl = fetch) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled for the AU smoke test.')
  const cases = [['/healthz', 200], ['/readyz', 200], ['/account-info/v3/details', 401]]
  for (const [path, status] of cases) {
    // Native fetch verifies public TLS. Do not disable certificate checks or
    // follow redirects; an incorrect host must not pass the smoke test.
    const response = await fetchImpl(origin + path, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000) })
    if (response.status !== status) {
      await response.body?.cancel()
      throw new Error(`AU broker smoke failed for ${path}: expected HTTP ${status}, got ${response.status}.`)
    }
    if (status === 200) {
      const result = await response.json()
      if (result?.ok !== true) throw new Error(`AU broker ${path} did not report readiness.`)
    } else await response.body?.cancel()
  }
  return { tlsVerified: true, liveness: true, readiness: true, unauthenticatedRejected: true }
}
async function main() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await smoke()
      console.log('Public TLS, health/readiness and unauthenticated 401 verified. No authenticated data or writes exercised.')
      return
    } catch (error) {
      if (attempt === 6) throw error
      // Initial certificate/DNS reconciliation can lag the pod rollout. These
      // retries are strictly unauthenticated GETs, never ticket operations.
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
