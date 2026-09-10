# SpringMath access boundary in Ochre HubSpot

This is the concrete configuration and acceptance plan. **Ticket isolation,
private requester association and optional ticket-only CRM notes are implemented.
Ticket-bound Conversations/email routes are still planned and remain denied.**
The SpringMath Sydney demonstration uses SpringMath's own account; it is not an
installation in Ochre's account and must never hold Ochre's unrestricted key.

## Service key scopes

For the complete proposed workflow, the single upstream service key has:

| Scope | Purpose |
| --- | --- |
| `tickets` | Create/read/update/resolve/archive the permitted tickets; resolution is a Closed pipeline stage. |
| `crm.objects.contacts.read` | Privately verify the requester's primary email and contact association; also supports native CRM note reads. |
| `crm.objects.contacts.write` | Create an email-only requester contact if absent and native internal notes. No arbitrary profile edits or marketing subscription changes. |
| `conversations.read` | Planned: read only the approved ticket's verified email thread and necessary channel metadata. |
| `conversations.write` | Planned: send an explicitly approved reply in that verified thread. |

Granting these upstream scopes **does not isolate a brand** or enable new broker
routes. The two Conversations scopes are preparation for the email adapter; the
current broker cannot use them for client replies. Schema-write and unrelated
marketing scopes are not required at runtime. An Ochre administrator provisions
the custom properties using HubSpot settings, not the broker service key.

## Exact setup inside HubSpot

1. Create or identify one dedicated **SpringMath Support** ticket pipeline.
   Record its internal pipeline ID and the status IDs for Tier 1, Tier 2, returned
   to Ochre, waiting on customer, and Closed. Mark Closed as Closed in HubSpot.
   Pipeline names and stage labels are display text, not authorization checks.
2. In Settings → Properties → Ticket properties, create these distinct fields:

   | Internal property | Type / purpose | Broker configuration |
   | --- | --- | --- |
   | `sm_au_support_scope` | Single-line text; fixed value `springmath-au` on approved SpringMath tickets | `HUBSPOT_SCOPE_PROPERTY=sm_au_support_scope`, `HUBSPOT_SCOPE_VALUE=springmath-au` |
   | `sm_au_conversation_key` | Single-line text with **unique values required**; originating SpringMath app conversation ID | `HUBSPOT_CONVERSATION_ID_PROPERTY=sm_au_conversation_key` |
   | `sm_au_requester_email` | Single-line text; verified signed-in customer's email, written by the trusted app server | `HUBSPOT_REQUESTER_EMAIL_PROPERTY=sm_au_requester_email` |
   | `sm_au_support_summary` | Multi-line text; customer-safe shared investigation summary | `HUBSPOT_SUMMARY_PROPERTY=sm_au_support_summary` |

   If the account uses different field names, configure those exact internal names
   instead. SpringMath's own demo intentionally uses value `springmath-au-test`,
   account `50288738` and pipeline `933928091`; **do not copy those IDs into Ochre**.
3. Pin `HUBSPOT_ACCOUNT_ID` to Ochre's account and `HUBSPOT_PIPELINE_ID` to that
   one pipeline. On every broker-created ticket the broker forces both pipeline
   and scope marker. On existing tickets, an Ochre administrator must review and
   mark only the specific approved records. No automatic global backfill.
4. For tickets created by email or Ochre staff, use a SpringMath-specific intake
   channel/rule to assign that pipeline and marker before broker access is
   allowed. A missing marker is denied. Never mark every ticket for a contact or
   company simply because they also use SpringMath. Use a unique external key
   for imported records when they need app-conversation lookup.
5. Associate the requester contact with the ticket. Store the same verified
   primary email in `sm_au_requester_email`. A contact may have other-brand
   relationships: **this grants access to neither their full CRM profile nor
   any other ticket, activity or conversation**. The broker uses only the minimal
   primary-email/ID fields privately for this ticket's handoff checks.
6. For the planned email adapter, connect a **SpringMath-only team inbox/email
   channel**. Record its inbox ID, channel-account ID and authorized sender actor
   ID; these must be fixed broker configuration, not caller arguments. Use a new
   SpringMath ticket-specific email thread, linked to this ticket and requester.
   A CRM ticket created through the API does not automatically create that thread.
   Never repurpose a cross-brand thread or forward a cross-brand history into it.
7. Keep notes ticket-only. Native notes can be associated with several records;
   a note that is also linked to another standard record is withheld, not read.
   `notesWithheld:true` warns that the returned notes are not the complete HubSpot history.
   Incomplete or malformed association metadata fails closed. Custom-object note
   associations are not exhaustively discoverable; the operator must prohibit
   them on broker-visible notes.

## Runtime rules by record type

