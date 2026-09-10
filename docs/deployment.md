# Deploying the HubSpot broker

The first installation is a **private, synthetic-data demonstration in
SpringMath's cluster using SpringMath's HubSpot account**. It does not secure an
Ochre token while that token remains accessible to SpringMath. For the intended
security boundary, **Ochre operates the broker, retains its HubSpot token, and
gives SpringMath only the broker bearer token**. Ochre also owns the deployment,
secret store, policy configuration, logs, and administrative access.

This is a deliberately limited HubSpot-shaped support API, not an unrestricted
HTTP proxy. Review the [README](../README.md) endpoint contract before connecting
an existing client. Do not redirect a general-purpose HubSpot integration here.

## 1. Agree the boundary

Have the HubSpot account owner approve these values:

| Configuration | Meaning |
| --- | --- |
| `HUBSPOT_ACCOUNT_ID` | The one expected HubSpot account. |
| `HUBSPOT_PIPELINE_ID` | The one permitted support pipeline. |
| `HUBSPOT_SCOPE_PROPERTY` / `HUBSPOT_SCOPE_VALUE` | Dedicated, immutable ticket brand marker, checked in addition to pipeline. |
| `HUBSPOT_REQUESTER_EMAIL_PROPERTY` | Ticket property holding the authenticated requester's email. |
| `HUBSPOT_CONVERSATION_ID_PROPERTY` | Ticket property holding the originating app conversation identifier. |
| `HUBSPOT_SUMMARY_PROPERTY` | Shared support summary; never an internal-only notes field. |
| `BROKER_ENABLE_NOTES` | Default `false`. Optional ticket-bound native CRM notes; POST also requires write/immutable-scope gates. No generic note or email API. |
| `BROKER_ALLOWED_STAGE_IDS` | Comma-separated status IDs callers may use. |
| `BROKER_INITIAL_STAGE_ID` | Required creation stage; must be in the permitted set. |
| `BROKER_CLOSED_STAGE_ID` | Optional verified Closed status ID for resolution. |
| `BROKER_MAX_SEARCH_RECORDS` | Bounded candidate scan, default `1000`; applies to archive scans too. |

Use a stable brand marker as the security boundary, not ticket subject text,
current owner, status, or a mutable workflow tag. The pipeline is an additional
check, not a substitute. Existing tickets without the marker stay inaccessible.
The broker does not automatically claim or backfill old tickets.

`BROKER_SCOPE_IS_IMMUTABLE=false` prevents enabling writes. Change it to
`true` **only after** the account owner has ensured other integrations, workflows,
and users cannot reclassify a ticket's marker or concurrently move it out of the
permitted pipeline. Ordinary status changes within that pipeline are fine.
This flag is an operator attestation,
not a HubSpot permission feature. If that guarantee is impossible, do not use this
design with multi-brand production data: concurrent reclassification can defeat
any read-then-write check. Agree a stronger account or ownership boundary first.
For intentional reassignment, disable access/writes, drain in-flight operations,
perform the move, and only then re-enable the reviewed policy. A post-write
verification cannot undo a write that raced a pipeline change.

Search and archive pagination are bounded and scoped by the broker. Large queues
can return a service-unavailable error rather than incomplete results. Numeric
pagination offsets are broker offsets, not HubSpot cursors. No global ticket count
or upstream cursor should be exposed. Assess queue size and performance using
synthetic data before raising the scan bound.

## 2. Provision credentials privately

There are two different credentials:

- `HUBSPOT_ACCESS_TOKEN`: account owner's HubSpot service key, held only by the
  broker. Grant only scopes needed by the implemented endpoint contract.
- SpringMath's **broker bearer token**: independently generated with at least
  32 random bytes. Store its SHA-256 hex digest as `BROKER_TOKEN_SHA256` in the
  broker, and give the raw token only to the approved client through a secret
  manager. The raw broker token does not belong in the broker's configuration.

