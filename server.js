require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.static("public"));

app.get("/api/viasocket-token", (req, res) => {
  const userId = "user_1"; // later: use your real logged-in user's id

  const token = jwt.sign(
    {
      org_id: process.env.VIASOCKET_ORG_ID,
      project_id: process.env.VIASOCKET_PROJECT_ID,
      unique_identifier: userId,
    },
    process.env.VIASOCKET_EMBED_SECRET,
    { algorithm: "HS256" }
  );

  res.json({ token });
});

app.listen(3000, () => console.log("Running on http://localhost:3000"));
