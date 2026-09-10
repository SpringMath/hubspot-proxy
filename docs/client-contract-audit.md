# SpringMath client contract audit

Audit date: 2026-09-10. These are requirements observed in the local pending
SpringMath clients, not a claim that every route is implemented in this broker
or deployed. No live HubSpot calls or credential reads were performed.

Sources:

- Portal worktree `portal-ochre-ticket-management`,
  `src/lib/hubspot-support-client.ts` and `hubspot-support-contract.ts`.
- App worktree `app-au-ticket-contact-handoff`,
  `app/imports/api/aiAgent/server/hubspotSupportClient.js` and
  `hubspotSupportTicketTool.js`.

Both source worktrees contain pre-existing uncommitted follow-up changes. They
were inspected without modification. The API paths below are the clients'
current direct-HubSpot contracts; deliberately narrower broker contracts take
precedence over transparent compatibility.

## Boundary and deployment ownership

The permitted ticket population is the intersection of one configured HubSpot
account, `hs_pipeline = PIPELINE_ID`, and a configured ticket property
`SCOPE_PROPERTY = SCOPE_VALUE`. Do not accept these ownership values from an
untrusted request. Ticket status is a filter within this population, never a
replacement for the population boundary.

A broker hosted in an environment administered by SpringMath, containing
Ochre's unrestricted HubSpot token, does **not** prevent SpringMath's cluster
administrators from obtaining that token. The intended independent credential
boundary requires Ochre-controlled runtime administration and secrets. The same
container can be tested against SpringMath's own synthetic HubSpot account on
SpringMath infrastructure.

## Shared request envelope

Current upstream origin: `https://api.hubapi.com`.

- Authorization is `Bearer <server-only support token>`.
- `Accept: application/json` on all requests; `Content-Type: application/json`
  on JSON bodies.
- Clients refuse redirects and do not follow `paging.next.link`.
- Portal individual calls have a 15-second timeout. Its archive scan has a
  30-second overall deadline; the escalated badge has a 15-second overall
  deadline. App individual calls have a 30-second timeout.
- Only the documented read routes and narrowly allowed writes are needed.
  Generic CRM, batch, contacts search, association writes, files, notes, emails,
  conversations, schema writes, pipeline writes, restoration and permanent
  deletion are not part of this observed support-client contract.

## Account and pipeline metadata

| Method and path | Request | Response actually consumed |
| --- | --- | --- |
| `GET /account-info/v3/details` | No query or body | `portalId`, converted to string and compared with configured account ID |
| `GET /crm/v3/pipelines/tickets/{pipelineId}` | The one configured pipeline ID; no query or body | `id`, `archived?`, `stages[]` with `id`, `label`, `archived?`, `metadata.ticketState` |

The portal uses `ticketState` values `OPEN` and `CLOSED`, checks unique numeric
stage IDs, and bounds the array to 250 stages. The target escalation and return
stages must be active `OPEN` stages; resolution must target an active `CLOSED`
stage. The app currently validates the account but does not request pipeline
metadata. A broker may perform stronger create-stage validation internally.

Do not expose account settings or other pipelines incidentally returned by an
upstream API. Only the fields above are needed. The configured numeric HubSpot
account ID is still returned by the broker; it is not the broker's own identity.

## Portal: ticket reads

`GET /crm/v3/objects/tickets/{numericTicketId}` is made twice for each ticket:

1. Boundary request query: `properties=hs_pipeline,<SCOPE_PROPERTY>`.
2. Content request query:
   `properties=hs_pipeline,<SCOPE_PROPERTY>,subject,content,hs_pipeline_stage,hs_lastmodifieddate,<SUMMARY_PROPERTY>`.

An exact ticket which returns a genuine active-read 404 can be read again with
`archived=true` on both requests. There is no broader archived fallback on an
authorization, account, malformed-response or transport failure.

Each returned object must contain:

