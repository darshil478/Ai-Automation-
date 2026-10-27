# FlowPilot AI — Human-in-the-loop Business Workflow Automation

FlowPilot demonstrates a small-business lead follow-up workflow using Node.js, Express, and the viaSocket SDK. A business signal is processed with deterministic rules, turned into a personalized follow-up proposal, reviewed by a person, and then passed to Gmail's Create Email Draft action.

## Demo workflow

1. **Lead signal:** Enter lead name, company, sales stage, days since last contact, and optional notes.
2. **Priority scoring:** Deterministic backend rules assign Low, Medium, or High priority based on time since contact (under 3 days = Low, 3–6 = Medium, 7+ = High).
3. **Follow-up preparation:** A template generates a contextual email based on sales stage and lead details.
4. **Human approval:** The proposal is displayed for review; approval is required before the external Gmail draft action.
5. **Gmail draft:** The viaSocket Gmail Create Email Draft action is called using the published action version. This flow is draft-only and does not send email.
6. **Run visibility:** The UI shows workflow steps, current state, connection status, and action response.

## Technology

- Node.js and Express API
- viaSocket viasocket-apps SDK and browser Connect popup
- Gmail integration through the live viaSocket catalog
- HTML/CSS/JavaScript workflow interface
- In-memory demo approval queue and connection cache

## Run locally

Requirements: Node.js 20+ and a viaSocket project configured for this application.

1. Copy `.env.example` to `.env`.
2. Add your real `VIASOCKET_EMBED_SECRET` to `.env`. Never commit `.env`, share the secret, or put it in browser code.
3. Install dependencies and start the server:

   ```bash
   npm install
   npm start
   ```

4. Open http://localhost:3000.
5. Connect a dedicated test Gmail account through viaSocket.
6. Enter a test lead and an email address you control. Prepare the proposal, review it, then explicitly approve draft creation.
7. Verify the result in Gmail Drafts and check the action response in the UI/server output.

## What is implemented vs. demo limitations

**Implemented in this demo:** live viaSocket catalog lookup, SDK connection enablement/verification, lead-follow-up workflow endpoint, rule-based priority scoring, template-based email generation, explicit approval step, and Gmail draft-action invocation after approval.

**Limitations:** the lead is entered manually (there is no live CRM trigger); priority scoring uses simple deterministic thresholds; email generation uses templates rather than an LLM; the connection and approval queue are in memory and reset on server restart; this is not a production multi-user service. Production use would need authenticated users, durable access-controlled storage, audit logs, retries, and operational monitoring.

## Safety

- The workflow never calls a send-email action; it creates a draft only.
- Test with a Gmail account and recipient you control.
- Review the action response and verify the draft in Gmail before claiming a successful end-to-end run.
- Do not deploy the in-memory development configuration as a production service.

## Suggested review demonstration

Use a lead with a proposal sent 4 days ago. Show the Medium priority decision, personalized email proposal, approval gate, and resulting Gmail draft. Explain that the trigger is manually entered for the demo, while the decision logic and viaSocket call are handled by the backend.
