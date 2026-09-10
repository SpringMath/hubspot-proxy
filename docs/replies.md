# Ticket-bound customer replies

An internal CRM note does not send email. **Send customer reply** is a separate,
human-approved operation on one existing ticket-linked HubSpot email thread.
Creating or closing a CRM ticket does not itself prove email delivery.

## Configure the broker

All values below are server environment variables; use your own HubSpot IDs.

```dotenv
BROKER_ENABLE_REPLIES=true
HUBSPOT_EMAIL_INBOX_ID=<allowed inbox ID>
HUBSPOT_EMAIL_CHANNEL_ACCOUNT_ID=<active native email channel account ID>
HUBSPOT_EMAIL_SENDER_ACTOR_ID=A-<authorized sending agent ID>
BROKER_SEND_RESERVATION_DIR=/data/reply-reservations
```

Sending also requires `BROKER_ENABLE_WRITES=true` and the existing operational
ownership-freeze assurance. Freeze ticket pipeline/product classification,
requester and thread associations, mailbox routing and sending-agent access while
writes are enabled. Disable broker access before reclassification. HubSpot has no
atomic compare-and-send across these records; readback cannot undo a raced send.

Grant `conversations.read` and `conversations.write` in addition to the existing
ticket/contact scopes. The broker verifies the pinned inbox, active authorized
email channel and sending agent on every inspection. No other inbox/thread API
is exposed. Shared contacts do not grant access to their other conversations.

## Persistent storage is mandatory for replies

Mount trusted persistent storage at `/data`, writable by UID/GID 1000. The broker
creates a private `0700` child directory; the parent must already exist with no
symlink path components. Use a filesystem that honors exclusive creation and
file/directory `fsync`. Do not use `emptyDir` or container-local storage.

For the SpringMath AU demo, an administrator applies
`k8s/bootstrap/au-reply-storage.yaml` once. The AU overlay mounts the encrypted
1Gi EBS claim and uses one replica with `Recreate` rollouts. This causes a brief
broker interruption during deployment. CI cannot create/delete the claim.

The broker reserves a hash of the complete email-message ID set **before** the
send. Reservations contain no email addresses, bodies or credentials. They never
expire or get released, even on timeout. Concurrent requests and restarts cannot
retry the same history. Monitor disk capacity and retain the ledger across
rollbacks. Never delete a claim to retry an uncertain send; reconcile in HubSpot.
After lost storage, keep replies disabled until the ledger is safely recovered.
Host/storage administrators remain trusted and can defeat filesystem guarantees.

## API

- `GET /springmath/v1/tickets/{ticketId}/reply-context` returns a bounded preview,
  verified `to`/`from`/`subject`, `ticketUpdatedAt`, `contextVersion` and
  `dispatchVersion`. Content is explicitly untrusted; contact/actor/channel IDs
  and unrelated metadata are withheld.
- `POST /springmath/v1/tickets/{ticketId}/replies` accepts only
  `{accountId, expectedUpdatedAt, contextVersion, to, from, subject, body}`.
  Routing is re-derived and compared with the approved preview, not trusted from
  the request. The body is plain text, at most 10,000 characters.
- A verified readback returns `201` with `customerReplyAccepted:true`, message ID
  and `emailDelivery:"not_verified"`. Check the recipient mailbox for delivery.

Reads and sends require one complete contact association, one complete linked
email thread, and at least one incoming email from that requester. CC/BCC,
multiple recipients/threads, paginated or oversized histories, mismatched
ownership and malformed vendor data fail closed. At most 100 messages/200KB of
text are inspected; previews show the last 20, up to 2,000 characters each.

`REPLY_CONTEXT_UNAVAILABLE` means the safe reply prerequisites are not met.
`STALE_APPROVAL` requires a fresh preview and approval.
`REPLY_DISPATCH_ALREADY_RESERVED` or `WRITE_OUTCOME_UNKNOWN` requires read-only
reconciliation; **never automatically retry**. `REPLY_RESERVATION_UNAVAILABLE`
means sending is unavailable until durable storage is healthy.

## First test

1. Create a synthetic ticket through the broker-backed app; verify the requester
   contact association.
2. Start an email from that ticket in HubSpot, then have the requester reply.
   The native Conversations API does not document creating an initial outbound
   thread from an API-created ticket. Do not substitute a logged email engagement.
3. Open the ticket in the portal, inspect reply context, approve a synthetic
   reply and verify the same thread plus the recipient mailbox.
4. Test replay, stale approval and a different-brand ticket: no extra email and
   no foreign content may escape.

References: [native Conversations guide](https://developers.hubspot.com/docs/api-reference/legacy/conversations/guide),
[send schema](https://developers.hubspot.com/docs/api-reference/legacy/conversations/conversations/threads/create-conversation),
[ticket/thread distinction](https://developers.hubspot.com/blog/a-developers-guide-to-hubspot-crm-objects-ticket-object).
