import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const deployment = Object.freeze({
  repository: 'SpringMath/hubspot-proxy', namespace: 'hubspot-proxy-demo',
  registry: '975774911479.dkr.ecr.ap-southeast-2.amazonaws.com/springmath-au-hubspot-proxy',
  marker: '<!-- claude-code-review:v1 -->',
})
// kubectl performs the YAML/Kustomize decoding locally. An empty JSON Patch
// preserves every resource, and JSONPath prints one compact JSON object per line.
export const renderArguments = Object.freeze([
  '--kubeconfig=/dev/null', 'patch', '--local=true', '--type=json', '--patch=[]',
  '--kustomize=k8s/overlays/au', '--output=jsonpath={@}{"\\n"}',
])
const shaPattern = /^[a-f0-9]{40}$/
const fail = message => { throw new Error(message) }

export function assertMain(env) {
  if (env.GITHUB_REPOSITORY !== deployment.repository || env.GITHUB_REF !== 'refs/heads/main'
    || !shaPattern.test(env.GITHUB_SHA || '')
    || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    fail('Deployment requires this repository, the main ref and an exact commit.')
  }
}

export function assertClaudeApproval(reviews, head, since) {
  if (!Array.isArray(reviews) || !shaPattern.test(head || '')) fail('Invalid review metadata.')
  const latest = reviews.filter(review => review.user?.login === 'claude[bot]' && review.state !== 'PENDING')
    .sort((a, b) => b.id - a.id)[0]
  if (latest?.state !== 'APPROVED' || latest.commit_id !== head
    || !(latest.body || '').split(/\r?\n/).some(line => line.trim() === deployment.marker)
    || (since && !(Date.parse(latest.submitted_at) >= Date.parse(since)))) {
    fail('A formal Claude APPROVED review on the exact current PR head is required.')
  }
}

export async function verifyMergedReview(env, request) {
  assertMain(env)
  const prefix = `/repos/${deployment.repository}`
  const associated = await request(`${prefix}/commits/${env.GITHUB_SHA}/pulls?per_page=100`)
  if (!Array.isArray(associated)) fail('Invalid merged PR metadata.')
  const matches = associated.filter(pr => pr.merge_commit_sha === env.GITHUB_SHA
    && pr.merged_at && pr.base?.ref === 'main' && pr.base?.repo?.full_name === deployment.repository)
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].number)) {
    fail('This main commit must be the merge of exactly one reviewed pull request; direct pushes cannot deploy.')
  }
  const pr = await request(`${prefix}/pulls/${matches[0].number}`)
  if (pr.merged !== true || pr.merge_commit_sha !== env.GITHUB_SHA || pr.base?.ref !== 'main'
    || pr.base?.repo?.full_name !== deployment.repository || pr.head?.repo?.full_name !== deployment.repository) {
    fail('The merged pull request does not match this deployment.')
  }
  assertClaudeApproval(await request(`${prefix}/pulls/${pr.number}/reviews?per_page=100`), pr.head.sha)
  // Squash and merge commits have different SHAs. Their complete source tree
  // must nevertheless be identical to the tree Claude actually reviewed.
  const reviewed = await request(`${prefix}/git/commits/${pr.head.sha}`)
  const merged = await request(`${prefix}/git/commits/${env.GITHUB_SHA}`)
  if (!shaPattern.test(reviewed?.tree?.sha || '') || reviewed.tree.sha !== merged?.tree?.sha) {
    fail('The deployment tree differs from the reviewed head; update the PR branch and obtain a fresh review.')
  }
  return { pullRequest: pr.number, reviewedHead: pr.head.sha, deploymentSha: env.GITHUB_SHA }
}

export function githubRequest(token, fetchImpl = fetch) {
  if (!token) fail('GitHub review verification credential is missing.')
  return async path => {
    if (!path.startsWith(`/repos/${deployment.repository}/`)) fail('Unsupported GitHub review request.')
    const response = await fetchImpl(`https://api.github.com${path}`, { redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15000) })
    if (!response.ok || /rel="next"/.test(response.headers.get('link') || '')) {
      fail('GitHub review metadata is unavailable or exceeds the safe verification limit.')
    }
    const text = await response.text()
    if (text.length > 2_000_000) fail('GitHub review metadata exceeds the safe response limit.')
    try { return JSON.parse(text) } catch { fail('GitHub returned invalid review metadata.') }
  }
}

export function secretManifest(env) {
  const token = env.HUBSPOT_ACCESS_TOKEN || ''
  const tokenHash = env.BROKER_TOKEN_SHA256 || ''
  if (token.length < 24 || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)
    || !/^[a-f0-9]{64}$/.test(tokenHash)) fail('Required broker deployment secrets are missing or malformed.')
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'hubspot-proxy-secrets', namespace: deployment.namespace },
    type: 'Opaque', data: {
      HUBSPOT_ACCESS_TOKEN: Buffer.from(token).toString('base64'),
      BROKER_TOKEN_SHA256: Buffer.from(tokenHash).toString('base64'),
    } }
}

