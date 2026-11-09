"use strict";

const { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_COOKIE = "studyflow_session";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const STATIC_FILES = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/script.js": ["script.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"]
};

function createDatabase(dataDirectory = path.join(__dirname, "data")) {
    fs.mkdirSync(dataDirectory, { recursive: true });
    const db = new DatabaseSync(path.join(dataDirectory, "studyflow.sqlite"));
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL COLLATE NOCASE UNIQUE,
            full_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('student', 'admin')),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS assignments (
            id TEXT PRIMARY KEY,
            student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            subject TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            due_date TEXT NOT NULL,
            priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
            status TEXT NOT NULL CHECK (status IN ('Pending', 'In Progress', 'Completed')),
            reminder_days INTEGER NOT NULL DEFAULT 3
                CHECK (reminder_days IN (-1, 0, 1, 3, 7)),
            review_status TEXT NOT NULL DEFAULT 'Not submitted'
                CHECK (review_status IN ('Not submitted', 'Submitted', 'Approved', 'Declined')),
            grade REAL,
            feedback TEXT NOT NULL DEFAULT '',
            submitted_at TEXT,
            reviewed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (grade IS NULL OR (grade >= 0 AND grade <= 100))
        );
        CREATE INDEX IF NOT EXISTS assignments_student_due_idx
            ON assignments(student_id, due_date);
        CREATE INDEX IF NOT EXISTS assignments_review_idx
            ON assignments(review_status, submitted_at);
    `);

    const columns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
    if (!columns.includes("full_name")) {
        db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
        db.exec(`
            UPDATE users
            SET full_name = substr(email, 1, instr(email, '@') - 1)
            WHERE full_name = ''
        `);
    }
    const assignmentColumns = db.prepare("PRAGMA table_info(assignments)").all().map((column) => column.name);
    if (!assignmentColumns.includes("reminder_days")) {
        db.exec("ALTER TABLE assignments ADD COLUMN reminder_days INTEGER NOT NULL DEFAULT 3 CHECK (reminder_days IN (-1, 0, 1, 3, 7))");
    }
    return db;
}

function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
    const [algorithm, saltHex, hashHex] = String(stored).split("$");
    if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createSuperAdmin(db) {
    const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || "";
    if (!email.includes("@") || password.length < 12 || password.length > 128) {
        throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD of 12–128 characters.");
    }
    if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
        throw new Error("A Super Admin already exists.");
    }

    const createdAt = new Date().toISOString();
    const user = {
        id: randomUUID(),
        email,
        full_name: email.split("@")[0],
        password_hash: hashPassword(password),
        role: "admin",
        created_at: createdAt
    };
    db.prepare(`
        INSERT INTO users (id, email, full_name, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, user.email, user.full_name, user.password_hash, user.role, createdAt);
    return user;
}

function json(res, status, value, extraHeaders = {}) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...extraHeaders
    });
    res.end(body);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        let tooLarge = false;
        req.on("data", (chunk) => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (tooLarge) return;
            if (!chunks.length) return resolve({});
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!value || Array.isArray(value) || typeof value !== "object") {
                    throw new Error("Request body must be a JSON object.");
                }
                resolve(value);
            } catch {
                reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
            }
        });
        req.on("error", reject);
    });
}

