# HubSpot support broker

A small Node.js 24 service that limits SpringMath to its own support tickets in Ochre’s HubSpot account. No database or runtime dependencies.

**Ochre hosts the broker and keeps the HubSpot key. SpringMath receives only a separate broker token.** Every ticket must match the configured account, SpringMath pipeline and product marker. Other routes and other-brand tickets are denied.

```text
SpringMath app + portal → Ochre broker → Ochre HubSpot
    broker token           HubSpot key stays here
```

Supports ticket search, creation, updates, handoffs, resolution, archiving and optional internal notes. Contact association is handled privately. **Conversation reads and email replies are not implemented.** This is a restricted API, not a drop-in proxy for every HubSpot endpoint.

## Install on Kubernetes

Prerequisites: Node.js 24, Docker, kubectl, a container registry and an Ochre-controlled cluster.

### 1. Clone and check

```sh
git clone https://github.com/SpringMath/hubspot-proxy.git
cd hubspot-proxy
npm run check
npm test
```

### 2. Configure HubSpot

Use the repository’s [HubSpot setup instructions](docs/access-boundary.md#exact-setup-inside-hubspot) as the authoritative reference; the [screenshot guide](https://springmath-hubspot-service-key-guide.tim-heckel419739.chatgpt.site) is an optional visual aid.

For the implemented ticket/contact workflow, grant `tickets`, `crm.objects.contacts.read` and `crm.objects.contacts.write`. The `conversations.read` and `conversations.write` scopes are only for the future, unimplemented email adapter—not required today. See the [scope table](docs/access-boundary.md#service-key-scopes). Select a SpringMath pipeline and create these ticket properties:

| Property | Type / value |
| --- | --- |
| `sm_au_support_scope` | Text; fixed value `springmath-au` |
| `sm_au_conversation_key` | Text; **unique values required** |
| `sm_au_requester_email` | Text |
| `sm_au_support_summary` | Multi-line text |

Edit `k8s/base/configmap.yaml`: replace every `REPLACE_*` value with the account ID, pipeline ID, property names, marker value and allowed stage IDs. Set the initial and Closed stage IDs. Keep writes disabled for the first test.

### 3. Store credentials

Generate a broker token into a **new protected file outside the repo**:

```sh
(umask 077; set -C; node scripts/generate-token.js > /secure/path/broker-token.json)
```

From the generated JSON, give `brokerToken` to SpringMath through a secret manager and copy `BROKER_TOKEN_SHA256` into the broker’s env file. See [credential provisioning](docs/deployment.md#2-provision-credentials-privately). In a separate permissions-`0600` file, `/secure/path/hubspot-proxy.env`, store:

```dotenv
HUBSPOT_ACCESS_TOKEN=<Ochre HubSpot service key>
BROKER_TOKEN_SHA256=<generated SHA-256 digest>
```

Never commit either file; remove the generated JSON after importing its values into the secret stores. SpringMath must not have access to Ochre’s HubSpot key, broker pod administration or secret store. Every broker-token holder can use its permitted operations; app/portal user-role checks remain required.

### 4. Build and deploy

Replace `YOUR_REGISTRY` and `YOUR_OCHRE_CONTEXT`. Build for your cluster’s architecture, push the image, then set `k8s/base/deployment.yaml` to its **registry digest**.

```sh
docker build -t YOUR_REGISTRY/hubspot-proxy:v1 .
docker push YOUR_REGISTRY/hubspot-proxy:v1
kubectl --context YOUR_OCHRE_CONTEXT apply -f k8s/namespace.yaml
kubectl --context YOUR_OCHRE_CONTEXT -n hubspot-proxy-demo create secret generic hubspot-proxy-secrets --from-env-file=/secure/path/hubspot-proxy.env
kubectl kustomize k8s
kubectl --context YOUR_OCHRE_CONTEXT apply -k k8s
kubectl --context YOUR_OCHRE_CONTEXT -n hubspot-proxy-demo rollout status deployment/hubspot-proxy --timeout=180s
```

Review `k8s/base/networkpolicy.yaml` for your cluster’s DNS/CNI. The base service is private. For remote SpringMath servers, configure authenticated HTTPS ingress using [the example](k8s/examples/ingress.yaml); adapt its placeholders and network policy before applying it. Configure private-registry pull access if required.

### 5. Test, then enable

```sh
kubectl --context YOUR_OCHRE_CONTEXT -n hubspot-proxy-demo port-forward --address 127.0.0.1 service/hubspot-proxy 8080:8080
# In a second terminal:
curl --fail-with-body http://127.0.0.1:8080/readyz
```

Test synthetic SpringMath and other-brand tickets: only SpringMath records should be accessible; invalid tokens and unsupported routes must be denied. Readiness alone does not prove isolation.

For authenticated tests, keep the bearer header in a permissions-`0600` curl config outside the repo and use `curl --config /secure/path/broker-curl.conf …`—never put tokens in shell arguments/history or use `curl -v`. Follow the [safe test procedure and isolation checklist](docs/deployment.md#3-run-checks-and-a-local-demonstration).

**Before enabling writes:** Ochre must prevent concurrent changes to ticket pipeline/product ownership and relevant note associations. HubSpot cannot enforce these checks atomically, and a post-write check cannot undo a raced write. `BROKER_SCOPE_IS_IMMUTABLE` is an operator assurance, not enforcement. If that cannot be guaranteed, keep writes off and use a stronger boundary.

Otherwise set `BROKER_SCOPE_IS_IMMUTABLE=true`, `BROKER_ENABLE_WRITES=true` and optionally `BROKER_ENABLE_NOTES=true` in `k8s/base/configmap.yaml`; reapply manifests and restart the deployment, because running pods do not refresh environment variables in place.

Give SpringMath the HTTPS broker URL and broker token. **Both app and portal backends need the broker-compatible adapter; changing only the hostname is insufficient.** Verify the complete handoff before going live. Customer emails require separate HubSpot configuration.

## Details

- [Deployment, networking and secret handling](docs/deployment.md)
- [API contract and security limits](docs/api-and-security.md)
- [HubSpot record-boundary setup](docs/access-boundary.md)
- [Client integration requirements](docs/client-contract-audit.md)
- [SpringMath’s GitHub Actions deployment and rollback](docs/github-deployment.md)