| Requested record | Required evidence | What SpringMath receives |
| --- | --- | --- |
| Ticket | Exact account **AND** approved pipeline **AND** exact ownership-marker value, freshly read | Only allowlisted ticket properties; no global history or association expansion |
| Contact | Already verified parent ticket; the expected requester contact is associated and its primary email matches | An association-verification boolean; no general contact endpoint, search, profile or activity timeline |
| Conversation **(planned)** | Verified parent ticket; exactly one approved ticket-bound thread; matching requester; SpringMath-only pinned inbox/channel; no ambiguous, cross-brand or additional-recipient context | Only that thread's permitted email content and minimal reply-routing context |
| Email reply **(planned)** | Recheck the preceding boundaries immediately before sending; exact approved To/From/subject/body and current context; one verified requester, no CC/BCC | The submitted reply's safe confirmation; API acceptance is not proof of mailbox delivery |
| Internal note | Verified parent ticket; complete metadata confirms this is a permitted ticket-only note | Allowlisted native note fields, including bounded note HTML; the portal converts it to safe text. Cross-record bodies are not fetched |

An email-domain match, contact/company membership, UI brand selection, queue
name, ticket subject or current tier/status is **never sufficient** to authorize a
record. All statuses within the permitted pipeline may be queried. Archive
visibility is explicit. Search injects both ticket boundaries into every OR
group and verifies results; denied records do not appear in counts or pagination.

The implemented requester verifier checks that the expected contact is among
the ticket's associations; it does not expose or traverse other contacts. The
planned email adapter imposes the stricter requirement of exactly one associated
requester contact and exactly one permitted email thread before allowing replies.

### Planned Conversations adapter acceptance contract

Expose only ticket-addressed operations (for example
`GET /springmath/v1/tickets/{ticketId}/reply-context` and
`POST /springmath/v1/tickets/{ticketId}/replies`); these routes are **not implemented**.
Never expose global `/conversations`, arbitrary thread/message IDs, recipients,
contact lookup or generic association endpoints as transparent proxy routes.

The broker must derive the thread and recipient itself, verify HubSpot's returned
`threadAssociations.associatedTicketId` instead of trusting a search filter, check
the requester's ticket/contact association and each message's email participants,
and recheck the parent scope before returning any body or posting any reply.
Missing/ambiguous relationships, unexpected participants, stale approvals,
incomplete pagination, excessive response size, archived/out-of-scope parents,
or sender-channel mismatch must fail closed. Contact associations alone cannot
prove a thread's ownership. The SpringMath-only channel and thread-creation rules
are required, not optional hints.

Use a durable approved-send reservation to prevent duplicate replies; do not
automatically retry an uncertain send. The current stateless broker does not
provide durable email idempotency. Add that capability and its failure tests
before enabling replies; do not bypass it with the unrestricted HubSpot key.

## Who controls the boundary

Ochre owns the deployment, pipeline/marker policy, HubSpot token and cluster
administration. SpringMath receives only a separately generated broker token.
The trusted app server supplies the authenticated requester; a broker service
token is not end-user authentication. Portal roles and approval checks still
govern which staff may act, but are not a substitute for the broker's boundary.

HubSpot does not provide an atomic “mutate only if pipeline/marker still match”
operation. The account owner must prevent concurrent pipeline/marker or relevant
note/thread association reassignment while broker access is enabled. The
`BROKER_SCOPE_IS_IMMUTABLE` flag is an operator attestation, not enforcement.
Disable access and writes, drain operations, then reclassify records. If Ochre
cannot enforce that operating constraint, this broker design alone is not a
strict write-isolation guarantee; use a stronger boundary such as a dedicated
HubSpot account. Ordinary stage transitions inside the pipeline remain allowed.

## Required synthetic acceptance tests before Ochre activation

- Approved pipeline + correct marker succeeds; wrong pipeline, missing/wrong
  marker, guessed foreign IDs and missing/invalid broker tokens are denied.
- A contact shared with another brand does not expose its other records; an
  email alias or different primary address is not silently substituted.
- Changing search OR clauses, requesting arbitrary properties, or using generic
  contacts/notes/conversations routes cannot widen scope.
- Cross-record notes are withheld without reading bodies; malformed metadata
  and incomplete association pages fail closed.
- Before email routes ship: a wrong ticket association, foreign inbox/channel,
  mixed-brand history, extra recipient, changed incoming email, duplicate approval
  and uncertain send are rejected without a second email.
- Verify acknowledgement, explicit reply, Tier 2 return and resolution using a
  synthetic requester and actual mailbox evidence. Internal notes and routine
  team handoffs must not email the customer automatically.

References: [Ticket properties and associations](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/tickets/guide),
[CRM contacts](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide),
[CRM notes](https://developers.hubspot.com/docs/api-reference/latest/crm/activities/notes/guide),
[Conversations scopes and messages](https://developers.hubspot.com/docs/api-reference/legacy/conversations/guide).