function validDueDate(value) {
    return typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function publicUser(row) {
    return { id: row.id, full_name: row.full_name, email: row.email, role: row.role };
}

function createApplicationServer({ dataDirectory = path.join(__dirname, "data") } = {}) {
    const db = createDatabase(dataDirectory);
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const pathname = decodeURIComponent(url.pathname);
        const method = req.method || "GET";

        try {
            if (method === "GET" && STATIC_FILES[pathname]) {
                const [filename, contentType] = STATIC_FILES[pathname];
                const body = fs.readFileSync(path.join(__dirname, filename));
                res.writeHead(200, {
                    "Content-Type": contentType,
                    "Content-Length": body.length,
                    "X-Content-Type-Options": "nosniff"
                });
                res.end(body);
                return;
            }

            if (!pathname.startsWith("/api/")) {
                json(res, 404, { error: "Not found." });
                return;
            }

            const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
            if (mutation && req.headers.origin) {
                const origin = new URL(req.headers.origin);
                if (origin.host !== req.headers.host || origin.protocol !== url.protocol) {
                    json(res, 403, { error: "Cross-origin requests are not allowed." });
                    return;
                }
            }

            const body = mutation ? await readJson(req) : {};
            const cookies = Object.fromEntries(
                String(req.headers.cookie || "").split(";").map((part) => {
                    const index = part.indexOf("=");
                    return index < 0
                        ? ["", ""]
                        : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
                }).filter(([key]) => key)
            );
            const token = cookies[SESSION_COOKIE];
            const session = token
                ? db.prepare(`
                    SELECT s.token_hash, u.id, u.email, u.full_name, u.role
                    FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token_hash = ? AND s.expires_at > ?
                `).get(createHash("sha256").update(token).digest("hex"), Date.now())
                : null;
            const requireUser = () => {
                if (!session) throw Object.assign(new Error("Please sign in."), { status: 401 });
                return session;
            };
            const requireAdmin = () => {
                const user = requireUser();
                if (user.role !== "admin") {
                    throw Object.assign(new Error("Admin access required."), { status: 403 });
                }
                return user;
            };

            if (method === "POST" && pathname === "/api/register") {
                const email = String(body.email || "").trim().toLowerCase();
                const name = String(body.full_name || "").trim() || email.split("@")[0];
                if (!name || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
                    typeof body.password !== "string" || body.password.length < 8 ||
                    body.password.length > 128) {
                    json(res, 400, { error: "Enter a valid name and email, and a password of 8–128 characters." });
                    return;
                }
                const user = {
                    id: randomUUID(),
                    email,
                    full_name: name,
                    password_hash: hashPassword(body.password),
                    role: "student",
                    created_at: new Date().toISOString()
                };
                try {
                    db.prepare(`
                        INSERT INTO users (id, email, full_name, password_hash, role, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).run(user.id, user.email, user.full_name, user.password_hash, user.role, user.created_at);
                } catch (error) {
                    if (String(error.message).includes("UNIQUE")) {
                        json(res, 409, { error: "Email already registered." });
                        return;
                    }
                    throw error;
                }
                const sessionToken = randomBytes(32).toString("base64url");
                const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
                db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
                    .run(tokenHash, user.id, Date.now() + SESSION_LIFETIME_MS);
                json(res, 201, { user: publicUser(user) }, {
                    "Set-Cookie": `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1000}`
                });
                return;
            }

            if (method === "POST" && pathname === "/api/login") {
                const email = String(body.email || "").trim().toLowerCase();
                const user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
                if (!user || typeof body.password !== "string" ||
                    !verifyPassword(body.password, user.password_hash)) {
                    json(res, 401, { error: "Invalid email or password." });
                    return;
                }
                const sessionToken = randomBytes(32).toString("base64url");
                const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
                const expiresAt = Date.now() + SESSION_LIFETIME_MS;
                db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
                db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
                    .run(tokenHash, user.id, expiresAt);
                json(res, 200, { user: publicUser(user) }, {
                    "Set-Cookie": `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1000}`
                });
                return;
            }

            if (method === "GET" && pathname === "/api/me") {
                json(res, 200, { user: publicUser(requireUser()) });
                return;
            }

            if (method === "POST" && pathname === "/api/logout") {
                const user = requireUser();
                db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
                json(res, 200, { message: "Signed out successfully." }, {
                    "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
                });
                return;
            }

            if (method === "GET" && pathname === "/api/assignments") {
                const user = requireUser();
                if (user.role !== "student") {
                    json(res, 403, { error: "Student access required." });
                    return;
                }
                const assignments = db.prepare(`
                    SELECT id, title, subject, description, due_date AS dueDate,
                           priority, status, reminder_days AS reminderDays,
                           review_status AS reviewStatus, grade,
                           feedback, submitted_at AS submittedAt,
                           reviewed_at AS reviewedAt, created_at AS createdAt,
                           updated_at AS updatedAt
                    FROM assignments WHERE student_id = ?
                    ORDER BY due_date, created_at
                `).all(user.id);
                json(res, 200, { assignments });
                return;
            }

            if (method === "POST" && pathname === "/api/assignments") {
                const user = requireUser();
                if (user.role !== "student") {
                    json(res, 403, { error: "Student access required." });
                    return;
                }
                const {
                    title, subject, description = "", dueDate, due_date,
                    priority = "Medium", status = "Pending"
                } = body;
                const reminderDays = body.reminderDays === undefined ? 3 : Number(body.reminderDays);
                const due = dueDate || due_date;
                if (typeof title !== "string" || !title.trim() || title.trim().length > 180 ||
                    typeof subject !== "string" || !subject.trim() || subject.trim().length > 120 ||
                    typeof description !== "string" || description.length > 5000 ||
                    !validDueDate(due) || !["Low", "Medium", "High"].includes(priority) ||
                    ![-1, 0, 1, 3, 7].includes(reminderDays) ||
                    !["Pending", "In Progress", "Completed"].includes(status)) {
                    json(res, 400, { error: "Enter a title, subject, valid due date, reminder schedule, priority and status." });
                    return;
                }
                const now = new Date().toISOString();
                const assignment = {
                    id: randomUUID(),
                    student_id: user.id,
                    title: title.trim(),
                    subject: subject.trim(),
                    description: description.trim(),
                    due_date: due,
                    priority,
                    status,
                    reminder_days: reminderDays,
                    review_status: "Not submitted",
                    grade: null,
                    feedback: "",
                    submitted_at: null,
                    reviewed_at: null,
                    created_at: now,
                    updated_at: now
                };
                db.prepare(`
                    INSERT INTO assignments
                    (id, student_id, title, subject, description, due_date, priority, status, reminder_days,
                     review_status, grade, feedback, submitted_at, reviewed_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    assignment.id, assignment.student_id, assignment.title, assignment.subject,
                    assignment.description, assignment.due_date, assignment.priority, assignment.status,
                    assignment.reminder_days,
                    assignment.review_status, assignment.grade, assignment.feedback,
                    assignment.submitted_at, assignment.reviewed_at, assignment.created_at, assignment.updated_at
                );
                json(res, 201, { assignment: { ...assignment, dueDate: due } });
                return;
            }

            const assignmentMatch = pathname.match(/^\/api\/assignments\/([a-f0-9-]+)$/i);
            if (assignmentMatch && ["PATCH", "DELETE"].includes(method)) {
                const user = requireUser();
                if (user.role !== "student") {
                    json(res, 403, { error: "Student access required." });
                    return;
                }
                const assignment = db.prepare("SELECT * FROM assignments WHERE id = ? AND student_id = ?")
                    .get(assignmentMatch[1], user.id);
                if (!assignment) {
                    json(res, 404, { error: "Assignment not found." });
                    return;
                }
                if (method === "DELETE") {
                    db.prepare("DELETE FROM assignments WHERE id = ? AND student_id = ?")
                        .run(assignment.id, user.id);
                    json(res, 200, { message: "Assignment deleted." });
                    return;
                }
                const title = body.title === undefined ? assignment.title : String(body.title).trim();
                const subject = body.subject === undefined ? assignment.subject : String(body.subject).trim();
                const description = body.description === undefined ? assignment.description : body.description;
                const due = body.dueDate || body.due_date || assignment.due_date;
                const priority = body.priority === undefined ? assignment.priority : body.priority;
                const status = body.status === undefined ? assignment.status : body.status;
                const reminderDays = body.reminderDays === undefined
                    ? assignment.reminder_days
                    : Number(body.reminderDays);
                if (!title || title.length > 180 || !subject || subject.length > 120 ||
                    typeof description !== "string" || description.length > 5000 ||
                    !validDueDate(due) || !["Low", "Medium", "High"].includes(priority) ||
                    ![-1, 0, 1, 3, 7].includes(reminderDays) ||
                    !["Pending", "In Progress", "Completed"].includes(status)) {
                    json(res, 400, { error: "Invalid assignment details." });
                    return;
                }
                const updatedAt = new Date().toISOString();
                db.prepare(`
                    UPDATE assignments
                    SET title = ?, subject = ?, description = ?, due_date = ?, priority = ?,
                        status = ?, reminder_days = ?, updated_at = ?
                    WHERE id = ? AND student_id = ?
                `).run(title, subject, description.trim(), due, priority, status, reminderDays, updatedAt, assignment.id, user.id);
                json(res, 200, {
                    assignment: {
                        id: assignment.id, title, subject, description: description.trim(),
                        dueDate: due, priority, status, reminderDays, updatedAt
                    }
                });
                return;
            }

            const submitMatch = pathname.match(/^\/api\/assignments\/([a-f0-9-]+)\/submit$/i);
            if (method === "POST" && submitMatch) {
                const user = requireUser();
                if (user.role !== "student") {
                    json(res, 403, { error: "Student access required." });
                    return;
                }
                const assignment = db.prepare("SELECT * FROM assignments WHERE id = ? AND student_id = ?")
                    .get(submitMatch[1], user.id);
                if (!assignment) {
                    json(res, 404, { error: "Assignment not found." });
                    return;
                }
                if (assignment.review_status === "Submitted" || assignment.review_status === "Approved") {
                    json(res, 409, { error: "This assignment cannot be submitted again." });
                    return;
                }
                const submittedAt = new Date().toISOString();
                db.prepare(`
                    UPDATE assignments
                    SET review_status = 'Submitted', submitted_at = ?, reviewed_at = NULL,
                        grade = NULL, feedback = '', updated_at = ?
                    WHERE id = ? AND student_id = ?
                `).run(submittedAt, submittedAt, assignment.id, user.id);
                json(res, 200, {
                    message: "Assignment submitted successfully.",
                    assignment: { id: assignment.id, reviewStatus: "Submitted", submittedAt }
                });
                return;
            }

            if (method === "GET" && pathname === "/api/admin/dashboard") {
                requireAdmin();
                const assignments = db.prepare(`
                    SELECT a.id, a.title, a.subject, a.status,
                           a.due_date AS dueDate, a.reminder_days AS reminderDays,
                           u.full_name AS studentName
                    FROM assignments a JOIN users u ON u.id = a.student_id
                    WHERE u.role = 'student'
                    ORDER BY a.due_date, a.created_at DESC
                `).all();
                json(res, 200, { assignments });
                return;
            }

            const reviewMatch = pathname.match(/^\/api\/admin\/assignments\/([a-f0-9-]+)\/review$/i);
            if (method === "PATCH" && reviewMatch) {
                const admin = requireAdmin();
                const decision = body.decision;
                const feedback = body.feedback === undefined ? "" : body.feedback;
                const grade = body.grade;
                if (!["Approved", "Declined"].includes(decision) ||
                    typeof feedback !== "string" || feedback.length > 3000 ||
                    (decision === "Declined" && !feedback.trim())) {
                    json(res, 400, { error: "Enter a valid decision, feedback and grade from 0 to 100." });
                    return;
                }
                const assignment = db.prepare("SELECT * FROM assignments WHERE id = ?")
                    .get(reviewMatch[1]);
                if (!assignment) {
                    json(res, 404, { error: "Assignment not found." });
                    return;
                }
                if (assignment.review_status !== "Submitted") {
                    json(res, 409, { error: "Only submitted assignments can be reviewed." });
                    return;
                }
                if (decision === "Approved" && grade !== undefined &&
                    (typeof grade !== "number" || !Number.isFinite(grade) || grade < 0 || grade > 100)) {
                    json(res, 400, { error: "Grade must be a number from 0 to 100." });
                    return;
                }
                const reviewedAt = new Date().toISOString();
                const finalGrade = decision === "Approved" ? grade ?? null : null;
                db.prepare(`
                    UPDATE assignments
                    SET review_status = ?, grade = ?, feedback = ?, reviewed_at = ?, updated_at = ?
                    WHERE id = ?
                `).run(decision, finalGrade, feedback.trim(), reviewedAt, reviewedAt, assignment.id);
                json(res, 200, {
                    message: `Assignment ${decision.toLowerCase()}.`,
                    assignment: { id: assignment.id, reviewStatus: decision, grade: finalGrade, feedback: feedback.trim() }
                });
                return;
            }

            json(res, 404, { error: "Not found." });
        } catch (error) {
            const status = Number(error.status) || 500;
            if (status >= 500) console.error(error);
            if (!res.headersSent) json(res, status, { error: status === 500 ? "An unexpected server error occurred." : error.message });
            else res.destroy(error);
        }
    });

    server.on("close", () => db.close());
    return { server, db };
}

if (require.main === module) {
    const port = Number(process.env.PORT) || 3001;
    const { server } = createApplicationServer();
    server.listen(port, "127.0.0.1", () => {
        console.log(`StudyFlow running at http://127.0.0.1:${port}`);
    });
}

module.exports = { createApplicationServer, createDatabase, createSuperAdmin };