Use a password manager or secret manager to generate and transfer credentials.
Never commit a filled Secret manifest, put a token in a URL, include tokens in
shell command arguments, or use `set -x`. Do not copy the credentials into chat,
issue descriptions, logs, screenshots, or a `.env` inside the repository.

The supplied generator emits a JSON object with the raw bearer and its SHA-256
digest. Redirect it to a new protected file instead of printing it into a shared
terminal. Use the script directly so npm's informational output is not mixed
into the JSON. The subshell below refuses to overwrite an existing file:

```sh
(
  umask 077
  set -C
  node scripts/generate-token.js > /secure/path/hubspot-proxy.generated.json
)
```

Import those two values into the appropriate secret stores, then remove the
temporary file according to your organization's secret-handling policy. Do not
retain the raw bearer on the broker host once client provisioning is complete.

For a local demonstration, create a permissions-`0600` file **outside the repo**
using a trusted editor or secret-manager export. For Kubernetes, the file needs
only these two entries (the placeholders below are not working credentials):

```dotenv
HUBSPOT_ACCESS_TOKEN=REPLACE_USING_YOUR_SECRET_MANAGER
BROKER_TOKEN_SHA256=REPLACE_WITH_BROKER_TOKEN_SHA256_HEX
```

To hash a broker token already stored in a protected file, this command reads it
without putting the token in the command line and prints **only its digest**:

```sh
node -e 'const fs = require("node:fs"); const crypto = require("node:crypto"); const token = fs.readFileSync(process.argv[1], "utf8").trim(); if (token.length < 32) throw new Error("Use a securely generated token"); console.log(crypto.createHash("sha256").update(token).digest("hex"))' /secure/path/broker.token
```

Length alone does not establish randomness. Generate the token from a
cryptographically secure source; do not choose a human password.

For production, prefer Ochre's existing secret-management integration. Kubernetes
Secrets are not inherently encrypted simply because their API representation is
base64. Enable encryption at rest and narrow secret-reader/RBAC permissions.
Anyone who can read the HubSpot secret or execute commands in the broker pod has
access outside the broker policy. SpringMath must not retain that access in
Ochre's deployment.

## 3. Run checks and a local demonstration

Use Node.js 24. There are no runtime package dependencies.

```sh
npm run check
npm test
```

For a local server, make a separate protected env file outside the repo containing
the two secret entries plus the policy values from step 1. Set `HOST=127.0.0.1`,
`PORT=8080`, and `BROKER_ENABLE_WRITES=false`. Start it with:

```sh
node --env-file=/secure/path/hubspot-proxy.local.env src/server.js
```

Check liveness and authenticated upstream readiness without printing config:

```sh
curl --fail-with-body http://127.0.0.1:8080/healthz
curl --fail-with-body http://127.0.0.1:8080/readyz
```

Readiness verifies the expected upstream account; it is not evidence that email
notifications, every HubSpot scope, or business workflow has been configured.
It should fail closed for invalid credentials or an unexpected account. Liveness
does not require HubSpot to be available.

Use the README's endpoint examples for ticket reads. For real credentials, keep
the Authorization header in a permissions-`0600` curl config outside the repo,
then pass `curl --config /secure/path/broker-curl.conf ...`. Avoid `curl -v`,
request tracing, or printing customer ticket bodies into shared terminals.

Before enabling any writes, verify:

1. Missing and incorrect broker tokens cannot read tickets.
2. The approved synthetic ticket can be read.
3. An explicitly designated out-of-scope synthetic ticket cannot be read, updated,
   archived, or discovered in a search; no other-brand fields appear in errors.
4. Generic contacts, batch, association, schema-write, and unrelated HubSpot routes
   are denied rather than transparently forwarded.
5. Attempts to change the immutable brand marker or pipeline fail.
6. Test cases above remain true when search filters and pagination are supplied.

Do not probe real tickets from other brands to demonstrate isolation. The account
owner can create synthetic fixtures in separate scopes for this purpose.

## 4. Build and publish a reviewed image

