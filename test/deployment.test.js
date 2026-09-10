import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
const deploymentObject = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'hubspot-proxy', namespace: deployment.namespace },
  spec: { template: {
    metadata: { annotations: { 'springmath.io/deploy-revision': 'HUBSPOT_PROXY_DEPLOY_REVISION' } },
    spec: { containers: [{ name: 'broker', image: 'HUBSPOT_PROXY_IMAGE' }] },
  } },
}
const configMap = { apiVersion: 'v1', kind: 'ConfigMap',
  metadata: { name: 'hubspot-proxy-config', namespace: deployment.namespace }, data: { MODE: 'demo' } }
const ndjson = (...objects) => `${objects.map(object => JSON.stringify(object)).join('\n')}\n`
const parseRender = output => {
  const list = JSON.parse(output)
  assert.equal(list.apiVersion, 'v1')
  assert.equal(list.kind, 'List')
  assert.ok(Array.isArray(list.items))
  return list.items
}
const fixtureRender = ndjson(deploymentObject)
const renderArgs = ['--kubeconfig=/dev/null', 'patch', '--local=true', '--type=json', '--patch=[]',
  '--kustomize=k8s/overlays/au', '--output=jsonpath={@}{"\\n"}']
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
  const first = renderDeployment(fixtureRender, env)
  const [object] = parseRender(first)
  assert.equal(object.spec.template.spec.containers[0].image, env.IMAGE_DIGEST)
  assert.equal(object.spec.template.metadata.annotations['springmath.io/deploy-revision'], `${sha}-1234-1`)
  assert.ok(!first.includes('HUBSPOT_PROXY_IMAGE'))
  assert.notEqual(renderDeployment(fixtureRender, { ...env, GITHUB_RUN_ATTEMPT: '2' }), first)
  assert.equal(deploymentObject.spec.template.spec.containers[0].image, 'HUBSPOT_PROXY_IMAGE')
  for (const image of [`${deployment.registry}:latest`, `elsewhere/image@sha256:${'d'.repeat(64)}`, '']) {
    assert.throws(() => renderDeployment(fixtureRender, { ...env, IMAGE_DIGEST: image }))
  }
})
test('overlay render rejects namespace/cluster RBAC/secrets and foreign API versions', () => {
  for (const kind of ['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding', 'Secret']) {
    assert.throws(() => renderDeployment(ndjson({ ...deploymentObject, kind }), env))
  }
  for (const apiVersion of ['v1', 'apps/v2', 'evil.example/apps/v1', '', null]) {
    assert.throws(() => renderDeployment(ndjson({ ...deploymentObject, apiVersion }), env))
  }
  assert.throws(() => renderDeployment(ndjson(deploymentObject, { ...configMap, apiVersion: 'evil.example/v1' }), env))
  assert.throws(() => renderDeployment(ndjson(deploymentObject, { apiVersion: 'apps', kind: 'v1/Deployment',
    metadata: { name: 'other', namespace: deployment.namespace } }), env))
})
test('overlay scope checks actual metadata.namespace, never a nested data.namespace lookalike', () => {
  for (const namespace of ['default', 'foreign', undefined, null, 7]) {
    const object = { ...configMap, metadata: { ...configMap.metadata, namespace },
      data: { namespace: deployment.namespace } }
    assert.throws(() => renderDeployment(ndjson(deploymentObject, object), env))
  }
  const object = { ...deploymentObject, metadata: { name: 'hubspot-proxy' },
    data: { namespace: deployment.namespace } }
  assert.throws(() => renderDeployment(ndjson(object), env))
})
test('overlay parsing rejects lists, nonobjects, malformed records and duplicate resource identities', () => {
  for (const value of [null, 1, 'Deployment', [], [deploymentObject],
    { apiVersion: 'v1', kind: 'List', items: [deploymentObject] }]) {
    assert.throws(() => renderDeployment(ndjson(value), env))
    assert.throws(() => renderDeployment(ndjson(deploymentObject, value), env))
  }
  for (const value of ['', '\n', '{"apiVersion":', `${fixtureRender}{bad}\n`,
    `${fixtureRender}# not a JSON record\n`]) assert.throws(() => renderDeployment(value, env))
  assert.throws(() => renderDeployment(ndjson(deploymentObject, deploymentObject), env))
  assert.throws(() => renderDeployment(ndjson(deploymentObject, configMap, { ...configMap, data: { MODE: 'other' } }), env))
})
test('render bounds count UTF-8 bytes and resource objects, with valid explicit names required', () => {
  const maps = Array.from({ length: 64 }, (_, index) => ({ ...configMap,
    metadata: { ...configMap.metadata, name: `hubspot-proxy-config-${index}` } }))
  assert.equal(parseRender(renderDeployment(ndjson(deploymentObject, ...maps.slice(0, 63)), env)).length, 64)
  assert.throws(() => renderDeployment(ndjson(deploymentObject, ...maps), env))
  const oversized = ndjson(deploymentObject, { ...configMap, data: { text: 'é'.repeat(500_001) } })
  assert.ok(oversized.length < 1_000_000)
  assert.ok(Buffer.byteLength(oversized) > 1_000_000)
  assert.throws(() => renderDeployment(oversized, env))
  for (const name of [undefined, null, '', 'foreign/name', '..', 'UPPERCASE', 'a'.repeat(64)]) {
    assert.throws(() => renderDeployment(ndjson(deploymentObject,
      { ...configMap, metadata: { namespace: deployment.namespace, name } }), env))
  }
})
test('placeholders are valid only at the broker Deployment image and exact pod revision annotation', () => {
  const mutations = [
    object => { object.metadata.name = 'other-deployment' },
    object => { object.spec.template.spec.containers[0].name = 'sidecar' },
    object => { object.spec.template.spec.containers.push({ name: 'broker', image: 'fixed:tag' }) },
    object => { object.spec.template.spec.containers.push({ name: 'sidecar', image: 'HUBSPOT_PROXY_IMAGE' }) },
    object => { object.spec.template.spec.containers[0].image = 'prefix-HUBSPOT_PROXY_IMAGE' },
    object => { object.spec.template.spec.containers[0].image = 'fixed:tag'; object.data = { image: 'HUBSPOT_PROXY_IMAGE' } },
    object => {
      delete object.spec.template.metadata.annotations['springmath.io/deploy-revision']
      object.metadata.annotations = { 'springmath.io/deploy-revision': 'HUBSPOT_PROXY_DEPLOY_REVISION' }
    },
    object => { object.spec.template.metadata.annotations['springmath.io/deploy-revision'] = 'missing' },
    object => { object.spec.template.metadata.annotations.other = 'HUBSPOT_PROXY_DEPLOY_REVISION' },
  ]
  for (const mutate of mutations) {
    const object = structuredClone(deploymentObject)
    mutate(object)
    assert.throws(() => renderDeployment(ndjson(object), env))
  }
  for (const placeholder of ['HUBSPOT_PROXY_IMAGE', 'HUBSPOT_PROXY_DEPLOY_REVISION']) {
    assert.throws(() => renderDeployment(ndjson(deploymentObject, { ...configMap, data: { message: placeholder } }), env))
  }
})
test('multiline strings cannot spoof resource metadata and are preserved without textual substitutions', () => {
  const message = 'Example only:\nkind: Secret\nmetadata:\n  namespace: foreign\n---\napiVersion: evil/v1\n'
  const object = { ...configMap, data: { message, namespace: 'not-resource-metadata' } }
  const output = parseRender(renderDeployment(ndjson(deploymentObject, object), env))
  assert.deepEqual(output[1], object)
  assert.equal(output[1].data.message, message)
  assert.equal(output[0].spec.template.spec.containers[0].image, env.IMAGE_DIGEST)
})
test('application/review secrets are not inherited by kubectl children but OIDC AWS credentials remain usable', () => {
  const child = commandEnvironment({ ...env, AWS_ACCESS_KEY_ID: 'oidc-fixture', GITHUB_TOKEN: 'gh-fixture', ANTHROPIC_API_KEY: 'ai-fixture' })
  for (const name of ['HUBSPOT_ACCESS_TOKEN', 'BROKER_TOKEN_SHA256', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(child[name], undefined)
  assert.equal(child.AWS_ACCESS_KEY_ID, 'oidc-fixture')
})
test('deployment pipes secrets over stdin with server-side apply and no raw bearer or secret CLI arguments', async () => {
  const commands = []
  await deploy(env, (args, input) => { commands.push({ args, input }); return args.includes('--local=true') ? fixtureRender : '' })
  assert.deepEqual(commands[0].args, renderArgs)
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
  await assert.rejects(deploy({ ...env, IMAGE_DIGEST: 'bad' }, args => { commands.push(args); return fixtureRender }))
  assert.deepEqual(commands, [renderArgs])
})
test('all rendered objects are validated before the first secret or resource write', async () => {
  for (const invalidRender of [ndjson(deploymentObject, { ...configMap, metadata: { name: 'bad' },
    data: { namespace: deployment.namespace } }), `${fixtureRender}{bad}\n`,
  ndjson(deploymentObject, configMap, configMap)]) {
    const commands = []
    await assert.rejects(deploy(env, (args, input) => { commands.push({ args, input }); return invalidRender }))
    assert.deepEqual(commands, [{ args: renderArgs, input: undefined }])
  }
})
test('real kubectl renders the complete AU overlay locally with an unreachable API endpoint', context => {
  const result = spawnSync('kubectl', [...renderArgs, '--server=http://127.0.0.1:1', '--request-timeout=1s'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000, maxBuffer: 2_000_000,
    env: { PATH: process.env.PATH },
  })
  if (result.error?.code === 'ENOENT' && process.env.GITHUB_ACTIONS !== 'true') {
    context.skip('kubectl is not installed'); return
  }
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const rendered = parseRender(renderDeployment(result.stdout, env))
  assert.ok(rendered.length >= 6)
  assert.ok(rendered.every(object => object.metadata.namespace === deployment.namespace))
  assert.ok(rendered.some(object => object.kind === 'Certificate' && object.apiVersion === 'cert-manager.io/v1'))
  assert.ok(rendered.some(object => object.kind === 'Ingress' && object.apiVersion === 'networking.k8s.io/v1'))
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
