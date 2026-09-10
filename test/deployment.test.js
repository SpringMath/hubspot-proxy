import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertMain, assertClaudeApproval, verifyMergedReview, githubRequest, secretManifest,
  renderDeployment, commandEnvironment, deploy, deployment } from '../scripts/deploy-au.mjs'
import { smoke } from '../scripts/smoke-au.mjs'

const sha = 'a'.repeat(40)
const head = 'b'.repeat(40)
const tree = 'c'.repeat(40)
const env = { GITHUB_REPOSITORY: deployment.repository, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
  GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1',
  IMAGE_DIGEST: `${deployment.registry}@sha256:${'d'.repeat(64)}`,
  HUBSPOT_ACCESS_TOKEN: 'fixture-only-upstream-token-not-real', BROKER_TOKEN_SHA256: 'e'.repeat(64) }
const review = { id: 10, user: { login: 'claude[bot]' }, state: 'APPROVED', commit_id: head,
  submitted_at: '2026-09-10T13:00:00Z', body: `Reviewed.\n${deployment.marker}` }
const pr = { number: 1, merged: true, merged_at: '2026-09-10T14:00:00Z', merge_commit_sha: sha,
  base: { ref: 'main', repo: { full_name: deployment.repository } }, head: { sha: head, repo: { full_name: deployment.repository } } }
const yaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: hubspot-proxy
  namespace: hubspot-proxy-demo
spec:
  template:
    metadata:
      annotations:
        springmath.io/deploy-revision: HUBSPOT_PROXY_DEPLOY_REVISION
    spec:
      containers:
        - name: broker
          image: HUBSPOT_PROXY_IMAGE
