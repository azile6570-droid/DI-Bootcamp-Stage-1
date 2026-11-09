"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplicationServer, createDatabase, createSuperAdmin } = require("../server");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "studyflow-api-test-"));
const originalAdminEmail = process.env.ADMIN_EMAIL;
const originalAdminPassword = process.env.ADMIN_PASSWORD;
let server;
let baseUrl;

before(async () => {
    process.env.ADMIN_EMAIL = "admin@example.test";
    process.env.ADMIN_PASSWORD = "TestAdminPassword2026!";
    const db = createDatabase(dataDirectory);
    try {
        createSuperAdmin(db);
    } finally {
        db.close();
        if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
        else process.env.ADMIN_EMAIL = originalAdminEmail;
        if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
        else process.env.ADMIN_PASSWORD = originalAdminPassword;
    }

    ({ server } = createApplicationServer({ dataDirectory }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
});

function createClient() {
    let cookie = "";
    return async (pathname, { method = "GET", body, origin } = {}) => {
        const headers = {};
        if (cookie) headers.Cookie = cookie;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (origin) headers.Origin = origin;
        const response = await fetch(`${baseUrl}${pathname}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0];
        return { status: response.status, body: await response.json() };
    };
}

test("serves the StudyFlow page and its assets", async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    assert.match(html, /StudyFlow \| Assignment Tracker/);
    assert.match(html, /Teacher reminders/);
    assert.doesNotMatch(html, /Teacher \/ admin portal|Student assignment review queue|Submit for review|Learn\. Submit\./);
    assert.match(html, /Upcoming plan/);
    assert.match(html, /assignmentReminder/);

    const script = await fetch(`${baseUrl}/script.js`);
    assert.equal(script.status, 200);
    const scriptText = await script.text();
    assert.match(scriptText, /\/api\/admin\/dashboard/);
    assert.match(scriptText, /Teacher reminder/);
    assert.match(scriptText, /dueSoonAssignments/);
    assert.match(scriptText, /Next seven days/);
    assert.match(scriptText, /studyflow-reminder:/);
    assert.match(scriptText, /REMINDER_CHECK_INTERVAL_MS/);
    assert.doesNotMatch(scriptText, /\/api\/assignments\/.*\/submit/);
});

test("students plan assignments and teachers see due dates and reminder schedules", async () => {
    const student = createClient();
    const admin = createClient();
    const otherStudent = createClient();

    const registration = await student("/api/register", {
        method: "POST",
        body: { email: "Student@example.test", password: "password", role: "admin" }
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.body.user.role, "student");
    assert.equal(registration.body.user.email, "student@example.test");
    assert.equal((await student("/api/me")).body.user.email, "student@example.test");
    const duplicateRegistration = await student("/api/register", {
        method: "POST",
        body: { email: "student@example.test", password: "password" }
    });
    assert.equal(duplicateRegistration.status, 409);
    assert.equal(duplicateRegistration.body.error, "Email already registered.");
    assert.equal((await student("/api/admin/dashboard")).status, 403);

    const logout = await student("/api/logout", { method: "POST" });
    assert.equal(logout.status, 200);
    assert.equal((await student("/api/me")).status, 401);
    const studentRelogin = await student("/api/login", {
        method: "POST",
        body: { email: "student@example.test", password: "password" }
    });
    assert.equal(studentRelogin.status, 200);

    const created = await student("/api/assignments", {
        method: "POST",
        body: {
            title: "Biology report",
            subject: "Biology",
            description: "Research cell division.",
            dueDate: "2030-05-20",
            priority: "High",
            status: "Pending"
        }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.assignment.reminder_days, 3);
    const assignmentId = created.body.assignment.id;

    const testDb = createDatabase(dataDirectory);
    try {
        testDb.prepare("UPDATE assignments SET review_status = 'Submitted' WHERE id = ?").run(assignmentId);
    } finally {
        testDb.close();
    }

    let reminderUpdated;
    for (const reminderDays of [7, 1, 0, -1, 3, 7]) {
        reminderUpdated = await student(`/api/assignments/${assignmentId}`, {
            method: "PATCH",
            body: { reminderDays }
        });
        assert.equal(reminderUpdated.status, 200);
        assert.equal(reminderUpdated.body.assignment.reminderDays, reminderDays);
    }
    assert.equal((await student("/api/assignments")).body.assignments[0].reminderDays, 7);
    const invalidReminder = await student(`/api/assignments/${assignmentId}`, {
        method: "PATCH",
        body: { reminderDays: 2 }
    });
    assert.equal(invalidReminder.status, 400);

    const completed = await student(`/api/assignments/${assignmentId}`, {
        method: "PATCH",
        body: { status: "Completed" }
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.assignment.status, "Completed");

    const adminLogin = await admin("/api/login", {
        method: "POST",
        body: { email: "admin@example.test", password: "TestAdminPassword2026!" }
    });
    assert.equal(adminLogin.status, 200);
    const dashboard = await admin("/api/admin/dashboard");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.students, undefined);
    assert.equal(dashboard.body.assignments[0].studentName, "student");
    assert.equal(dashboard.body.assignments[0].dueDate, "2030-05-20");
    assert.equal(dashboard.body.assignments[0].reminderDays, 7);
    assert.equal(dashboard.body.assignments[0].studentId, undefined);
    assert.equal(dashboard.body.assignments[0].studentEmail, undefined);
    assert.equal((await admin("/api/assignments")).status, 403);

    const secondRegistration = await otherStudent("/api/register", {
        method: "POST",
        body: { email: "other@example.test", password: "AnotherPassword2026!" }
    });
    assert.equal(secondRegistration.status, 201);
    assert.deepEqual((await otherStudent("/api/assignments")).body.assignments, []);
    assert.equal((await otherStudent(`/api/assignments/${assignmentId}`, {
        method: "PATCH",
        body: { status: "Pending" }
    })).status, 404);

    assert.equal((await student("/api/assignments", { method: "POST", body: {}, origin: "https://attacker.example" })).status, 403);
});