export function renderDeployment(ndjson, env) {
  assertMain(env)
  const image = env.IMAGE_DIGEST || ''
  if (!new RegExp(`^${deployment.registry.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`).test(image)) {
    fail('An immutable digest from the dedicated AU broker ECR repository is required.')
  }
  const runId = env.GITHUB_RUN_ID || ''
  const attempt = env.GITHUB_RUN_ATTEMPT || ''
  if (!/^\d{1,30}$/.test(runId) || !/^\d{1,10}$/.test(attempt)) fail('GitHub deployment run identity is missing.')
  const allowed = new Map([['Deployment', 'apps/v1'], ['Service', 'v1'], ['ConfigMap', 'v1'],
    ['Ingress', 'networking.k8s.io/v1'], ['NetworkPolicy', 'networking.k8s.io/v1'], ['Certificate', 'cert-manager.io/v1']])
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const validName = value => typeof value === 'string' && value.length >= 1 && value.length <= 253
    && value.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(label))
  if (typeof ndjson !== 'string' || Buffer.byteLength(ndjson) > 1_000_000) fail('Invalid AU Kubernetes render.')
  const lines = ndjson.split(/\r?\n/).filter(line => line.trim())
  if (!lines.length || lines.length > 64) fail('Invalid AU Kubernetes render.')
  const resources = lines.map(line => {
    try { return JSON.parse(line) } catch { fail('Invalid AU Kubernetes render.') }
  })
  const identities = new Set()
  for (const resource of resources) {
    if (!isObject(resource) || typeof resource.apiVersion !== 'string' || typeof resource.kind !== 'string'
      || allowed.get(resource.kind) !== resource.apiVersion || !isObject(resource.metadata)
      || resource.metadata.namespace !== deployment.namespace || !validName(resource.metadata.name)) {
      fail('AU overlay must contain only approved namespace-scoped application resources.')
    }
    const identity = `${resource.apiVersion}/${resource.kind}/${resource.metadata.namespace}/${resource.metadata.name}`
    if (identities.has(identity)) fail('AU overlay contains duplicate resource identities.')
    identities.add(identity)
  }
  const brokers = resources.filter(resource => resource.kind === 'Deployment' && resource.metadata.name === 'hubspot-proxy')
  if (brokers.length !== 1) fail('AU overlay must contain exactly one hubspot-proxy Deployment.')
  const template = brokers[0].spec?.template
  const containers = template?.spec?.containers
  const annotations = template?.metadata?.annotations
  if (!Array.isArray(containers) || !containers.every(isObject)
    || containers.filter(container => container.name === 'broker').length !== 1 || !isObject(annotations)) {
    fail('AU overlay must contain one broker container and deployment revision annotation.')
  }
  const broker = containers.find(container => container.name === 'broker')
  if (broker.image !== 'HUBSPOT_PROXY_IMAGE'
    || annotations['springmath.io/deploy-revision'] !== 'HUBSPOT_PROXY_DEPLOY_REVISION') {
    fail('AU deployment placeholders must be at their approved image and pod annotation paths.')
  }
  const serialized = JSON.stringify(resources)
  for (const placeholder of ['HUBSPOT_PROXY_IMAGE', 'HUBSPOT_PROXY_DEPLOY_REVISION']) {
    if (serialized.split(placeholder).length !== 2) fail(`AU overlay must contain exactly one ${placeholder} placeholder.`)
  }
  broker.image = image
  annotations['springmath.io/deploy-revision'] = `${env.GITHUB_SHA}-${runId}-${attempt}`
  return JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources })
}

export function commandEnvironment(env) {
  const child = { ...env }
  // kubectl/AWS authentication still uses its short-lived OIDC environment;
  // application and review credentials are never inherited by subprocesses.
  for (const name of ['HUBSPOT_ACCESS_TOKEN', 'BROKER_TOKEN_SHA256', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) delete child[name]
  return child
}

function kubectl(args, input, env) {
  const result = spawnSync('kubectl', args, { input, encoding: 'utf8', timeout: 360000,
    maxBuffer: 2_000_000, env: commandEnvironment(env) })
  // Never echo kubectl diagnostics: admission/API errors can include submitted
  // Secret values. The operator can inspect resource events separately.
  if (result.error || result.status !== 0) fail('Kubernetes deployment command failed; no credentials were logged. Inspect the scoped deployment and events.')
  return result.stdout
}

export async function deploy(env, run = kubectl) {
  assertMain(env)
  const secret = secretManifest(env)
  const ndjson = run(renderArguments, undefined, env)
  const rendered = renderDeployment(ndjson, env)
  // Both payloads are stdin only. Server-side apply does not create the
  // last-applied-configuration annotation containing a second secret copy.
  const apply = ['apply', '--server-side', '--field-manager=hubspot-proxy-deploy', '--namespace', deployment.namespace, '-f', '-']
  run(apply, JSON.stringify(secret), env)
  run(apply, rendered, env)
  run(['--namespace', deployment.namespace, 'rollout', 'status', 'deployment/hubspot-proxy', '--timeout=180s'], undefined, env)
  run(['--namespace', deployment.namespace, 'wait', '--for=condition=Ready', 'certificate/hubspot-proxy-tls', '--timeout=300s'], undefined, env)
}

async function main() {
  if (process.argv[2] === 'verify-review') {
    const verified = await verifyMergedReview(process.env, githubRequest(process.env.GITHUB_TOKEN))
    console.log(`Claude-approved PR #${verified.pullRequest}; exact reviewed source tree verified for ${verified.deploymentSha}.`)
  } else if (process.argv.length === 2) {
    await deploy(process.env)
    console.log('AU broker resources applied and rollout ready. No HubSpot ticket writes or customer emails were performed.')
  } else fail('Unknown deployment command.')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