`
function fixtureRequest(overrides = {}) {
  const prefix = `/repos/${deployment.repository}`
  const data = { [`${prefix}/commits/${sha}/pulls?per_page=100`]: [pr], [`${prefix}/pulls/1`]: pr,
    [`${prefix}/pulls/1/reviews?per_page=100`]: [review], [`${prefix}/git/commits/${head}`]: { tree: { sha: tree } },
    [`${prefix}/git/commits/${sha}`]: { tree: { sha: tree } }, ...overrides }
  return async path => {
    assert.ok(Object.hasOwn(data, path), `Unexpected review endpoint ${path}`)
    return data[path]
  }
}
test('deployment is restricted to this repository, main and a known push/dispatch commit', () => {
  assertMain(env)
  assertMain({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' })
  for (const [key, value] of [['GITHUB_REPOSITORY', 'other/repo'], ['GITHUB_REF', 'refs/pull/1/merge'],
    ['GITHUB_SHA', 'main'], ['GITHUB_EVENT_NAME', 'pull_request']]) {
    assert.throws(() => assertMain({ ...env, [key]: value }))
  }
})
test('only a current formal Claude approval passes, never generic CI or Gitar approval', () => {
  assertClaudeApproval([review], head)
  for (const change of [{ user: { login: 'gitar-bot' } }, { state: 'COMMENTED' }, { state: 'DISMISSED' },
    { state: 'CHANGES_REQUESTED' }, { commit_id: sha }, { body: 'Looks good' }]) {
    assert.throws(() => assertClaudeApproval([{ ...review, ...change }], head))
  }
  assert.throws(() => assertClaudeApproval([review, { ...review, id: 11, state: 'CHANGES_REQUESTED' }], head))
  assert.throws(() => assertClaudeApproval([review], head, '2026-09-10T13:01:00Z'))
})
test('squash merge deploys only when the entire source tree matches the Claude-reviewed head', async () => {
  assert.deepEqual(await verifyMergedReview(env, fixtureRequest()), { pullRequest: 1, reviewedHead: head, deploymentSha: sha })
  await assert.rejects(verifyMergedReview(env, fixtureRequest({
    [`/repos/${deployment.repository}/git/commits/${sha}`]: { tree: { sha: 'f'.repeat(40) } },
  })), /differs from the reviewed head/)
})
test('direct main pushes, foreign repositories and ambiguous PR associations cannot deploy', async () => {
  const key = `/repos/${deployment.repository}/commits/${sha}/pulls?per_page=100`
  for (const value of [[], [pr, { ...pr, number: 2 }], [{ ...pr, merged_at: null }]]) {
    await assert.rejects(verifyMergedReview(env, fixtureRequest({ [key]: value })))
  }
  await assert.rejects(verifyMergedReview(env, fixtureRequest({
    [`/repos/${deployment.repository}/pulls/1`]: { ...pr, head: { ...pr.head, repo: { full_name: 'other/repo' } } },
  })))
})
test('GitHub metadata fetch is fixed-origin, authenticated and refuses redirects or partial review lists', async () => {
  let called
  const request = githubRequest('fixture-gh', async (url, options) => {
    called = { url, options }
    return new Response(JSON.stringify([]), { status: 200 })
  })
  await request(`/repos/${deployment.repository}/pulls/1/reviews?per_page=100`)
  assert.ok(called.url.startsWith('https://api.github.com/repos/SpringMath/hubspot-proxy/'))
  assert.equal(called.options.redirect, 'error')
  assert.equal(called.options.headers.Authorization, 'Bearer fixture-gh')
  await assert.rejects(request('/repos/other/repo/pulls'))
  for (const response of [new Response('{}', { status: 403 }), new Response('[]', {
    status: 200, headers: { link: '<https://api.github.com/page2>; rel="next"' },
  }), new Response('not-json', { status: 200 })]) {
    await assert.rejects(githubRequest('fixture-gh', async () => response)(`/repos/${deployment.repository}/pulls/1`))
  }
})
test('secret manifest contains only the upstream token and hash, with no last-applied annotation', () => {
  const secret = secretManifest(env)
  assert.equal(secret.metadata.namespace, deployment.namespace)
  assert.equal(secret.metadata.name, 'hubspot-proxy-secrets')
  assert.equal(secret.metadata.annotations, undefined)
  assert.deepEqual(Object.keys(secret.data).sort(), ['BROKER_TOKEN_SHA256', 'HUBSPOT_ACCESS_TOKEN'])
  assert.equal(Buffer.from(secret.data.HUBSPOT_ACCESS_TOKEN, 'base64').toString(), env.HUBSPOT_ACCESS_TOKEN)
  for (const change of [{ HUBSPOT_ACCESS_TOKEN: '' }, { HUBSPOT_ACCESS_TOKEN: 'bad\ntoken'.repeat(5) },
    { BROKER_TOKEN_SHA256: 'raw-broker-token' }]) assert.throws(() => secretManifest({ ...env, ...change }))
})
test('deploy render pins the exact ECR digest and restarts pods on each rerun without changing source', () => {
  const first = renderDeployment(yaml, env)
  assert.ok(first.includes(env.IMAGE_DIGEST))
  assert.ok(first.includes(`${sha}-1234-1`))
  assert.ok(!first.includes('HUBSPOT_PROXY_IMAGE'))
  assert.notEqual(renderDeployment(yaml, { ...env, GITHUB_RUN_ATTEMPT: '2' }), first)
  for (const image of [`${deployment.registry}:latest`, `elsewhere/image@sha256:${'d'.repeat(64)}`, '']) {
    assert.throws(() => renderDeployment(yaml, { ...env, IMAGE_DIGEST: image }))
  }
})
test('overlay render cannot apply namespace/cluster RBAC/secrets, other namespaces or duplicate placeholders', () => {
  for (const kind of ['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding', 'Secret']) {
    assert.throws(() => renderDeployment(yaml.replace('kind: Deployment', `kind: ${kind}`), env))
  }
  assert.throws(() => renderDeployment(yaml.replace('namespace: hubspot-proxy-demo', 'namespace: default'), env))
  assert.throws(() => renderDeployment(`${yaml}\n# HUBSPOT_PROXY_IMAGE`, env))
  assert.throws(() => renderDeployment(yaml.replace('HUBSPOT_PROXY_DEPLOY_REVISION', 'missing'), env))
})
test('application/review secrets are not inherited by kubectl children but OIDC AWS credentials remain usable', () => {
  const child = commandEnvironment({ ...env, AWS_ACCESS_KEY_ID: 'oidc-fixture', GITHUB_TOKEN: 'gh-fixture', ANTHROPIC_API_KEY: 'ai-fixture' })
  for (const name of ['HUBSPOT_ACCESS_TOKEN', 'BROKER_TOKEN_SHA256', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(child[name], undefined)
  assert.equal(child.AWS_ACCESS_KEY_ID, 'oidc-fixture')
})
test('deployment pipes secrets over stdin with server-side apply and no raw bearer or secret CLI arguments', async () => {
  const commands = []
  await deploy(env, (args, input) => { commands.push({ args, input }); return args[0] === 'kustomize' ? yaml : '' })
  assert.deepEqual(commands[0].args, ['kustomize', 'k8s/overlays/au'])
  assert.equal(commands.length, 5)
  for (const command of commands.slice(1, 3)) {
    assert.ok(command.args.includes('--server-side'))
    assert.ok(command.args.includes('--field-manager=hubspot-proxy-deploy'))
    assert.ok(command.args.includes('-'))
    assert.ok(!command.args.join(' ').includes(env.HUBSPOT_ACCESS_TOKEN))
  }
  assert.equal(JSON.parse(commands[1].input).kind, 'Secret')
  assert.ok(commands[3].args.includes('deployment/hubspot-proxy'))
  assert.ok(commands[4].args.includes('certificate/hubspot-proxy-tls'))
})
test('invalid deployment input fails before any Kubernetes mutation', async () => {
  const commands = []
  await assert.rejects(deploy({ ...env, IMAGE_DIGEST: 'bad' }, args => { commands.push(args); return yaml }))
  assert.deepEqual(commands, [['kustomize', 'k8s/overlays/au']])
})
test('public smoke makes unauthenticated read-only requests over pinned HTTPS and requires 401 for protected APIs', async () => {
  const calls = []
  const result = await smoke(async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ ok: true }), { status: url.endsWith('/details') ? 401 : 200 })
  })
  assert.equal(result.unauthenticatedRejected, true)
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.ok(call.url.startsWith('https://hubspotproxy.springmath.au/'))
    assert.equal(call.options.method, 'GET')
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.headers, undefined)
  }
  await assert.rejects(smoke(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })), /expected HTTP 401/)
  await assert.rejects(smoke(async () => new Response(JSON.stringify({ ok: false }), { status: 200 })), /did not report readiness/)
})
test('deployment workflow uses OIDC, main-only environment, ARM64 digest output and only two broker secrets', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-au.yml', import.meta.url), 'utf8')
  for (const value of ['branches: [main]', "github.ref == 'refs/heads/main'", 'environment: australia-demo',
    'id-token: write', 'role/hubspot-proxy-github-deploy-au', 'linux/arm64', 'steps.image.outputs.digest',
    'node scripts/deploy-au.mjs verify-review']) assert.ok(workflow.includes(value), value)
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]).sort(), ['BROKER_TOKEN_SHA256', 'HUBSPOT_ACCESS_TOKEN'])
  assert.ok(!workflow.includes('BROKER_ACCESS_TOKEN'))
})
test('Claude workflow requires a genuine current-head formal review rather than successful invocation', () => {
  const workflow = readFileSync(new URL('../.github/workflows/claude-pr-review.yml', import.meta.url), 'utf8')
  for (const value of ["latest?.state === 'APPROVED'", 'latest.commit_id === pr.head.sha', "review.user?.login === 'claude[bot]'",
    'REVIEW_STARTED_AT', deployment.marker, 'secrets.ANTHROPIC_API_KEY', 'head.repo.full_name == github.repository']) assert.ok(workflow.includes(value), value)
})
function reviewWorkflowJob(workflow, name) {
  const marker = `  ${name}:\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `Missing separate ${name} job`)
  const remainder = workflow.slice(start + marker.length)
  const next = remainder.search(/^  [a-zA-Z0-9_-]+:\s*$/m)
  return next === -1 ? remainder : remainder.slice(0, next)
}
test('Claude approval gate runs even when fork analysis is skipped and never receives secrets or repository code', () => {
  const workflow = readFileSync(new URL('../.github/workflows/claude-pr-review.yml', import.meta.url), 'utf8')
  const analysis = reviewWorkflowJob(workflow, 'claude-analysis')
  assert.ok(analysis.includes('head.repo.full_name == github.repository'))
  assert.ok(analysis.includes('github.event.pull_request.draft == false'))
  assert.ok(analysis.includes('secrets.ANTHROPIC_API_KEY'))

  const gate = reviewWorkflowJob(workflow, 'claude-review')
  assert.match(gate, /^    if: always\(\)\s*$/m)
  assert.match(gate, /^    needs: \[repository-tests, claude-analysis\]\s*$/m)
  assert.ok(gate.includes('needs.claude-analysis.result'))
  assert.ok(gate.includes('needs.claude-analysis.outputs.'))
  assert.ok(gate.includes('needs.repository-tests.result'))
  assert.doesNotMatch(gate, /claude-analysis\.outputs\.test_outcome|steps\.tests\.outcome/)
  assert.ok(gate.includes("'success'"))
  assert.ok(gate.includes('pull-requests: read'))
  assert.ok(gate.includes("latest?.state === 'APPROVED'"))
  assert.ok(gate.includes('latest.commit_id === pr.head.sha'))
  assert.doesNotMatch(gate, /secrets\.|actions\/checkout@|actions\/setup-node@|anthropics\/claude-code-action@/)
  assert.doesNotMatch(gate, /^\s+(?:run:|(?:contents|pull-requests|issues|id-token|actions): write)/m)
})
test('repository tests cannot poison the credentialed Claude runner or mint OIDC credentials', () => {
  const workflow = readFileSync(new URL('../.github/workflows/claude-pr-review.yml', import.meta.url), 'utf8')
  const tests = reviewWorkflowJob(workflow, 'repository-tests')
  assert.match(tests, /^    runs-on: ubuntu-24\.04\s*$/m)
  assert.match(tests, /    permissions:\n      contents: read\n    steps:/)
  assert.ok(tests.includes('persist-credentials: false'))
  assert.ok(tests.includes('npm run check'))
  assert.ok(tests.includes('npm test'))
  assert.doesNotMatch(tests, /secrets\.|id-token:|anthropics\/claude-code-action@|continue-on-error:/)

  const analysis = reviewWorkflowJob(workflow, 'claude-analysis')
  assert.match(analysis, /^    needs: repository-tests\s*$/m)
  assert.match(analysis, /^    runs-on: ubuntu-24\.04\s*$/m)
  assert.ok(analysis.includes('persist-credentials: false'))
  assert.doesNotMatch(analysis, /persist-credentials: true|actions\/download-artifact@/)
  const runBlocks = [...analysis.matchAll(/^        run: ([\s\S]*?)(?=^      - |(?![\s\S]))/gm)]
  assert.equal(runBlocks.length, 1, 'The credentialed job may only run its fixed review-start timestamp command')
  assert.match(runBlocks[0][1].split('\n')[0], /^printf 'at=%s\\n'/)
  assert.doesNotMatch(runBlocks[0][1], /(?:npm|node|bun|yarn|pnpm)\s|scripts\//)
  assert.doesNotMatch(analysis, /^\s+github_token:/m)
  assert.ok(analysis.includes('id-token: write'))
  assert.ok(analysis.includes('secrets.ANTHROPIC_API_KEY'))
})