```json
{
  "id": "numeric ticket ID",
  "archived": false,
  "properties": {
    "hs_pipeline": "configured pipeline",
    "scope_property": "configured value",
    "subject": "ticket subject",
    "content": "original customer issue",
    "hs_pipeline_stage": "numeric stage ID",
    "hs_lastmodifieddate": "parseable timestamp",
    "summary_property": "shared support summary"
  }
}
```

Only requested allowlisted properties need be returned. `archived` must be an
explicit boolean, and must be `true` for archived reads. The client does not
consume top-level `createdAt`/`updatedAt`; freshness comes from
`properties.hs_lastmodifieddate`. It accepts nullable property values but fails
if that timestamp is absent or invalid. It truncates subject to 250 characters
and issue/summary to 10,000 characters in its own returned tool shape.

The broker must independently check ticket ownership before returning any
ticket ID, property or contact association; the client's existing boundary
checks are defense in depth, not the broker's authorization implementation.
Return indistinguishable not-found responses for absent and foreign tickets.

## Portal: active search and escalated count

`POST /crm/v3/objects/tickets/search` with a JSON body. Current clients send
one filter group:

```json
{
  "filterGroups": [{ "filters": [
    { "propertyName": "hs_pipeline", "operator": "EQ", "value": "PIPELINE_ID" },
    { "propertyName": "SCOPE_PROPERTY", "operator": "EQ", "value": "SCOPE_VALUE" }
  ] }],
  "properties": ["hs_pipeline", "SCOPE_PROPERTY"],
  "sorts": ["-hs_lastmodifieddate"],
  "limit": 10
}
```

Optional fields and variations:

- `query`: trimmed text, at most 200 characters in the portal.
- `after`: a decimal string of one to six digits.
- Sorts: one of `-hs_lastmodifieddate`, `hs_lastmodifieddate`, `subject`,
  `-subject`.
- Ticket-management views add stage filter
  `{propertyName:'hs_pipeline_stage', operator:'IN', values:[...stageIds]}`
  and request `hs_pipeline_stage` in `properties`.
- The badge uses `limit:1`, requests pipeline/scope/stage metadata only, and
  adds stage filter `EQ` for the configured escalated stage. It does not send a
  text query, cursor or sort.

Response requirements:

- `{results:[...ticket metadata...], paging?:{next?:{after:string|number}}}`.
- Each metadata row includes `id`, explicit `archived:false`, and requested
  boundary properties. Selected stage must match, where present.
- Search requires no full ticket content; the portal subsequently reads each
  result by ID using the two-read pattern above.
- Badge additionally consumes numeric safe-integer `total >= 0`, and requires
  `results.length === Math.min(total, 1)`.
- Search excludes archived records.

HubSpot filter groups are OR alternatives: a broker must AND its mandatory
pipeline/property restrictions into **every** accepted group, or accept only
the smaller one-group contract. Appending a separate mandatory filter group
would broaden access. A scoped count must come from a scoped upstream query;
do not return a global count after filtering only the visible page.

## Portal: archive collection paging

`GET /crm/v3/objects/tickets` with:

- `archived=true`
- `limit=100`
- `properties=hs_pipeline,<SCOPE_PROPERTY>,hs_pipeline_stage`
- optional opaque `after`, copied only from the prior response's `next.after`.

Expected shape: `{results:[...archived metadata...], paging?:{next?:{after}}}`.
`id` and explicit `archived:true` are mandatory for every row. Current portal
code accepts an upstream cursor up to 256 characters matching
`(?:[a-zA-Z0-9_+=/-]|%[0-9a-fA-F]{2})+`; it never follows the upstream link.

The current direct client scans up to 1,000 metadata records, keeps up to 100
matching scoped records, then reads their content with archived=true. It fails
closed if the full scan cannot finish within its bounds. It filters text and
sorts the complete scoped archive locally before presenting pages of ten.

