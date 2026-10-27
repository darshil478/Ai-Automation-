# FlowPilot AI

**Human-in-the-loop business workflow automation** built with Node.js, Express, and the viaSocket SDK.

FlowPilot demonstrates a small-business lead follow-up workflow: receive lead details, validate the input, assign a priority using deterministic rules, prepare a contextual email, and pause for human review before invoking Gmail's **Create Email Draft** action.

> **Project status:** Working development/demo implementation. The webhook and audit trail use in-memory storage. Verify the Gmail action end-to-end in your own viaSocket/Gmail test account before describing it as successfully tested.

## Demo at a glance

1. **Trigger:** Submit lead details through the UI or the webhook endpoint.
2. **Validate:** Check required fields and the recipient email format.
3. **Decision engine:** Assign priority based on days since last contact:
   - **Low:** 0–2 days
   - **Medium:** 3–6 days
   - **High:** 7+ days
4. **Prepare follow-up:** Generate a template-based email using lead name, company, sales stage, and optional notes.
5. **Human approval:** Show the proposal and require explicit approval before the Gmail draft action.
6. **Action:** Call the published viaSocket Gmail **Create Email Draft** action. The workflow is designed to create a draft, not send the email.
7. **Audit visibility:** Inspect recent webhook events and workflow status through the audit endpoint.

## Features

- viaSocket SDK integration and live app catalog lookup
- Gmail connection popup and connection verification
- Lead-follow-up workflow endpoint and webhook intake
- Deterministic priority routing (Low / Medium / High)
- Context-aware email templates for new leads, demos, proposals, and negotiations
- Human approval gate before invoking Gmail draft creation
- Basic in-memory audit events and run status
- Dark, responsive workflow dashboard with an approval desk and run log
- Input validation and optional shared-secret protection for webhook requests

## Tech stack

- **Runtime:** Node.js 20+
- **Backend:** Express
- **Integration:** `viasocket-apps` SDK
- **Frontend:** HTML, CSS, JavaScript
- **Configuration:** dotenv

## Run locally

### Prerequisites

- Node.js 20 or newer and npm
- A configured viaSocket project
- A Gmail account you can authorize for testing

### Setup

1. Clone or pull this repository.
2. Create a local `.env` file from the example:

   **PowerShell**
   ```powershell
   Copy-Item .env.example .env
   ```

3. Open `.env` and set your actual `VIASOCKET_EMBED_SECRET`. Keep this secret private. Never paste it into the frontend, commit it, or share it in screenshots.
4. Install and start:

   ```powershell
   npm install
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000).
6. Select **Connect / refresh Gmail**, authorize your test account in the viaSocket popup, and confirm the connection status.
7. Try a sample lead using an email address you control. Review the proposed message and explicitly approve before testing Gmail draft creation.
8. Open Gmail's **Drafts** folder to verify the result. Only claim end-to-end success if the draft is actually present and the server/API returned a successful result.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `VIASOCKET_ORG_ID` | Yes | viaSocket organization identifier |
| `VIASOCKET_PROJECT_ID` | Yes | viaSocket project identifier |
| `VIASOCKET_EMBED_SECRET` | Yes | Server-side signing secret; never expose publicly |
| `PORT` | No | Server port; defaults to `3000` |
| `NODE_ENV` | No | Runtime mode |
| `DEV_USER_ID` | No | Local development identity |
| `FLOWPILOT_WEBHOOK_SECRET` | Optional | If set, webhook requests must send it in the `x-flowpilot-webhook-secret` header |

## Webhook example

The endpoint accepts a JSON lead event and prepares a proposal for review. It does **not** send an email or create a Gmail draft by itself.

**Endpoint:** `POST /api/webhooks/leads`

Example using PowerShell (replace the email with one you control):

```powershell
$lead = @{
  leadName = "Alex Morgan"
  company = "Northstar Studio"
  to = "you@example.com"
  stage = "Proposal sent"
  lastContactDays = 4
  notes = "Requested pricing and implementation timeline"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/webhooks/leads" `
  -ContentType "application/json" `
  -Body $lead
```

Supported `stage` values: `New lead`, `Demo completed`, `Proposal sent`, `Negotiation`.

If `FLOWPILOT_WEBHOOK_SECRET` is configured, include the matching `x-flowpilot-webhook-secret` header. In production, configure a strong secret and proper authentication before exposing the endpoint publicly.

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/integrations/search?q=Gmail` | Search the live viaSocket catalog |
| `GET` | `/api/integrations/status` | Show current process's connection status |
| `GET` | `/api/integrations/gmail/actions` | Read published Gmail action schemas |
| `POST` | `/api/integrations/gmail/verify` | Verify connection/catalog using read-only SDK calls |
| `POST` | `/api/workflows/lead-followup/run` | Run the manual lead follow-up workflow |
| `POST` | `/api/webhooks/leads` | Accept and classify a lead webhook event |
| `GET` | `/api/workflows/audit` | Read recent in-memory audit events |
| `POST` | `/api/gmail/drafts/prepare` | Prepare a draft proposal for approval |
| `GET` | `/api/gmail/drafts/pending` | List pending draft proposals |
| `POST` | `/api/gmail/drafts/:id/approve` | Approve and invoke the Gmail draft action |

All endpoints above are for the local demo. Do not expose the development server publicly without adding authentication, authorization, rate limiting, and appropriate request verification.

## Current limitations

- **No live CRM trigger:** the webhook endpoint exists, but a CRM is not connected to call it automatically. A request must be sent to the endpoint.
- **Template-based message generation:** the current email text is produced by rules/templates; this is not a full LLM-based extraction or reasoning pipeline.
- **Simple priority rules:** priority uses days since last contact and is a demo policy, not a learned prediction.
- **In-memory state:** connection data, pending approvals, and audit events are lost when the server restarts. This is not durable storage.
- **No separate task system:** the workflow returns priority-routing information but does not create tasks in a task manager.
- **Draft action must be verified:** the code invokes the viaSocket catalog's published Gmail draft action after approval. Confirm the actual result in Gmail Drafts before claiming the integration has passed an end-to-end test.
- **Not production-ready:** real user authentication, persistent per-user storage, durable audit records, webhook replay protection, retries, monitoring, and deployment hardening remain future work.

## Security notes

- Never commit `.env` or expose `VIASOCKET_EMBED_SECRET`, `authId`, or `scriptId`.
- Use a dedicated test Gmail account and a recipient you control.
- The intended external action is **Create Email Draft**, not Send Email.
- The approval queue and audit log are process-memory-only and are not a substitute for a secure production audit system.
- If deploying beyond localhost, add real authentication, access control, rate limiting, TLS, durable storage, and protected webhook configuration first.

## Suggested review demo

1. Start the server and connect Gmail.
2. Submit a lead at the **Proposal sent** stage with `lastContactDays = 4`.
3. Show the Medium priority classification and generated follow-up.
4. Review and explicitly approve the proposal.
5. If the action succeeds, open Gmail Drafts and show the created draft.
6. Send a webhook test request and show the returned workflow steps.
7. Open `/api/workflows/audit` to demonstrate the event record.
8. Explain which parts are implemented and which are demo limitations.

## License

ISC (as declared in `package.json`).
