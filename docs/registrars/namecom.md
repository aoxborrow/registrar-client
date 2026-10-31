# Name.com — API Research

> Researched: 2026-10-31 (transfer out only) · Docs: https://docs.name.com/ · The adapter itself is described in the README's [Name.com Core API](../../README.md#namecom-core-api) section.

## Transfer-out approval (not implemented)

Name.com's Core API (`https://api.name.com/core/v1`, spec v1.36.0) can **reject**
a pending outbound transfer but not approve one.

- **Read:** the `Domain` object has no documented transfer-out field (its
  `locks[]` examples show only `clientTransferProhibited` and `clientHold`;
  `pendingTransfer` may appear there, unverified). The documented signal is the
  webhook `domain.transfer_out.status_change` (`initiated` / `completed` /
  `canceled`), subscribed with `POST /core/v1/notifications`.
- **Approve:** none, in Core v1 or the older v4 API (whose Transfers endpoints are
  inbound). The dashboard shows a "transfer now" button when the domain qualifies;
  otherwise ask support.
- **Reject:** `POST /core/v1/transfers/external/out/{domainName}:cancel`
  (`CancelOutboundTransfer`) with an empty `{}` JSON body → 200
  `{ domainName, status: "canceled" }`; 409 when the domain isn't pending
  transfer-out, 422 when the TLD has no explicit EPP reject. No reason field.
- **Left alone:** the transfer finishes on its own in 5–7 days. The dashboard
  also has a "Cancel Transfer Out" link.

## Sources

- https://docs.name.com/api/v1/namecom.api.yaml
- https://www.name.com/api-docs/transfers