**A broker must not reproduce the direct client's global metadata exposure.**
It must filter archive metadata inside the broker and return only permitted
IDs. It must not leak foreign ticket IDs in raw upstream cursors, links, totals
or timing-derived scan metadata. Use signed/opaque broker-owned pagination or a
bounded complete scan with scoped offsets. Exhausting the safe scan should be
an explicit error, not an apparently complete partial archive. Preserve the
portal's permitted cursor shape if zero-code client compatibility is desired.

## Portal: changes

| Method and path | Body | Behavior consumed |
| --- | --- | --- |
| `PATCH /crm/v3/objects/tickets/{numericTicketId}` | `{properties:{[SUMMARY_PROPERTY]:"..."}}` | Save shared summary without replacing original issue |
| Same PATCH | `{properties:{[SUMMARY_PROPERTY]:"...",hs_pipeline_stage:"allowed stage"}}` | Escalate, return to Tier 1, or resolve within the same pipeline |
| `DELETE /crm/v3/objects/tickets/{numericTicketId}` | No body | Archive to HubSpot's recycling bin; require HTTP 204 with no body |

The portal consumes a successful PATCH as an object-shaped JSON response, then
reads the ticket again and verifies the summary/stage. It requires a successful
DELETE to be exactly 204 and verifies the archived record afterward. Failed or
ambiguous writes are not automatically retried. The broker must not auto-retry
these writes either.

Before mutation the portal checks its last-seen `hs_lastmodifieddate`. This is
not an atomic upstream compare-and-swap, and the expected timestamp is **not**
part of the PATCH JSON today. The broker cannot claim atomic conditional writes
based on the existing wire contract.

Allowed mutation fields should be no wider than configured shared summary and
an allowlisted stage. Reject pipeline, scope, requester, external ID, subject,
content, owner, associations and arbitrary field edits. Archived ticket
mutations must be rejected. The broker must perform its own fresh ownership
check even when the client already read the ticket.

## App: pending requester and creation contract

The pending app obtains the email from the authenticated server-side user
context, not from model arguments. It does not transfer the full conversation
or internal tool results automatically.

### Exact contact lookup and email-only creation (privacy exception)

The pending direct-HubSpot client currently uses:

1. `GET /crm/v3/objects/contacts/{percentEncodedEmail}?idProperty=email&properties=email`.
2. Only following definite 404:
   `POST /crm/v3/objects/contacts` with `{properties:{email:"lowercase email"}}`.
3. On a timeout, conflict or uncertain contact-create response, one exact email
   reread; no blind repeated contact POST.

Consumed response: `{id:"numeric contact ID",archived:false,properties:{email}}`.
The active contact's primary email must match the authenticated email
case-insensitively. If an alias lookup returns a different primary email, it
fails rather than using or changing the profile. No names, company, lifecycle,
marketing status, consent or extra associations are needed.

**These endpoints are not naturally brand/pipeline scoped.** Even exact lookup
returning only ID/email is a cross-brand contact-existence oracle. A ticket-only
proxy should deny them by default. Do not label them safe simply because the
caller supplies an email, and do not expose arbitrary contact-ID reads or
updates. HubSpot contact records can also be shared by more than one brand.

Preferred integration: move exact requester resolution and email-only contact
creation into the broker's scoped ticket-create operation. Return only the
scoped ticket/result, not unrelated contact profile data or account-wide contact
lookup APIs. This requires a small deliberate app adapter change; changing the
base URL alone cannot both preserve the pending direct-contact flow and remove
its cross-brand lookup capability. The trusted app's assertion of requester
identity still needs to be explicit in that contract.

### Ticket creation

`POST /crm/v3/objects/tickets` currently sends:

```json
{
  "properties": {
    "subject": "customer-facing title",
    "content": "customer-safe issue description",
    "hs_pipeline": "PIPELINE_ID",
    "hs_pipeline_stage": "NEW_STAGE_ID",
    "EXTERNAL_ID_PROPERTY": "springmath-au-ACCOUNT_ID-conversation-CONVERSATION_ID",
    "REQUESTER_EMAIL_PROPERTY": "authenticated@example.com",
    "SCOPE_PROPERTY": "SCOPE_VALUE"
  },
  "associations": [{
    "to": { "id": "exact requester contact ID" },
    "types": [{ "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 16 }]
  }]
}
```

