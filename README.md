# FlowPilot AI — viaSocket Gmail connection spike

This repository currently contains a **Gmail connection and verification slice**, not the complete business-operations agent yet. It uses the official `viasocket-apps` Node SDK for all viaSocket calls and its browser helper for the Connect popup.

## Requirements

- Node.js 20+
- A viaSocket project with these values from the Install Code page:
  - `VIASOCKET_ORG_ID=68060`
  - `VIASOCKET_PROJECT_ID=projWvjxTLB5`
  - `VIASOCKET_EMBED_SECRET` (server-side secret)
- A Gmail test account you can authorize in the viaSocket popup.

## Run locally

1. Pull the latest repository changes.
2. Copy `.env.example` to `.env` in the project root.
3. Put the real `VIASOCKET_EMBED_SECRET` value in your local `.env`. Do not paste it into chat, commit it, or put it in browser code.
4. Install and start:

   ```bash
   npm install
   npm start
   ```

5. Open http://localhost:3000 and click **Connect Gmail**.
6. Sign in to your test Gmail account in the viaSocket popup and approve the access request.
7. The backend uses the SDK to enable the app and confirm the resulting flow. The UI lists the published actions returned by the live catalog. This step does not send or draft email.

## What is real vs not yet implemented

- **Real SDK paths in code:** viaSocket token minting, live catalog search, live catalog versions, connection enablement, and listing the user's flows.
- **Requires your local setup:** valid `VIASOCKET_EMBED_SECRET`, successful test-account authorization, and successful live SDK responses.
- **Not implemented yet:** Gmail action execution, creating drafts, human approval queue, durable per-user connection storage, full lead workflow, AI classification, database persistence, retries, and Streamlit dashboard.
- The current connection map is process-memory-only for this test slice. Restarting the server clears it. Do not deploy this development slice as a production multi-user service.

## Security notes

- The signing secret and `script_id` are server-only.
- The browser receives only the signed embed token required by the Connect popup.
- Use a dedicated test Gmail account. No message is sent by this connection flow.
- Production must add real application authentication and durable, access-controlled storage before enabling multiple users.

## viaSocket static check

After installing dependencies, run the official checker from the project root:

```bash
curl -fsSL https://flow.viasocket.com/viasocket-check.mjs -o viasocket-check.mjs
node viasocket-check.mjs .
```

The checker requires Node.js and network access to the viaSocket catalog. Record its actual output; do not claim a pass unless it exits successfully.
