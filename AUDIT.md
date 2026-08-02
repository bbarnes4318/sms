# Production Audit — SMS Gateway

Audited at commit `53fb29d` on `master`. Findings verified by reading code, not from
commit messages or prior summaries.

## Message paths

### Outbound (every path that can create a row in `messages` with `direction='outbound'`)

| # | Path | Entry point | Suppression at audit time |
|---|------|-------------|---------------------------|
| 1 | Individual send | `POST /api/conversations/:id/messages` → `insertMessage()` | **NONE** |
| 2 | Bulk selected | `POST /api/conversations/bulk-message` → `sendBulkMessages()` | partial |
| 3 | Stage campaign | `POST /api/campaigns` → `sendBulkMessages()` | partial |
| 4 | CSV upload / reimport | `POST /api/leads/upload` → `bulkImportLeads()` | partial |
| 5 | Queue dequeue | `queue.js` `processNext()` → `getNextQueuedMessage()` | **NONE** |
| 6 | Carrier retry | `queue.js` `sendSmsWithRetry()` | **NONE** (inherits 5) |

Paths 2–4 shared one check; paths 1, 5 and 6 had none at all.

### Inbound

| Path | Entry point | Notes |
|------|-------------|-------|
| Carrier webhook | `POST /webhook/inbound` | Unauthenticated by design (carrier callback). Handles both messages and BulkVS delivery receipts. |

## Schema at audit time

`conversations`: id, phone_number, name, last_message_text, last_message_at, stage,
created_at, unread, city, disposition, disposition_at, scheduled_at, disposition_note.
Production additionally has `assigned_did` and `zip` from an unmerged branch.

`messages`: id, conversation_id, direction, from_number, to_number, body, media_urls,
status, ref_id, error_message, scheduled_at, sent_at, created_at.
`status` carries a CHECK constraint limiting it to
`queued|sending|sent|failed|received`.

## Defects found

| ID | Defect | Why it matters |
|----|--------|----------------|
| D1 | Individual send has no suppression check | An opted-out contact can be messaged directly with no warning. Legal exposure. |
| D2 | Queue worker never re-checks suppression before handing a message to the carrier | A message queued (or future-scheduled) before an opt-out still sends afterwards. |
| D3 | Suppression inferred from the **latest** inbound message only | Any message after `STOP` silently un-suppresses the contact. |
| D4 | `bulkImportLeads` pushes to `insertedConvs` before the block check | `imported_count` counts contacts that were skipped. |
| D5 | Keyword lists duplicated in `database.js` and `public/app.js` | The two silently drift; UI and enforcement disagree. |
| D6 | Every negative reply treated as an opt-out | "No thanks" is not a legal opt-out. UI labelled all of them "Opted out". |
| D7 | Wrong numbers have no representation | Cannot be excluded or reported on. |
| D8 | BulkVS **does** deliver DLR callbacks (`stat:DELIVRD`) but `DELIVRD` is only logged | Real delivery data was being discarded while stats called carrier-acceptance "Delivered". |
| D9 | `scheduled_at` written as browser-local, compared against `datetime('now','localtime')` | Server runs UTC; overdue and date-range maths are wrong for any non-UTC user. |
| D10 | No validation on disposition `scheduled_at` | Any string is accepted and stored. |
| D11 | `express.json()` at default 100 kb | Large CSV imports are rejected with an opaque error. |
| D12 | `parseInt(req.params.id)` unvalidated | `NaN` reaches SQL and returns misleading 404/500s. |
| D13 | `renderTimelineItem` interpolates message bodies into HTML unescaped | **Stored XSS via inbound SMS** — a hostile reply executes script in the dashboard. |
| D14 | Session cookie has no `Secure` attribute | Cookie sent in the clear if ever served over HTTP. |
| D15 | No rate limiting on `/api/auth/login` | Unbounded credential stuffing. |
| D16 | `package-lock.json` is gitignored | `npm ci` is impossible, so CI cannot install reproducibly. |
| D17 | Phone rotation branch never merged to `master` | Production ran rotation across 7 DIDs; deploying `master` silently reverted it. |
| D18 | Positive-response stats count messages, not unique contacts | One chatty lead inflates the headline number. |

## Deployment

Deployed from this repo by `scripts/deploy.py` over SSH (key at `scripts/id_ed25519`,
gitignored) to a Hetzner host running systemd unit `sms-gateway` behind nginx.
The Hetzner API token is only used by `scripts/create_server.py` for provisioning.
