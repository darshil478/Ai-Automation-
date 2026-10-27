require("dotenv").config();
const express = require("express");
const { ViaSocket } = require("viasocket-apps");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const requiredEnv = ["VIASOCKET_ORG_ID", "VIASOCKET_PROJECT_ID", "VIASOCKET_EMBED_SECRET"];
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

// Replace this development identity with the authenticated application's user ID.
// Never accept uniqueIdentifier from the request body.
function getProductUserId(req) {
  if (process.env.NODE_ENV === "production") {
    const userId = req.user && req.user.id;
    if (!userId) {
      const error = new Error("Authenticated user required");
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

// A fresh short-lived token is minted by the SDK for the Connect popup.
// The signing secret never leaves this server.
app.get("/api/viasocket-token", async (req, res, next) => {
  try {
    const user = getViaSocket().user(getProductUserId(req));
    res.type("text/plain").send(await user.token());
  } catch (error) {
    next(error);
  }
});

// Search the live viaSocket catalog; users choose which app to connect.
app.get("/api/integrations/search", async (req, res, next) => {
  try {
    const term = String(req.query.q || "").trim();
    if (!term || term.length > 100) return res.json([]);
    const result = await getViaSocket().catalog.search(term);
    const apps = Array.isArray(result) ? result : (result?.data || []);
    res.json(apps.map((item) => ({
      serviceId: item.serviceId || item.service_id,
      name: item.name,
      description: item.description,
      icon: item.icon || item.iconurl
    })).filter((item) => item.serviceId && item.name));
  } catch (error) {
    next(error);
  }
});

// Connection persistence and action execution are intentionally not faked.
// Add them only alongside the project's authenticated user store and a real
// user-authorized auth_id; never accept script_id or auth_id from arbitrary clients.
app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 502;
  res.status(status).json({
    error: status === 503 ? error.message : "viaSocket request failed",
    detail: process.env.NODE_ENV === "production" ? undefined : error.message
  });
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, () => console.log(`FlowPilot viaSocket adapter listening on port ${port}`));
}
module.exports = { app, getViaSocket, getProductUserId };
