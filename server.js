require("dotenv").config();
const express = require("express");
const path = require("node:path");
const { ViaSocket } = require("viasocket-apps");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// The package's browser helper is served locally; the helper loads viaSocket's
// official connect script and handles the popup handshake.
app.use(
  "/vendor/viasocket-apps",
  express.static(path.join(path.dirname(require.resolve("viasocket-apps")), "../esm"))
);

const requiredEnv = ["VIASOCKET_ORG_ID", "VIASOCKET_PROJECT_ID", "VIASOCKET_EMBED_SECRET"];
const testConnections = new Map(); // Development-only; persist per-user auth_id/script_id before production.

function assertViaSocketConfig() {
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length) {
    const error = new Error("Missing required server environment variables: " + missing.join(", "));
    error.status = 503;
    throw error;
  }
}

function getViaSocket() {
  assertViaSocketConfig();
  return new ViaSocket({
    orgId: process.env.VIASOCKET_ORG_ID,
    projectId: process.env.VIASOCKET_PROJECT_ID,
    secret: process.env.VIASOCKET_EMBED_SECRET
  });
}

// Development uses one explicit local identity. Production must attach req.user
// from real authentication; never accept a user id from the request body.
function getProductUserId(req) {
  if (process.env.NODE_ENV === "production") {
    const userId = req.user && req.user.id;
    if (!userId) {
      const error = new Error("Authenticated user required; connect the app's real auth middleware.");
      error.status = 401;
      throw error;
    }
    return String(userId);
  }
  return process.env.DEV_USER_ID || "flowpilot-local-dev";
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "flowpilot-viasocket-adapter" });
});

// Mint the token with the SDK. It is returned only to this browser so the
// official connect popup can authorize the current product user.
app.get("/api/viasocket-token", async (req, res, next) => {
  try {
    const token = await getViaSocket().user(getProductUserId(req)).token();
    res.set("Cache-Control", "no-store").json({ token });
  } catch (error) {
    next(error);
  }
});

// Search the live catalog, not a hard-coded app id. The user picks the app
// returned by viaSocket; action ids are resolved server-side later.
app.get("/api/integrations/search", async (req, res, next) => {
  try {
    const term = String(req.query.q || "").trim();
    if (!term || term.length > 100) return res.json([]);
    const apps = await getViaSocket().catalog.search(term);
    res.json(apps.map((item) => ({
      serviceId: item.serviceId,
      name: item.name,
      description: item.description,
      iconUrl: item.iconUrl
    })).filter((item) => item.serviceId && item.name));
  } catch (error) {
    next(error);
  }
});

// Development test flow: the browser returns authId after the user approves
// Gmail. Keep authId and scriptId on the server, never return/log either one.
app.post("/api/integrations/connection", async (req, res, next) => {
  try {
    const userId = getProductUserId(req);
    const { serviceId, authId } = req.body || {};
    if (typeof serviceId !== "string" || !/^[A-Za-z0-9]+$/.test(serviceId)) {
      return res.status(400).json({ error: "Choose a valid app from the viaSocket catalog." });
    }
    if (typeof authId !== "string" || authId.length < 5 || authId.length > 500) {
      return res.status(400).json({ error: "viaSocket did not return a valid connection. Please try connecting again." });
    }

    const vs = getViaSocket();
    const user = vs.user(userId);
    const catalog = await vs.catalog.versions(serviceId);
    if (!catalog || !/gmail/i.test(catalog.service.name || "")) {
      return res.status(400).json({ error: "For this test, choose the Gmail app from the live catalog." });
    }

    // One connection per user/app. Reuse an existing enabled flow rather than
    // creating duplicate script ids for the same app.
    let scriptId = await user.findEnabled(serviceId);
    if (!scriptId) {
      const enabled = await user.enable(serviceId, authId);
      scriptId = enabled.scriptId;
    }

    const flows = await user.listFlows();
    const flow = flows.find((item) => item.serviceId === serviceId &&
      (item.status === "active" || item.status === "paused"));
    if (!flow) {
      return res.status(502).json({ error: "viaSocket did not confirm an enabled Gmail connection. No action was run." });
    }

    testConnections.set(userId + ":" + serviceId, {
      serviceId,
      authId,
      scriptId: flow.id || scriptId,
      appName: catalog.service.name,
      actions: catalog.actions.map((action) => ({
        name: action.name,
        description: action.description || "",
        inputSchema: action.input_schema || {}
      }))
    });

    res.json({
      connected: true,
      appName: catalog.service.name,
      verification: "viaSocket SDK enabled the connection and confirmed it in the user's flows.",
      actions: catalog.actions.map((action) => ({
        name: action.name,
        description: action.description || ""
      }))
    });
  } catch (error) {
    next(error);
  }
});


