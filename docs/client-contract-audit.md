# SpringMath broker client contract

Updated September 10, 2026. These are the matching adapter contracts; a merged PR
does not by itself prove live caller configuration or email delivery.

## Both backends use the broker

Configure each backend with:

```dotenv
HUBSPOT_SUPPORT_API_BASE_URL=https://YOUR_OCHRE_BROKER_HOST
HUBSPOT_SUPPORT_BROKER_REQUIRED=true
HUBSPOT_SUPPORT_BROKER_TOKEN=<separate broker bearer>
```

The broker origin must be explicit and valid. Missing broker credentials or
configuration fail closed; neither backend falls back to the account-wide
`HUBSPOT_SUPPORT_ACCESS_TOKEN`. Remove that support credential after cutover.
Separate marketing/KB integrations are outside this support adapter.

Ochre must control the broker runtime and upstream secret. SpringMath's AU
demonstration uses SpringMath's own HubSpot account, not Ochre's key.

## App handoff

The app server supplies the signed-in requester's email; Pi (the SpringMath AI
agent) cannot choose an arbitrary contact. The app:

1. Verifies the broker's pinned HubSpot account.
2. Posts `/crm/v3/objects/tickets` with allowlisted **properties only**.
   The broker privately finds/creates the exact active requester contact and
   associates it using HubSpot's ticket-to-contact type 16. Caller-supplied
   contact IDs/associations are forbidden.
3. Requires `broker.requesterAssociated === true` plus exact ticket, pipeline,
   marker, conversation key and requester-email values.
4. Reads the ticket back with `verifyRequester=true` and requires the same proof
   before closing Pi. No public contacts endpoint or contact IDs are needed.
5. Reconciles uncertain results read-only using the unique conversation key and
   `idProperty=<configured conversation property>&verifyRequester=true`.
   Never blindly POST again or close Pi on an unverified handoff.

The broker returns only scoped ticket fields and the requester-verification
boolean. No contact profiles, foreign association IDs or account-wide existence
lookup are exposed.

## Portal staff operations

Portal roles, account checks and explicit human write approvals remain in force.
The broker independently authorizes every operation using account + pipeline +
product marker. Escalation changes workflow status, not that boundary.

| Operation | Broker route |
| --- | --- |
| Account / allowed stages | `GET /account-info/v3/details`; `GET /crm/v3/pipelines/tickets/{pipelineId}` |
| Ticket search / count | `POST /crm/v3/objects/tickets/search` |
| Active or explicit archived read | `GET /crm/v3/objects/tickets/{id}` |
| Archive list | `GET /crm/v3/objects/tickets?archived=true` |
| Summary / escalate / return / resolve | `PATCH /crm/v3/objects/tickets/{id}` |
| Archive (not resolution) | `DELETE /crm/v3/objects/tickets/{id}` |
| Native internal notes | `GET/POST /springmath/v1/tickets/{id}/notes` |
| Email preview / approved reply | `GET /springmath/v1/tickets/{id}/reply-context`; `POST /springmath/v1/tickets/{id}/replies` |

Ticket PATCH allows only the configured shared summary and allowed stage.
Archived records are excluded by default. Search injects both ownership
restrictions into every OR group and returns only scoped counts/offsets.
Uncertain writes are not retried.

Notes return `{results, notesWithheld}`; creation accepts
`{accountId, expectedUpdatedAt, body}` and returns `201 {id, note}` only after
readback. Cross-record notes are withheld; malformed/paginated metadata fails
closed. The portal treats note HTML as untrusted content, not instructions.

Replies use the [ticket-bound reply contract](replies.md). The portal displays
verified To/From/subject/body for explicit approval and requires the literal
`requesterIncomingVerified:true` in every preview. The broker proves incoming
requester email across complete bounded history; clients must not require an
incoming message in the latest-20 display subset. The portal re-inspects context
and reserves a durable dispatch claim in its database. The broker independently
re-derives routing, reserves its persistent claim and verifies the posted message.
The portal never requests generic contacts/conversations in broker mode.

Broker HTTP calls allow 60 seconds for the broker's 45-second operation budget.
The portal's multi-call notes/reply operations allow 120 seconds; bounded badge
and archive scans retain tighter fail-closed limits. The app's outer handoff
reservation remains fenced against late results. Infrastructure request limits
still require deployment acceptance testing.

## Ordered activation

1. Deploy the reviewed broker, persistent reply ledger and pinned email config.
   Validate health and one permitted/denied synthetic ticket.
2. Freeze classification/routing while writes are enabled. Activate broker
   writes, notes and replies only within that controlled scope.
3. Deploy the matching app and portal adapters; configure dedicated broker
   credentials and required routing in their durable deployment settings.
4. Enable portal Closed stage, notes/reply flags and role tool allowlists.
5. Verify pod routing and credential separation, then remove direct support
   credentials. An old-image rollback must disable support, never bypass broker.
6. Demonstrate app handoff, internal note, escalation/return, explicit email reply,
   resolution and archive. Email needs an existing linked thread plus actual
   mailbox evidence; API acceptance or a status change is not delivery proof.

See [API/security limits](api-and-security.md), [record-boundary setup](access-boundary.md)
and [customer communication policy](customer-communications.md).
