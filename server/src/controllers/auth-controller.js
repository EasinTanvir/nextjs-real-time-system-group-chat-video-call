const passport = require("passport");
const {
  register: registerService,
  sanitizeUser,
} = require("../services/auth-service");
const { emailQueue } = require("../queues/email-queue");
const { db } = require("../db/client");
const { users } = require("../db/schema");
const { eq } = require("drizzle-orm");

async function register(req, res, next) {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({
        success: false,
        message: "email, username and password are required",
      });
    }

    const user = await registerService({ email, username, password });

    await emailQueue.add(
      "verify-email",
      {
        type: "verify-email",
        email: user.email,
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    req.login(user, (err) => {
      if (err) return next(err);
      return res
        .status(201)
        .json({ success: true, data: { user: sanitizeUser(user) } });
    });
  } catch (err) {
    next(err);
  }
}

function login(req, res, next) {
  passport.authenticate("local", async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: info?.message || "Invalid credentials",
      });
    }

    req.login(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      return res
        .status(200)
        .json({ success: true, data: { user: sanitizeUser(user) } });
    });
  })(req, res, next);
}

function logout(req, res, next) {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy((destroyErr) => {
      if (destroyErr) return next(destroyErr);
      res.clearCookie("sid");
      return res
        .status(200)
        .json({ success: true, data: { status: "logged out" } });
    });
  });
}

function googleCallback(req, res) {
  // req.user is set by Passport after a successful Google auth + req.login
  res.redirect(process.env.CLIENT_URL || "/");
}

async function me(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: { user },
    });
  } catch (err) {
    console.error("=== ME ERROR ===", err);
    next(err);
  }
}
module.exports = { register, login, logout, googleCallback, me };
