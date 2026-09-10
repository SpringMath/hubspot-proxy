# GitHub-driven AU demo deployment

The `Deploy AU broker` workflow deploys reviewed pushes to `main` to
**https://hubspotproxy.springmath.au**. It can also be dispatched manually on
`main` after rotating configuration/secrets. Other refs do not deploy.
The upstream account remains SpringMath's **50288738** test account; do not put
Ochre's unrestricted HubSpot token in SpringMath infrastructure.

## One-time administrator setup

Bootstrap manifests and IAM policies are in `k8s/bootstrap/`. The reusable
workload is in `k8s/base/`; the AU overlay contains no cluster-scoped resources.

These steps require operator authority; the workflow deliberately cannot grant
itself namespace, cluster, IAM, DNS-provider or certificate-issuer privileges.

1. Provision the `springmath-au-hubspot-proxy` ECR repository in account
   `975774911479`, region `ap-southeast-2`, with immutable image tags.
2. Create IAM role `hubspot-proxy-github-deploy-au`. Its OIDC trust must require
   `aud=sts.amazonaws.com` and exactly
   `sub=repo:SpringMath@219569131/hubspot-proxy@1364220697:environment:australia-demo`.
   This repository uses [GitHub's immutable subject format](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims),
   enabled by default for repositories created after July 15, 2026.
   As a **repository administrator**, verify the current configuration with
   `gh api repos/SpringMath/hubspot-proxy/actions/oidc/customization/sub`;
   this repository returns `use_default: true`, `use_immutable_subject: true`,
   and `sub_claim_prefix: "repo:SpringMath@219569131/hubspot-proxy@1364220697"`.
   Append `:environment:australia-demo` only for that verified default prefix.
   If the response differs or access is denied, stop and inspect the actual
   subject in the AWS CloudTrail STS event; do not guess from repository names.
   Keep the exact environment suffix and subject, not a wildcard.
   The successful September 10, 2026 deployment's STS subject and API response
   are recorded in [PR #5](https://github.com/SpringMath/hubspot-proxy/pull/5).
   Grant ECR push/pull only for the dedicated broker repository,
   `ecr:GetAuthorizationToken` on `*`, and `eks:DescribeCluster` for
   `arn:aws:eks:ap-southeast-2:975774911479:cluster/springmath-au`.
   Do not extend the existing app/portal cluster-admin deployment role.
3. Bootstrap namespace `hubspot-proxy-demo`, the dedicated EKS access entry and
   namespace-scoped Role/RoleBinding. CI needs only the approved broker resource
   operations and rollout/certificate observation. It must not read other
   namespaces, create Roles/RoleBindings, impersonate users or modify cluster
   resources. The AU overlay intentionally contains no Namespace/RBAC objects.
4. Create the GitHub environment
   [australia-demo](https://github.com/SpringMath/hubspot-proxy/settings/environments)
   with a **main-only deployment branch policy**. This is essential because the
   OIDC subject includes the environment, not the branch. Protect `main` with PR
   reviews and required `checks` / `claude-review` status checks, prevent bypass
   and require a current branch before merge. Review changes to workflows and
   deployment scripts as privileged changes.
5. In [repository/environment secrets](https://github.com/SpringMath/hubspot-proxy/settings/secrets/actions),
   configure exactly these runtime values (prefer the `australia-demo`
   environment):

   | Secret | Value |
   | --- | --- |
   | `HUBSPOT_ACCESS_TOKEN` | Dedicated upstream HubSpot service key for our synthetic demo account |
   | `BROKER_TOKEN_SHA256` | SHA-256 digest of the newly generated broker bearer credential |

   The raw broker bearer belongs only in authorized callers' secret stores, not
   GitHub deployment logs/workflow inputs. The upstream token is not the broker
   credential. Generate the broker pair with the protected-output procedure in
   [deployment instructions](deployment.md#2-provision-credentials-privately),
   never into shared terminal output. Never commit either credential.
6. Confirm the existing Traefik ingress, external-dns Cloudflare controller and
   `letsencrypt-dns01-production` issuer can reconcile the reviewed AU Ingress
   and Certificate. This workflow stores no Cloudflare token and changes no
   global controller or issuer configuration.

## Claude review bootstrap

The new repository did not initially have a Claude credential, review workflow
or accessible organization Anthropic secret. The pre-existing Gitar approval on
PR #1 is **not Claude approval**.

An owner must enable the Claude GitHub App for this repository and provision
the repo-level **`ANTHROPIC_API_KEY`** secret for the pinned review action. A
dedicated review key is preferable; no portal credential is extracted or copied
by these scripts. The review workflow uses the same formal-review convention as
the portal, adapted to this Node 24/no-dependencies project. It reviews same-repo
non-draft PRs, never fork code with secrets or `pull_request_target`. Tests run
before the review action receives its credential; the reviewer is instructed
not to execute repository code.

For initial PR #1, push the workflow to its branch, configure the app/key, and
mark it ready for review. Do not merge just to bootstrap deployment. A green
action, generic bot comment or another bot's approval is insufficient: the job
requires a **formal `claude[bot]` APPROVED review on the exact current head**,
created during that run with `<!-- claude-code-review:v1 -->` in its body.
Address requested changes and obtain a new approval after each material push.

New pushes cancel older reviews for the same PR. The long-running analysis uses
`!cancelled()` so it can review failed test results without surviving cancellation.
The short, secret-free approval gate retains `always()` to reject failed/skipped
analysis and anything other than a fresh approval on the exact current head.
Runs started before this fix retain their old cancellation behavior; if one blocks
the queue, an operator may force-cancel that obsolete run after confirming its
head is no longer current. No approval or deployment check should be bypassed.

The deployment preflight independently verifies that the deployed main commit
is a merged PR, its latest formal Claude review approves the current head, and
the entire Git tree is identical to that reviewed head. Squash merges work;
direct pushes and merge trees with extra, unreviewed changes fail closed. If a
branch fell behind, update it, obtain review again and merge the new head.

## What each deployment does

1. Runs Node syntax checks and all contract/security tests, then verifies the
   merged PR and exact reviewed source tree before acquiring AWS credentials.
2. Uses GitHub OIDC for the broker-only IAM role and verifies AWS account
   `975774911479` before ECR/EKS access; no static AWS secret is used. The pinned
   credentials action does not support `allowed-account-ids`, so an explicit
   STS identity check provides defense in depth alongside the pinned role ARN.
3. Builds native ARM64 for Sydney's ARM64 nodes, pushes ECR, and deploys by
   immutable registry digest, not a moving tag.
4. Renders `k8s/overlays/au` with a purely local, empty JSON Patch and kubectl's
   YAML decoder (no API discovery), emitting bounded newline-delimited JSON.
   Structurally validates exact API versions/kinds, each `metadata.namespace`,
   resource names/uniqueness and the required Deployment. Only the broker image
   and pod revision annotation may contain their respective placeholders. A
   ConfigMap string cannot spoof resource metadata. All validation finishes
   before either apply; only the validated, serialized Kubernetes List is used.
5. Pipes the two-key Kubernetes Secret directly to `kubectl` stdin using
   **server-side apply** with field manager `hubspot-proxy-deploy`. No secret
   temp files, CLI arguments or last-applied-configuration copies are created.
   Child processes do not inherit the application/review token environment.
   Failure diagnostics intentionally omit submitted Secret contents.
6. Applies the validated List to the dedicated broker namespace, with the exact
   image/revision fields already replaced. A commit/run/attempt annotation restarts pods even when
   the same commit is dispatched after a secret or configuration change.
7. Waits for rollout and the certificate, then checks public TLS, `/healthz`,
   `/readyz` and an unauthenticated **401** for `/account-info/v3/details`.
   Initial DNS reconciliation is given bounded read-only retries.

The smoke test does not possess the raw broker bearer. It proves TLS, process
health, account-verified readiness and the unauthenticated boundary, **not**
authenticated ticket isolation, note mutation, requester association or email
delivery. Operators must perform a separate explicit, synthetic, scoped test
with the caller credential. No ticket or customer email write is run by CI.

## Sydney network-policy caveat

The current Sydney AWS VPC CNI was observed with
`--enable-network-policy=false`. The checked-in NetworkPolicy describes the
intended boundary but is **not presently enforced in this cluster**. Do not
claim Kubernetes network isolation from the presence of the manifest. The demo
uses TLS/bearer authentication, application scope checks, namespace-limited
deployment access and hardened pods. Enabling network-policy enforcement is a
separate cluster-wide change, not something this workflow silently performs.

## Rotate, retry and roll back

- Update the two secrets in GitHub, then dispatch the reviewed `main` commit.
  Updating a GitHub secret alone does not refresh existing pods. Coordinate raw
  broker credential rotation with callers; this first pass accepts one hash.
- A failed deployment does not automatically restore a previous Secret. Inspect
  scoped events, repair the cause and re-dispatch. The secret may already have
  been applied when a later manifest or smoke step fails; old pods retain their
  startup environment until rollout. Do not blindly retry any HubSpot write.
- Reverting application/config changes requires a reviewed revert PR on `main`.
  Restore a still-valid prior secret separately if credential rollback is needed.
  Do not delete HubSpot records, dispatch reservations or Kubernetes TLS secrets.
- For an urgent stop, an authorized operator can disable upstream/broker access
  or scale this single deployment down. Do not weaken the Claude/source-tree
  gate or grant cluster-admin to make a failing workflow pass.
- If migrating an older Secret created by client-side apply, remove its old
  `kubectl.kubernetes.io/last-applied-configuration` annotation in a deliberate
  operator step; server-side apply does not retroactively erase old annotations.
