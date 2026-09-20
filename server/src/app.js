const cors = require("cors");
const express = require("express");
const passport = require("passport");
const { corsOrigin } = require("./config/env");
const { sessionMiddleware } = require("./config/session");
require("./config/passport");
require("./redis/workers/email-worker");
const { errorHandler, notFound } = require("./middleware/errors");
const coloredMorgan = require("./utils/morgan");
const authRoutes = require("./routes/auth-routes");
const friendRoutes = require("./routes/friend-routes");
const notificationRoutes = require("./routes/notification-routes");
const conversationRoutes = require("./routes/message-routes");
const groupRoutes = require("./routes/group-routes");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: "100kb" }));

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(coloredMorgan);

app.use("/health", (req, res) => {
  console.log("server connected");
  return res.json("server connected");
});

app.use("/api/v1", authRoutes);
app.use("/api/v1", friendRoutes);
app.use("/api/v1", notificationRoutes);
app.use("/api/v1", conversationRoutes);
app.use("/api/v1", groupRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = { app };