app.post("/api/integrations/gmail/verify", async (req, res, next) => {
  try {
    const userId = getProductUserId(req);
    const saved = [...testConnections.entries()].find(([key, value]) =>
      key.startsWith(userId + ":") && /gmail/i.test(value.appName)
    )?.[1];
    if (!saved) {
      return res.status(409).json({
        verified: false,
        error: "No Gmail connection is stored in this running server process. Reconnect Gmail first."
      });
    }

    // Two real, read-only SDK calls: fetch the current Gmail action catalog and
    // list this product user's viaSocket connections. No email action is executed.
    const viasocket = getViaSocket();
    const user = viasocket.user(userId);
    const [catalog, connections] = await Promise.all([
      viasocket.catalog.versions(saved.serviceId),
      user.listConnections()
    ]);
    if (!catalog) {
      return res.status(502).json({ verified: false, error: "Gmail was not found in the live viaSocket catalog." });
    }

    res.json({
      verified: true,
      app: catalog.service.name,
      connectionListRead: true,
      connectionCount: connections.length,
      publishedActions: catalog.actions.map((action) => ({
        name: action.name,
        actionId: action.action_id,
        versionId: action.action_version_id
      })),
      publishedTriggers: catalog.triggers.map((trigger) => ({
        name: trigger.name,
        triggerId: trigger.trigger_id,
        versionId: trigger.trigger_version_id
      })),
      note: "Read-only SDK calls succeeded. No Gmail message was sent or drafted."
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/integrations/gmail/actions", async (req, res, next) => {
  try {
    const { userId, connection } = requireGmailTestConnection(req);
    const catalog = await getViaSocket().catalog.versions(connection.serviceId);
    if (!catalog) return res.status(502).json({ error: "Gmail is missing from the live viaSocket catalog." });
    res.set("Cache-Control", "no-store").json({
      app: catalog.service.name,
      actions: catalog.actions.map((action) => ({
        name: action.name,
        description: action.description || "",
        actionId: action.action_id,
        versionId: action.action_version_id,
        inputSchema: action.input_schema || {}
      }))
    });
  } catch (error) { next(error); }
});

app.get("/api/integrations/status", (req, res, next) => {
  try {
    const userId = getProductUserId(req);
    const apps = [...testConnections.values()]
      .filter((item) => testConnections.get(userId + ":" + item.serviceId) === item)
      .map((item) => ({ serviceId: item.serviceId, appName: item.appName, connected: true }));
    res.json({ mode: "development-memory-only", apps });
  } catch (error) {
    next(error);
  }
});


function requireGmailTestConnection(req) {
  const userId = getProductUserId(req);
  const entry = [...testConnections.entries()].find(([key, value]) =>
    key.startsWith(userId + ":") && /gmail/i.test(value.appName)
  );
  if (!entry) {
    const error = new Error("No verified Gmail connection is available in this server process. Reconnect Gmail first.");
    error.status = 409;
    throw error;
  }
  return { userId, connection: entry[1] };
}

// A deterministic workflow runner: evaluate a lead signal, score urgency, draft a
// contextual follow-up, and stop at a human approval gate before any Gmail action.
app.post("/api/workflows/lead-followup/run", async (req, res, next) => {
  try {
    requireGmailTestConnection(req);
    const { leadName, company, to, stage, lastContactDays, notes } = req.body || {};
    const validEmail = typeof to === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);
    const days = Number(lastContactDays);
    if (!validEmail || typeof leadName !== "string" || !leadName.trim() ||
        typeof company !== "string" || !company.trim() ||
        !Number.isInteger(days) || days < 0 || days > 365 ||
        typeof stage !== "string" || !["New lead", "Demo completed", "Proposal sent", "Negotiation"].includes(stage)) {
      return res.status(400).json({ error: "Provide leadName, company, valid recipient email, a supported stage, and lastContactDays (0–365)." });
    }
    const clean = (value, max=1000) => String(value || "").trim().slice(0, max);
    const name = clean(leadName, 100), org = clean(company, 120), context = clean(notes, 1000);
    const priority = days >= 7 ? "High" : days >= 3 ? "Medium" : "Low";
    const subject = stage === "Proposal sent" ? "Following up on the proposal for " + org
      : stage === "Demo completed" ? "Next steps after our demo — " + org
      : stage === "Negotiation" ? "Checking in on next steps — " + org
      : "Thanks for your interest, " + name;
    const detail = context ? "\n\nFor context, I noted: " + context : "";
    const body = "Hi " + name + ",\n\n" +
      (stage === "Proposal sent" ? "I wanted to follow up on the proposal we shared with " + org + ". I’d be happy to answer questions or discuss any adjustments that would make it a better fit."
      : stage === "Demo completed" ? "Thanks again for taking the time to see the demo. I’d love to hear your thoughts and help clarify any questions from your team."
      : stage === "Negotiation" ? "I wanted to check in on our discussion and see whether there’s anything else you need from us to decide on next steps."
      : "Thanks for your interest in " + org + ". I’d be glad to learn more about your priorities and share the most relevant next steps.") +
      detail + "\n\nWould a brief 15-minute call this week work for you?\n\nBest,\nFlowPilot Team";
    const pending = {
      id: require("node:crypto").randomUUID(), to: to.trim(), subject, body,
      actionName: "Create Email Draft", status: "awaiting_approval",
      workflow: "lead-follow-up", leadName: name, company: org, stage, lastContactDays: days,
      priority, createdAt: new Date().toISOString(),
      steps: [
        { name: "Lead signal received", status: "completed", detail: stage + " · no reply for " + days + " day(s)" },
        { name: "Rule-based priority scoring", status: "completed", detail: priority + " priority" },
        { name: "Personalized follow-up generated", status: "completed", detail: "Used lead, company, stage and notes" },
        { name: "Human approval gate", status: "waiting", detail: "Review the draft before creating it in Gmail" },
        { name: "Gmail Create Email Draft", status: "blocked_pending_approval", detail: "No external action run yet" }
      ]
    };
    globalThis.__flowPilotPendingDrafts ||= new Map();
    globalThis.__flowPilotPendingDrafts.set(pending.id, pending);
    res.status(201).json({
      workflow: "lead-follow-up",
      runId: pending.id,
      priority,
      steps: pending.steps,
      draft: { id: pending.id, to: pending.to, subject: pending.subject, body: pending.body, status: pending.status },
      message: "Workflow ran through preparation and paused for approval. No email was sent or Gmail draft created yet."
    });
  } catch (error) { next(error); }
});

// Prepare a draft using the actual published Gmail action, but never execute
// an action that sends mail. The draft requires an explicit human approval.
app.post("/api/gmail/drafts/prepare", async (req, res, next) => {
  try {
    const { connection } = requireGmailTestConnection(req);
    const { to, subject, body } = req.body || {};
    const validEmail = typeof to === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);
    if (!validEmail || typeof subject !== "string" || !subject.trim() || subject.length > 250 ||
        typeof body !== "string" || !body.trim() || body.length > 20000) {
      return res.status(400).json({ error: "Provide a valid recipient email, a subject (max 250 chars), and a body (max 20,000 chars)." });
    }
    const draftAction = connection.actions.find((action) => /create.*draft|draft.*create/i.test(action.name));
    if (!draftAction) {
      return res.status(409).json({
        error: "The live Gmail catalog did not return a published Create Draft action. No action was executed.",
        availableActions: connection.actions.map((action) => action.name)
      });
    }
    const pending = {
      id: require("node:crypto").randomUUID(),
      to, subject: subject.trim(), body: body.trim(),
      actionName: draftAction.name,
      status: "awaiting_approval",
      createdAt: new Date().toISOString()
    };
    // Demo-only in-memory approval queue; no Gmail action has run yet.
    globalThis.__flowPilotPendingDrafts ||= new Map();
    globalThis.__flowPilotPendingDrafts.set(pending.id, pending);
    res.status(201).json({
      draft: { id: pending.id, to: pending.to, subject: pending.subject, body: pending.body, status: pending.status, createdAt: pending.createdAt },
      message: "Prepared for human review only. This has NOT created a Gmail draft or sent an email."
    });
  } catch (error) { next(error); }
});

app.get("/api/gmail/drafts/pending", (_req, res) => {
  const queue = globalThis.__flowPilotPendingDrafts || new Map();
  res.json([...queue.values()].filter((draft) => draft.status === "awaiting_approval").map((draft) => ({
    id: draft.id, to: draft.to, subject: draft.subject, body: draft.body,
    status: draft.status, createdAt: draft.createdAt
  })));
});

// Approval only marks the proposal approved. It intentionally does not send
// mail; wiring actual Gmail Create Draft requires a confirmed action input schema.
app.post("/api/gmail/drafts/:id/approve", async (req, res, next) => {
  try {
    const queue = globalThis.__flowPilotPendingDrafts || new Map();
    const draft = queue.get(req.params.id);
    if (!draft) return res.status(404).json({ error: "Draft proposal not found; it may have expired after a server restart." });
    if (draft.status !== "awaiting_approval") return res.status(409).json({ error: "This proposal is not awaiting approval." });

    const { connection } = requireGmailTestConnection(req);
    const catalog = await getViaSocket().catalog.versions(connection.serviceId);
    const action = catalog?.actions?.find((item) => item.name === "Create Email Draft");
    if (!action?.action_version_id) return res.status(409).json({ error: "Create Email Draft has no published action version in the live Gmail catalog. Nothing was executed." });

    // Only invoke the catalog-confirmed draft action, with plain-text fields.
    // This endpoint never invokes a send-email action.
    const result = await getViaSocket().runAction(connection.scriptId, action.action_version_id, {
      to: draft.to,
      subject: draft.subject,
      messageType: "text",
      messageBody: draft.body
    });
    draft.status = "draft_created";
    draft.approvedAt = new Date().toISOString();
    draft.createdAtGmail = new Date().toISOString();
    draft.result = result;
    res.json({
      draft: { id: draft.id, to: draft.to, subject: draft.subject, status: draft.status, approvedAt: draft.approvedAt },
      result,
      message: "Gmail Create Email Draft action executed. This creates a draft only; it does not send the email."
    });
  } catch (error) { next(error); }
});

globalThis.__flowPilotAudit ||= [];
app.get("/api/workflows/audit", (_req, res) => {
  res.json({ persistence: "memory-only", events: (globalThis.__flowPilotAudit || []).slice(-100).reverse() });
});
function auditEvent(event) {
  globalThis.__flowPilotAudit ||= [];
  globalThis.__flowPilotAudit.push({ at: new Date().toISOString(), ...event });
  if (globalThis.__flowPilotAudit.length > 500) globalThis.__flowPilotAudit.shift();
}
app.post("/api/webhooks/leads", async (req, res, next) => {
  try {
    const secret = process.env.FLOWPILOT_WEBHOOK_SECRET;
    if (process.env.NODE_ENV === "production" && !secret) return res.status(503).json({ error: "Configure FLOWPILOT_WEBHOOK_SECRET before production webhook intake." });
    if (secret && req.get("x-flowpilot-webhook-secret") !== secret) return res.status(401).json({ error: "Invalid webhook secret." });
    const { leadName, company, to, stage, lastContactDays, notes } = req.body || {};
    const validEmail = typeof to === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);
    const days = Number(lastContactDays);
    const stages = ["New lead", "Demo completed", "Proposal sent", "Negotiation"];
    if (!validEmail || typeof leadName !== "string" || !leadName.trim() || typeof company !== "string" || !company.trim() || !Number.isInteger(days) || days < 0 || days > 365 || !stages.includes(stage)) {
      return res.status(400).json({ error: "Expected leadName, company, valid to email, stage, lastContactDays (0–365), and optional notes." });
    }
    const name = leadName.trim().slice(0,100), org = company.trim().slice(0,120), context = String(notes || "").trim().slice(0,1000);
    const priority = days >= 7 ? "High" : days >= 3 ? "Medium" : "Low";
    const subject = stage === "Proposal sent" ? "Following up on the proposal for " + org : stage === "Demo completed" ? "Next steps after our demo — " + org : stage === "Negotiation" ? "Checking in on next steps — " + org : "Thanks for your interest, " + name;
    const opener = stage === "Proposal sent" ? "I wanted to follow up on the proposal we shared with " + org + ". I’d be happy to answer questions or discuss adjustments." : stage === "Demo completed" ? "Thanks again for taking the time to see the demo. I’d love to hear your thoughts and answer any questions." : stage === "Negotiation" ? "I wanted to check in on our discussion and see whether you need anything else from us to decide on next steps." : "Thanks for your interest in " + org + ". I’d be glad to learn more about your priorities and share relevant next steps.";
    const body = "Hi " + name + ",\n\n" + opener + (context ? "\n\nFor context, I noted: " + context : "") + "\n\nWould a brief 15-minute call this week work for you?\n\nBest,\nFlowPilot Team";
    const draft = { id: require("node:crypto").randomUUID(), to: to.trim(), subject, body, actionName: "Create Email Draft", status: "awaiting_approval", workflow: "lead-follow-up", leadName: name, company: org, stage, lastContactDays: days, priority, createdAt: new Date().toISOString() };
    globalThis.__flowPilotPendingDrafts ||= new Map();
    globalThis.__flowPilotPendingDrafts.set(draft.id, draft);
    auditEvent({ event: "lead_webhook_received", leadName: name, company: org, priority, stage, status: draft.status, runId: draft.id });
    res.status(202).json({ accepted: true, runId: draft.id, priority, status: draft.status, steps: [
      { name: "Webhook trigger", status: "completed" }, { name: "Lead details validated", status: "completed" },
      { name: "Rule-based classification", status: "completed", result: priority },
      { name: "Follow-up proposal generated", status: "completed" },
      { name: priority === "High" ? "Approval + task" : priority === "Medium" ? "Follow-up queue" : "Record + review", status: "awaiting_review" },
      { name: "Audit trail", status: "completed", result: "memory-only" }
    ], draft: { id: draft.id, to: draft.to, subject: draft.subject, body: draft.body }, message: "Webhook processed and proposal queued for review. No email was sent and no Gmail draft was created." });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 502;
  res.status(status).json({
    error: status === 503 || status === 401 ? error.message : "viaSocket request failed",
    detail: process.env.NODE_ENV === "production" ? undefined : error.message
  });
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, () => console.log(`FlowPilot viaSocket adapter listening on port ${port}`));
}
module.exports = { app, getViaSocket, getProductUserId };