The broker must force configured ownership and initial stage and reject
contradictory values. A caller-supplied contact association must not allow
association of arbitrary cross-brand contacts. Broker-owned requester
association is preferable.

Creation response fields consumed:

- `id`: numeric string; `archived:false`.
- `properties.hs_pipeline`.
- `properties[SCOPE_PROPERTY]`.
- `properties[EXTERNAL_ID_PROPERTY]`.
- `properties[REQUESTER_EMAIL_PROPERTY]` matching the authenticated email.

App treats 400/401/403/404/422 as definite rejected creates. Other failures,
including conflict, timeout, malformed success and 5xx, are uncertain; its
conversation marker remains pending rather than blindly creating another
ticket. Preserve this distinction and do not return success without a
confirmed upstream result.

### Readback and reconciliation

After successful creation:

`GET /crm/v3/objects/tickets/{numericTicketId}?properties=<EXTERNAL_ID_PROPERTY>,hs_pipeline,<SCOPE_PROPERTY>,<REQUESTER_EMAIL_PROPERTY>&associations=contacts`.

For idempotency reconciliation before considering a repeated create:

`GET /crm/v3/objects/tickets/{percentEncodedExternalId}?idProperty=<EXTERNAL_ID_PROPERTY>&properties=<EXTERNAL_ID_PROPERTY>,hs_pipeline,<SCOPE_PROPERTY>,<REQUESTER_EMAIL_PROPERTY>&associations=contacts`.

Response includes the same required ticket fields as creation plus
`associations.contacts.results[]` containing contact `id` strings. The app
performs another exact-email contact lookup and requires its ID in the
association results before marking the Pi chat handed off/read-only.

A broker must support the exact configured external-id property, not an
arbitrary `idProperty`, if this reconciliation route is enabled. Ownership
checks apply after both numeric and external-id lookup, before any response.
Do not return all ticket-associated contact IDs by default: the internal
requester-resolution approach should verify the association privately and
expose a deliberately limited handoff confirmation instead. Returning unrelated
association IDs is unnecessary disclosure.

## Smallest future client changes

These are recommendations only; no existing app/portal source was changed by
this audit.

1. Add one **server-only** `HUBSPOT_SUPPORT_API_BASE_URL` with the current
   `https://api.hubapi.com` as the compatibility default. Validate an HTTPS
   origin with no userinfo, query or fragment; do not allow request-supplied
   hosts/paths. Any local HTTP test exception must be explicit and nonproduction.
2. Portal: replace its single `ORIGIN` constant in `request()` with this validated
   origin. Continue using its dedicated support-token variable, populated with
   a broker-issued client token for broker deployments. Preserve the separate
   generic marketing/HubSpot integration unchanged.
3. App: route **all** support requests through that origin: ticket root, contact
   root if ever intentionally supported, and `/account-info/v3/details`.
   Changing only the ticket URL would leak the broker bearer token toward
   HubSpot on account/contact calls and leave the privacy boundary incomplete.
4. Prefer an explicit broker handoff mode for app creation/reconciliation which
   performs contact resolution within the broker. Keep direct-HubSpot behavior
   as its own reviewed deployment mode; do not silently fall back to an
   unrestricted HubSpot token or direct origin after a broker rejection.
5. Add environment wiring, deterministic mock contract tests and deployment
   docs in each client repo. Keep region flags, requester authentication,
   Ochre role ceilings and existing explicit human write approvals.
6. Use only synthetic data until Ochre accepts deployment ownership, property
   semantics, contact behavior and support-email automation. A successful CRM
   mutation does not verify that HubSpot sent or delivered an email.
