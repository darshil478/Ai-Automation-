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
app.post("/api/gmail/drafts/:id/approve", (req, res) => {
  const queue = globalThis.__flowPilotPendingDrafts || new Map();
  const draft = queue.get(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft proposal not found; it may have expired after a server restart." });
  if (draft.status !== "awaiting_approval") return res.status(409).json({ error: "This proposal is not awaiting approval." });
  draft.status = "approved_for_draft_creation";
  draft.approvedAt = new Date().toISOString();
  res.json({
    draft: { id: draft.id, to: draft.to, subject: draft.subject, status: draft.status, approvedAt: draft.approvedAt },
    message: "Approved for the next implementation step only. No Gmail draft was created and no email was sent."
  });
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
