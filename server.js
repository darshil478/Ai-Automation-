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
