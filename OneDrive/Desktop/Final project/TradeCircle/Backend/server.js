require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();

if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
    throw new Error("DATABASE_URL and SESSION_SECRET must be configured.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "true"
        ? { rejectUnauthorized: true }
        : false
});

app.locals.pool = pool;

app.disable("x-powered-by");
app.use(helmet({
    // The existing frontend may load CSS/JS from CDNs.
    // Review and tighten this policy before production deployment.
    contentSecurityPolicy: false
}));

const configuredFrontendOrigins = (process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.get("Origin");
    if (!origin) return next();

    let isLocalDevelopmentOrigin = false;
    if (process.env.NODE_ENV !== "production") {
        try {
            const parsedOrigin = new URL(origin);
            isLocalDevelopmentOrigin =
                ["localhost", "127.0.0.1"].includes(parsedOrigin.hostname);
        } catch {
            isLocalDevelopmentOrigin = false;
        }
    }

    if (!configuredFrontendOrigins.includes(origin) && !isLocalDevelopmentOrigin) {
        return res.status(403).json({ error: "This frontend origin is not allowed." });
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        return res.sendStatus(204);
    }

    next();
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
}));

app.use(session({
    store: new PgSession({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: true
    }),
    name: "tradecircle.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 8
    }
}));

// Serve the existing frontend from the same origin as the API.
app.use(express.static(path.join(__dirname, "..", "Frontend", "Public")));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/products", require("./routes/products"));
app.use("/api/wishlist", require("./routes/wishlist"));
app.use("/api/reviews", require("./routes/reviews"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/deals", require("./routes/deals"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/sales", require("./routes/sales"));

app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ status: "ok", database: "connected" });
    } catch (error) {
        console.error("Database health check failed:", error.message);
        res.status(503).json({ status: "error", database: "unavailable" });
    }
});

app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);

    const databaseUnavailableCodes = new Set([
        "28P01",
        "3D000",
        "ECONNREFUSED",
        "ENOTFOUND",
        "ETIMEDOUT"
    ]);
    if (databaseUnavailableCodes.has(err.code) || databaseUnavailableCodes.has(err.errno)) {
        return res.status(503).json({
            error: "The API is running, but PostgreSQL is unavailable. Check the backend DATABASE_URL and database credentials."
        });
    }

    res.status(500).json({ error: "An unexpected server error occurred." });
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
    console.log(`TradeCircle backend running on http://localhost:${port}`);
});

pool.query("SELECT 1")
    .then(() => console.log("PostgreSQL connection established."))
    .catch((error) => {
        console.error(
            "PostgreSQL is unavailable. The site will load, but database-backed features will not work:",
            error.message
        );
    });

process.on("SIGTERM", async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    process.exit(0);
});