The Dockerfile uses a pinned multi-architecture Node 24 base digest, runs as a
non-root user, and copies only `package.json` and `src/`. Credentials and local
env files are outside the allowed Docker build context. Refresh the base digest
regularly through a reviewed change; pinning does not automatically apply updates.

For a local image:

```sh
docker build --tag hubspot-proxy:demo .
```

For the shared repository, CI runs checks, tests, Kubernetes rendering, and a
container build on pull requests and `main`. **It does not deploy.** A maintainer
can manually run `CI` on reviewed `main` with `publish_image=true` to publish
`ghcr.io/springmath/hubspot-proxy:sha-<commit>`. Configure required reviewers on
the GitHub `image-publish` environment before treating it as a release gate.

The workflow publishes Linux amd64 from GitHub's runner. For an arm64-only
cluster, publish the matching architecture or an explicitly reviewed multi-arch
image. For Ochre, use its own repository/registry if preferred. Deploy images by
registry digest, and configure a read-only image-pull credential for private
registries. Never make an image or repository public just to bypass pull access.

CI is not Claude approval. Before production PR merges, configure the Claude
GitHub app and its approved API credential, then require a **formal Claude
APPROVED review on the current commit** as well as CI. A skipped check, successful
empty action, ordinary comment, or stale review is not approval. No Claude
credential or active review workflow is provisioned by these manifests.

## 5. Install the private Kubernetes demonstration

Use an explicitly selected cluster context. Do not apply all files recursively:
the `examples` directory contains placeholders, not deployment resources.

1. Review `k8s/configmap.yaml` and replace each policy placeholder. Keep
   `BROKER_ENABLE_WRITES=false`. Attest marker immutability only when step 1 is
   complete.
2. Set the deployment image to the reviewed image digest, for example
   `ghcr.io/springmath/hubspot-proxy@sha256:<verified-registry-digest>`.
3. Review the network policy against the cluster's CNI and DNS implementation.
4. Select the exact intended context and create only the demonstration namespace:

```sh
kubectl --context YOUR_APPROVED_CONTEXT apply -f k8s/namespace.yaml
```

Provision the secret from the protected file. Neither the secret values nor the
generated YAML should be printed or captured in a build log:

```sh
kubectl --context YOUR_APPROVED_CONTEXT -n hubspot-proxy-demo create secret generic hubspot-proxy-secrets --from-env-file=/secure/path/hubspot-proxy.env --dry-run=client -o yaml | kubectl --context YOUR_APPROVED_CONTEXT -n hubspot-proxy-demo apply -f -
```

Review the non-secret rendered resources, deploy, and check rollout:

```sh
kubectl kustomize k8s
kubectl --context YOUR_APPROVED_CONTEXT apply -k k8s
kubectl --context YOUR_APPROVED_CONTEXT -n hubspot-proxy-demo rollout status deployment/hubspot-proxy --timeout=180s
kubectl --context YOUR_APPROVED_CONTEXT -n hubspot-proxy-demo port-forward --address 127.0.0.1 service/hubspot-proxy 8080:8080
```

Keep port-forward running, and use the same localhost checks in another terminal.
The base Service is `ClusterIP`: it has **no public endpoint**. Port-forward uses
Kubernetes API authorization and is not a test of the normal pod-ingress policy.
In-cluster clients use
`http://hubspot-proxy.hubspot-proxy-demo.svc.cluster.local:8080` only on a trusted
private network; production deployments should add internal transport encryption
where the cluster threat model requires it.

The deployment disables service-account token mounting, privilege escalation,
Linux capabilities, and writable root storage, with explicit CPU/memory limits.
It uses one replica for demonstration; size and test production replicas according
to request volume and upstream rate limits. ConfigMap/Secret changes require a
controlled pod rollout because environment variables do not update in-place.

### Network policy limitations

The policy admits port 8080 only from pods **and** namespaces deliberately labeled
`hubspot-proxy-client=true`. An operator must approve those labels; never grant
untrusted callers namespace-label control. All other ordinary pod ingress is
denied, subject to the CNI's enforcement and Kubernetes host-traffic exceptions.

