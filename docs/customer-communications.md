# Proposed support communication policy

This is a **prescriptive design for implementation**, not a claim that these
notifications or portal actions are configured today. The current portal updates
a shared summary property; that is not a native HubSpot internal note or an email
reply. The broker currently denies notes/conversations/email routes deliberately.

| Event/action | Internal record/notification | Customer email |
| --- | --- | --- |
| App hands off a new ticket | Ticket with authenticated requester associated | One receipt acknowledgement through HubSpot's configured workflow |
| Ochre investigates | Internal note; retain customer-safe shared summary | None just because an internal note changed |
| Escalate to SpringMath Tier 2 | Same ticket moves to Tier 2; notify SpringMath support | Only an explicit customer-facing progress reply if useful |
| Return to Ochre | Same ticket moves to returned-to-Ochre; notify Ochre | No automatic email for the team handoff |
| Ask a customer a question or provide a progress update | Record customer-facing reply in the ticket's email thread | Send that explicit reply through HubSpot |
| Resolve | Customer-safe resolution reply, then Closed status | Send the resolution reply; suppress a duplicate automated closure message |
| Archive | Remove from the queue via recycling bin | None; archive is not resolution |

HubSpot supports conditional notifications based on ticket status. Status alone
does not determine whether a message is internal or customer-facing: the workflow
recipient, template and action do. Any automated closure fallback must be mutually
exclusive with an already-sent explicit resolution reply to avoid duplicates.

## Native notes versus public replies

HubSpot Help Desk's Note action is internal: the contact cannot see it. A tagged
team member can receive an internal notification. A customer reply is a distinct
send operation. Native CRM notes and Help Desk conversation notes are related
collaboration surfaces, but should not be assumed to be the same API/thread record.
Logging an email engagement is also not equivalent to sending an email.

“Internal” means not visible to the customer—not necessarily private from Ochre
employees with account access. Do not copy decision-tree IP or SpringMath-only
engineering details into shared HubSpot notes. Use an approved customer-safe
investigation summary for cross-team work.

## Implementation and verification still required

1. Choose the exact native note/thread APIs and minimal scopes. Any broker note
   route must first verify its parent ticket's scope; it must not expose global
   note search or arbitrary cross-brand note/association IDs.
2. Add distinct, approval-gated portal actions for **Add internal note** and
   **Send customer reply**. A summary edit must not silently become either action.
3. Bind sender, requester, thread and ticket server-side, and verify actual send
   outcomes. Handle retries/idempotency without sending duplicate messages.
4. Configure the pipeline's receipt/team notification rules and explicit reply
   plus closure behavior. Verify reply routing back into the same support thread.
5. Test one synthetic handoff through receipt, Tier 2, return, reply and closure;
   check the mailbox and send/delivery evidence, not just ticket activity.

SpringMath's test subscription showed Marketing Hub Professional and Content Hub
Professional, not paid Service Hub. Native ticket-email automation needs the
appropriate Service Hub entitlement. We have **not** configured or verified that
automation here, nor inspected Ochre's existing rules. A native CRM note can still
be demonstrated separately, but it would not prove customer email delivery.

Sources: [HubSpot internal notes and replies](https://knowledge.hubspot.com/help-desk/create-respond-to-tickets-in-help-desk),
[ticket-status automation](https://knowledge.hubspot.com/object-settings/set-up-pipeline-automations-for-objects),
[CRM notes API](https://developers.hubspot.com/docs/api-reference/latest/crm/activities/notes/guide).