DNS is permitted to CoreDNS pods in `kube-system`. Adapt this narrowly if the
cluster uses NodeLocal DNS or different labels. Public IPv4 TCP 443 is allowed;
private, loopback, link-local/instance-metadata and selected reserved ranges are
excluded. IPv6 egress is not granted by the example policy.

**This is not a network-level HubSpot-only allowlist.** Standard Kubernetes
NetworkPolicy does not enforce HTTPS hostnames. The application fixes the
upstream origin; a production egress gateway or FQDN-aware CNI policy should
additionally constrain destinations to the approved HubSpot endpoint. Confirm
the cluster actually enforces NetworkPolicy; YAML alone supplies no isolation.
See [Kubernetes network policy behavior](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

### Optional external access

`k8s/examples/ingress.yaml` is deliberately not deployed. If remote application
servers must reach the broker, Ochre should provide a valid HTTPS hostname and
certificate, ingress-controller policy, rate limiting, and preferably caller IP
restrictions or mutual TLS. The bearer token remains mandatory.

Replace the example ingress class/hostname/TLS secret, add a narrowly selected
ingress-controller allowance to NetworkPolicy, and verify that plaintext HTTP
cannot carry credentials. Disable request-body/Authorization logging at every
ingress and observability layer. Never switch the Service to an unauthenticated
public LoadBalancer. No Cloudflare or other DNS changes are made by this repo.

## 6. Enable writes deliberately

After read-only isolation tests and the required review, set
`BROKER_ENABLE_WRITES=true` and roll out that config. Use only designated
synthetic tickets until Ochre approves the production integration. Ticket create,
stage update, summary update, and archive requests are real upstream operations.
Changing ticket status can trigger HubSpot automation configured by the owner;
the broker does not send email or guarantee delivery.

Account owners must separately approve the customer-facing emails and recipient
associations. Do not email internal investigation notes or every team handoff.
Test actual receipt and an email reply before claiming the full customer email
round trip is working. Archive is distinct from resolve/Closed.

## Rotation, rollback, and operations

- **Emergency write stop:** set `BROKER_ENABLE_WRITES=false` and restart the
  deployment; account for requests already in flight. For immediate containment,
  block broker ingress or revoke the relevant credential under the owner's
  incident procedure. Do not promise config edits instantly stop old pods.
- **Broker token rotation:** generate a new token, store its SHA-256 in the
  broker secret, update the client secret, and roll out both in a coordinated
  maintenance window. Only one hash is accepted per process. Rolling replacement
  temporarily mixes old/new credentials across replicas; use a planned stop/start
  if immediate global revocation is required. Verify the old token is rejected.
- **HubSpot token rotation:** Ochre rotates it within its HubSpot account, updates
  its broker secret, and rolls out the broker. SpringMath should not receive it.
  Verify readiness and then revoke the old credential per the overlap policy.
- **Rollback:** redeploy the previously reviewed image digest **and** its matching
  policy config. A Deployment rollback alone does not restore an edited
  ConfigMap/Secret. Never restore an expired/compromised credential. Broker
  rollback does not undo tickets already created or changed in HubSpot.
- **Logs:** retain request outcome/timing/operation metadata, not tokens, raw
  ticket payloads, emails, or customer text. Protect access and agree retention.
  Inspect infrastructure access/error logging too, not just application logs.
- **Monitoring:** alert on readiness failures, denied/out-of-scope requests,
  upstream rate limits/errors, and repeated bounded-scan failures. Avoid logging
  customer bodies while debugging. Do not use write operations as health probes.

For Ochre handover, replace the namespace/account/pipeline/property values, use
Ochre-owned secrets and deployment access, repeat isolation tests, and only then
change the SpringMath client's base URL and broker bearer. An installation in
SpringMath's cluster demonstrates behavior; it is not a substitute for that
separation of custody.
