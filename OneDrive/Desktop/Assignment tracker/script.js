"use strict";

const $ = (selector) => document.querySelector(selector);
const authView = $("#authView");
const dashboardView = $("#dashboardView");
const notice = $("#notice");
let currentUser = null;
let assignments = [];
let assignmentView = "table";
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const notifiedAssignments = new Set();
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

function setMessage(text = "", type = "") {
    notice.textContent = text;
    notice.className = type ? `notice ${type}` : "notice";
}

async function api(url, options = {}) {
    let response;
    try {
        response = await fetch(url, {
            credentials: "same-origin",
            ...options
        });
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error("StudyFlow cannot reach its server. Start it from the project folder with `node server.js`, then retry.");
        }
        throw error;
    }
    const contentType = response.headers.get("content-type") || "";
    const result = contentType.includes("application/json") ? await response.json() : {};
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function formatDate(value) {
    if (!value) return "No date";
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime()) ? "No date" : date.toLocaleDateString();
}

function daysUntilDue(value) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(due.getTime())
        ? null
        : Math.round((due.getTime() - today.getTime()) / 86400000);
}

function dueSoonAssignments() {
    return assignments.filter((item) => {
        if (item.status === "Completed") return false;
        const days = daysUntilDue(item.dueDate);
        return days !== null && days <= 7;
    }).sort((left, right) => left.dueDate.localeCompare(right.dueDate));
}

function overdueAssignments() {
    return assignments.filter((item) => {
        const days = daysUntilDue(item.dueDate);
        return item.status !== "Completed" && days !== null && days < 0;
    }).sort((left, right) => left.dueDate.localeCompare(right.dueDate));
}

function renderOverdueAlert() {
    const alert = $("#overdueReminderBar");
    const title = $("#overdueReminderTitle");
    const message = $("#overdueReminderMessage");
    if (!alert || !title || !message || !currentUser || currentUser.role !== "student") {
        alert?.classList.add("hidden");
        document.body.classList.remove("has-overdue-reminder");
        return;
    }

    const overdue = overdueAssignments();
    if (!overdue.length) {
        alert.classList.add("hidden");
        document.body.classList.remove("has-overdue-reminder");
        return;
    }

    const count = overdue.length;
    const preview = overdue.slice(0, 2).map((item) => item.title).join(", ");
    const extra = count > 2 ? ` and ${count - 2} more` : "";
    const titleText = count === 1 ? "A quick deadline reminder" : `A quick reminder: ${count} overdue assignments`;
    const messageText = `${preview}${extra} ${count === 1 ? "is" : "are"} past due. Take a look when you can.`;
    if (title.textContent !== titleText) title.textContent = titleText;
    if (message.textContent !== messageText) message.textContent = messageText;
    alert.classList.remove("hidden");
    document.body.classList.add("has-overdue-reminder");
}

function reminderKey(item) {
    return `studyflow-reminder:${item.id}:${item.dueDate}:${reminderSchedule(item)}`;
}

function renderInAppReminder() {
    const toast = $("#reminderToast");
    const title = $("#reminderToastTitle");
    const message = $("#reminderToastMessage");
    if (!toast || !currentUser || currentUser.role !== "student") {
        toast?.classList.add("hidden");
        return;
    }

    const accountKey = `studyflow-in-app-reminder:${currentUser.id}:`;
    const dueReminders = dueSoonAssignments().filter((item) => {
        const days = daysUntilDue(item.dueDate);
        const daysBefore = reminderSchedule(item);
        return daysBefore >= 0 && days <= daysBefore &&
            !localStorage.getItem(`${accountKey}${reminderKey(item)}`);
    });
    if (!dueReminders.length) {
        toast.classList.add("hidden");
        return;
    }

    for (const item of dueReminders) {
        localStorage.setItem(`${accountKey}${reminderKey(item)}`, "shown");
    }

    const firstItem = dueReminders[0];
    const remaining = dueReminders.length - 1;
    const days = daysUntilDue(firstItem.dueDate);
    title.textContent = dueReminders.length === 1
        ? "Assignment reminder"
        : `${dueReminders.length} assignment reminders`;
    message.textContent = `${firstItem.title} · ${firstItem.subject} — ${formatDueLabel(days)}${
        remaining ? `, plus ${remaining} more` : ""
    }.`;
    toast.classList.remove("hidden");
}

function reminderSchedule(item) {
    const days = Number(item.reminderDays ?? 3);
    return [-1, 0, 1, 3, 7].includes(days) ? days : 3;
}

function formatDueLabel(days) {
    if (days < 0) return `Overdue by ${Math.abs(days)} day${days === -1 ? "" : "s"}`;
    if (days === 0) return "Due today";
    if (days === 1) return "Due tomorrow";
    return `Due in ${days} days`;
}

function renderWeeklyPlan() {
    const plan = $("#weeklyPlan");
    if (!plan) return;
    const upcoming = assignments
        .filter((item) => {
            const days = daysUntilDue(item.dueDate);
            return item.status !== "Completed" && days >= 0 && days <= 7;
        })
        .sort((left, right) => left.dueDate.localeCompare(right.dueDate));
    if (!upcoming.length) {
        plan.innerHTML = '<div class="empty-state">Your plan is clear. Add an assignment and due date to see it here.</div>';
        return;
    }

    const grouped = new Map();
    for (const item of upcoming) {
        const key = item.dueDate.slice(0, 10);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item);
    }
    plan.innerHTML = `<h3 class="weekly-plan-heading">Next seven days</h3>${[...grouped.entries()].map(([date, items]) => {
        const days = daysUntilDue(date);
        const dayLabel = days === 0 ? "Today" : days === 1 ? "Tomorrow" : formatDate(date);
        return `
            <section class="plan-day">
                <h3>${dayLabel}<span>${formatDate(date)}</span></h3>
                <div class="plan-items">${items.map((item) => `
                    <article class="plan-item">
                        <span class="plan-dot ${days <= 1 ? "plan-dot-soon" : ""}"></span>
                        <div>
                            <strong>${escapeHTML(item.title)}</strong>
                            <span class="muted">${escapeHTML(item.subject)}${currentUser?.role === "admin" && item.studentName
                                ? ` · ${escapeHTML(item.studentName)}` : ""}</span>
                        </div>
                        <span class="tag">${formatDueLabel(days)}</span>
                    </article>
                `).join("")}</div>
            </section>
        `;
    }).join("")}`;
}

function renderReminders() {
    const reminders = dueSoonAssignments();
    const list = $("#remindersList");
    const hint = $("#reminderHint");
    if (!list || !hint) return;
    if (!reminders.length) {
        list.innerHTML = currentUser?.role === "admin"
            ? '<div class="empty-state">No student assignments are overdue or due in the next 7 days.</div>'
            : '<div class="empty-state">You are all caught up. No overdue assignments or deadlines in the next 7 days.</div>';
        hint.textContent = currentUser?.role === "admin"
            ? "We will highlight student assignments due in the next 7 days."
            : "We will highlight overdue work and deadlines coming up in the next 7 days.";
        renderWeeklyPlan();
        return;
    }

    hint.textContent = currentUser?.role === "admin"
        ? `${reminders.length} student assignment${reminders.length === 1 ? "" : "s"} need attention.`
        : `${reminders.length} assignment${reminders.length === 1 ? "" : "s"} need your attention.`;
    list.innerHTML = reminders.map((item) => {
        const days = daysUntilDue(item.dueDate);
        const label = formatDueLabel(days);
        const tone = days < 0 ? "reminder-overdue" : "reminder-upcoming";
        return `
            <article class="reminder-item ${tone}">
                <div>
                    <strong>${escapeHTML(item.title)}</strong>
                    <span class="muted">${escapeHTML(item.subject)}${currentUser?.role === "admin" && item.studentName
                            ? ` · ${escapeHTML(item.studentName)}` : ""} · ${formatDate(item.dueDate)}
                            ${reminderSchedule(item) >= 0
                                ? ` · Alert ${reminderSchedule(item) === 0 ? "on the due date" : `${reminderSchedule(item)} day${reminderSchedule(item) === 1 ? "" : "s"} before`}`
                                : " · Alerts off"}</span>
                    </div>
                    <span class="tag">${label}</span>
                </article>
            `;
    }).join("");
    renderWeeklyPlan();
}

function updateReminderButton() {
    const button = $("#enableReminders");
    const status = $("#notificationStatus");
    if (!button) return;
    if (!("Notification" in window)) {
        button.disabled = true;
        button.textContent = "Browser reminders unavailable";
        if (status) status.textContent = "This browser does not support desktop notifications. In-app reminders remain active.";
        return;
    }
    if (Notification.permission === "granted") {
        button.textContent = "Browser reminders enabled";
        button.disabled = true;
        if (status) status.textContent = "Desktop and in-app reminders are enabled.";
    } else if (Notification.permission === "denied") {
        button.textContent = "Browser alerts blocked";
        button.disabled = true;
        if (status) status.textContent =
            "Blocked by browser permission. Open this site's settings from the address bar, set Notifications to Allow, then reload. In-app reminders remain active.";
    } else {
        button.textContent = "Enable notifications";
        button.disabled = false;
        if (status) status.textContent = "In-app reminders work without browser permission.";
    }
}

function notifyDueSoon() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    for (const item of dueSoonAssignments()) {
        const days = daysUntilDue(item.dueDate);
        const reminderDays = reminderSchedule(item);
        if (reminderDays < 0 || days > reminderDays) continue;
        const key = reminderKey(item);
        if (notifiedAssignments.has(key) || localStorage.getItem(key)) continue;
        const dueText = days < 0
            ? `This assignment is overdue by ${Math.abs(days)} day${days === -1 ? "" : "s"}.`
            : days === 0
                ? "This assignment is due today."
                : `This assignment is due in ${days} day${days === 1 ? "" : "s"}.`;
        const isTeacher = currentUser?.role === "admin";
        const notification = new Notification(
            `${isTeacher ? "Teacher reminder" : "StudyFlow reminder"}: ${item.title}`,
            {
                body: `${item.subject}${isTeacher && item.studentName ? ` · ${item.studentName}` : ""} · ${dueText}`,
                tag: `studyflow-${item.id}`
            }
        );
        notification.onclick = () => window.focus();
        notifiedAssignments.add(key);
        localStorage.setItem(key, "sent");
    }
}

function showAuth(mode = "login", message = "", type = "") {
    currentUser = null;
    $("#overdueReminderBar")?.classList.add("hidden");
    document.body.classList.remove("has-overdue-reminder");
    $("#reminderToast")?.classList.add("hidden");
    authView.classList.remove("hidden");
    dashboardView.classList.add("hidden");
    $("#logoutBtn").classList.add("hidden");
    $("#loginForm").classList.toggle("hidden", mode !== "login" && mode !== "admin");
    $("#registerForm").classList.toggle("hidden", mode !== "register");
    $("#loginTab").classList.toggle("active", mode === "login");
    $("#adminLoginTab")?.classList.toggle("active", mode === "admin");
    $("#registerTab").classList.toggle("active", mode === "register");
    const loginHint = $("#loginHint");
    if (loginHint) {
        loginHint.textContent = mode === "admin"
            ? "Sign in to see upcoming assignment reminders for teachers."
            : "Sign in to access your student workspace.";
    }
    $("#accountLabel").textContent = "Your academic workspace";
    setMessage(message, type);
}

function showDashboard(user) {
    currentUser = user;
    authView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    $("#logoutBtn").classList.remove("hidden");
    $("#accountLabel").textContent = `${user.full_name} · ${user.role === "admin" ? "Teacher" : "Student"}`;
    const isAdmin = user.role === "admin";
    const rawFirstName = user.full_name.trim().split(/\s+/)[0];
    const firstName = `${rawFirstName.charAt(0).toLocaleUpperCase()}${rawFirstName.slice(1)}`;
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    $("#roleLabel").textContent = isAdmin ? "TEACHER SPACE" : "YOUR STUDY SPACE";
    $("#welcomeTitle").textContent = isAdmin ? "Welcome back" : `${greeting}, ${firstName}`;
    $("#welcomeText").textContent = isAdmin
        ? "Here’s what’s coming up for your students."
        : "Here’s what’s on your plate. You can take it one step at a time.";
    $("#studentView").classList.toggle("hidden", isAdmin);
    $("#adminView").classList.toggle("hidden", !isAdmin);
}

function renderStats(items) {
    const values = currentUser.role === "admin"
        ? [
            ["Student assignments", items.assignmentCount],
            ["Due in 7 days", items.dueSoonCount],
            ["Overdue", items.overdueCount]
        ]
        : [
            ["Assignments", items.assignmentCount],
            ["Completed", items.completedCount],
            ["Due soon", items.dueSoonCount]
        ];
    $("#stats").innerHTML = values.map(([label, value]) => `
        <article class="stat-card">
            <span class="muted">${escapeHTML(label)}</span>
            <strong>${Number(value) || 0}</strong>
        </article>
    `).join("");
}

function renderStudentAssignments() {
    const container = $("#studentAssignments");
    const summary = $("#viewSummary");
    const calendarControls = $("#calendarControls");
    if (!container) return;
    if (!assignments.length) {
        container.innerHTML = '<div class="empty-state">No assignments yet. Add one to get started.</div>';
        if (summary) summary.textContent = "0 assignments";
        calendarControls?.classList.toggle("hidden", assignmentView !== "calendar");
        return;
    }

    const sortedAssignments = [...assignments].sort((left, right) =>
        left.dueDate.localeCompare(right.dueDate)
    );
    if (summary) summary.textContent = `${assignments.length} assignment${assignments.length === 1 ? "" : "s"}`;
    calendarControls?.classList.toggle("hidden", assignmentView !== "calendar");
    container.dataset.view = assignmentView;

    if (assignmentView === "calendar") {
        renderAssignmentCalendar(container, sortedAssignments);
        return;
    }
    if (assignmentView === "board") {
        renderAssignmentBoard(container, sortedAssignments);
        return;
    }
    if (assignmentView === "chart") {
        renderAssignmentChart(container, sortedAssignments);
        return;
    }
    renderAssignmentTable(container, sortedAssignments);
}

function renderAssignmentTable(container, items) {
    container.innerHTML = `
        <div class="assignment-table-wrap">
            <table class="assignment-table">
                <thead><tr>
                    <th>Homework name</th><th>Status</th><th>Due date</th>
                    <th>Notes / instructions</th><th>Class</th><th>Priority</th><th></th>
                </tr></thead>
                <tbody>${items.map((item) => `
                    <tr>
                        <td class="assignment-name">${escapeHTML(item.title)}</td>
                        <td>
                            <span class="status-chip status-${item.status === "Completed" ? "completed" : item.status === "In Progress" ? "progress" : "pending"}">
                                ${escapeHTML(item.status)}
                            </span>
                            <select class="table-status" aria-label="Progress for ${escapeHTML(item.title)}"
                                data-action="status" data-id="${escapeHTML(item.id)}">
                                ${["Pending", "In Progress", "Completed"].map((status) =>
                                    `<option${item.status === status ? " selected" : ""}>${status}</option>`
                                ).join("")}
                            </select>
                        </td>
                        <td>${escapeHTML(formatDate(item.dueDate))}<small>${escapeHTML(formatDueLabel(daysUntilDue(item.dueDate)))}</small></td>
                        <td class="assignment-notes">${escapeHTML(item.description || "—")}</td>
                        <td><span class="subject-chip">${escapeHTML(item.subject)}</span></td>
                        <td>${escapeHTML(item.priority)}</td>
                        <td><button class="icon-button" type="button" aria-label="Delete ${escapeHTML(item.title)}"
                            data-action="delete" data-id="${escapeHTML(item.id)}">×</button></td>
                    </tr>
                `).join("")}</tbody>
            </table>
        </div>
    `;
}

function renderAssignmentCalendar(container, items) {
    const monthLabel = $("#calendarMonthLabel");
    const label = calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (monthLabel) monthLabel.textContent = label;

    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    const lastOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0);
    const gridEnd = new Date(lastOfMonth);
    gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
    const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const cells = [];

    for (let day = new Date(gridStart); day <= gridEnd; day.setDate(day.getDate() + 1)) {
        const dateKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
        const dayItems = items.filter((item) => item.dueDate.slice(0, 10) === dateKey);
        const isCurrentMonth = day.getMonth() === calendarMonth.getMonth();
        const today = new Date();
        const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const isToday = dateKey === todayKey;
        cells.push(`
            <div class="calendar-day${isCurrentMonth ? "" : " outside-month"}${isToday ? " is-today" : ""}">
                <span class="calendar-date">${day.getDate()}</span>
                <div class="calendar-events">${dayItems.map((item) => `
                    <article class="calendar-event status-${item.status === "Completed" ? "completed" : item.status === "In Progress" ? "progress" : "pending"}">
                        <strong>${escapeHTML(item.title)}</strong>
                        <small>${escapeHTML(item.subject)}</small>
                    </article>
                `).join("")}</div>
            </div>
        `);
    }

    container.innerHTML = `
        <div class="calendar-grid">
            ${weekDays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}
            ${cells.join("")}
        </div>
    `;
}

function renderAssignmentBoard(container, items) {
    const columns = [
        ["Pending", "pending"],
        ["In Progress", "progress"],
        ["Completed", "completed"]
    ];
    container.innerHTML = `
        <div class="assignment-board">
            ${columns.map(([status, tone]) => {
                const columnItems = items.filter((item) => item.status === status);
                return `
                    <section class="board-column board-${tone}">
                        <header><span class="status-chip status-${tone}">${status}</span><span>${columnItems.length}</span></header>
                        <div class="board-cards">${columnItems.length ? columnItems.map((item) => `
                            <article class="board-card">
                                <span class="subject-chip">${escapeHTML(item.subject)}</span>
                                <strong>${escapeHTML(item.title)}</strong>
                                <small>Due ${escapeHTML(formatDate(item.dueDate))}</small>
                                ${item.description ? `<p>${escapeHTML(item.description)}</p>` : ""}
                                <select aria-label="Progress for ${escapeHTML(item.title)}" data-action="status" data-id="${escapeHTML(item.id)}">
                                    ${columns.map(([option]) => `<option${status === option ? " selected" : ""}>${option}</option>`).join("")}
                                </select>
                            </article>
                        `).join("") : '<p class="board-empty">No assignments</p>'}</div>
                    </section>
                `;
            }).join("")}
        </div>
    `;
}

function renderAssignmentChart(container, items) {
    const palette = ["#842d43", "#c58c42", "#bf7165", "#577d91", "#a47780", "#7772a5", "#d0ae62"];
    const subjectCounts = new Map();
    for (const item of items) {
        subjectCounts.set(item.subject, (subjectCounts.get(item.subject) || 0) + 1);
    }
    const subjects = [...subjectCounts.entries()].sort((left, right) => right[1] - left[1]);
    let position = 0;
    const slices = subjects.map(([, count], index) => {
        const start = position;
        position += (count / items.length) * 100;
        return `${palette[index % palette.length]} ${start}% ${position}%`;
    });

    container.innerHTML = `
        <div class="chart-view">
            <div class="subject-donut" style="--donut-slices: ${slices.join(", ")}">
                <div><strong>${items.length}</strong><span>Assignments</span></div>
            </div>
            <div class="chart-legend">
                <h3>Assignments by class</h3>
                ${subjects.map(([subject, count], index) => `
                    <div class="legend-row">
                        <span class="legend-swatch" style="--swatch:${palette[index % palette.length]}"></span>
                        <span>${escapeHTML(subject)}</span>
                        <strong>${count}</strong>
                    </div>
                `).join("")}
            </div>
        </div>
    `;
}

function renderAdminDashboard(data) {
    assignments = data.assignments || [];
    renderOverdueAlert();
    renderInAppReminder();
    renderReminders();
    notifyDueSoon();

    const reminders = dueSoonAssignments();
    renderStats({
        assignmentCount: assignments.length,
        dueSoonCount: reminders.filter((item) => daysUntilDue(item.dueDate) >= 0).length,
        overdueCount: reminders.filter((item) => daysUntilDue(item.dueDate) < 0).length
    });
}

async function loadDashboard() {
    if (!currentUser) return;
    try {
        if (currentUser.role === "admin") {
            const data = await api("/api/admin/dashboard");
            renderAdminDashboard(data);
        } else {
            const data = await api("/api/assignments");
            assignments = data.assignments;
            renderStudentAssignments();
            renderOverdueAlert();
            renderInAppReminder();
            renderStats({
                assignmentCount: assignments.length,
                completedCount: assignments.filter((item) => item.status === "Completed").length,
                dueSoonCount: dueSoonAssignments().filter((item) => daysUntilDue(item.dueDate) >= 0).length
            });
            renderReminders();
            notifyDueSoon();
        }
    } catch (error) {
        setMessage(error.message, "error");
    }
}

async function initialize() {
    try {
        const { user } = await api("/api/me");
        showDashboard(user);
        await loadDashboard();
    } catch (error) {
        if (error.message !== "Please sign in.") setMessage(error.message, "error");
    }
}

$("#loginTab").addEventListener("click", () => showAuth("login"));
$("#adminLoginTab")?.addEventListener("click", () => showAuth("admin"));
$("#registerTab").addEventListener("click", () => showAuth("register"));

$("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const { user } = await api("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: $("#loginEmail").value.trim(),
                password: $("#loginPassword").value
            })
        });
        form.reset();
        setMessage();
        showDashboard(user);
        await loadDashboard();
    } catch (error) {
        setMessage(error.message, "error");
    } finally {
        button.disabled = false;
    }
});

$("#registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const body = {
            full_name: $("#registerName").value.trim(),
            email: $("#registerEmail").value.trim(),
            password: $("#registerPassword").value
        };
        const { user } = await api("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        form.reset();
        showDashboard(user);
        setMessage("Account created. Welcome to StudyFlow.", "success");
        await loadDashboard();
    } catch (error) {
        setMessage(error.message, "error");
    } finally {
        button.disabled = false;
    }
});

$("#logoutBtn").addEventListener("click", async () => {
    try {
        await api("/api/logout", { method: "POST" });
        showAuth("login", "You have signed out.", "success");
    } catch (error) {
        setMessage(error.message, "error");
    }
});

$("#refreshBtn")?.addEventListener("click", loadDashboard);
$("#refreshStudent")?.addEventListener("click", loadDashboard);
document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        assignmentView = tab.dataset.view;
        document.querySelectorAll(".view-tab").forEach((viewTab) => {
            const active = viewTab === tab;
            viewTab.classList.toggle("active", active);
            viewTab.setAttribute("aria-selected", String(active));
        });
        renderStudentAssignments();
    });
});
$("#calendarPrevious")?.addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    renderStudentAssignments();
});
$("#calendarNext")?.addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    renderStudentAssignments();
});
$("#calendarToday")?.addEventListener("click", () => {
    calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderStudentAssignments();
});
$("#dismissReminderToast")?.addEventListener("click", () => {
    $("#reminderToast")?.classList.add("hidden");
});
$("#enableReminders")?.addEventListener("click", async () => {
    if (!("Notification" in window)) {
        setMessage("This browser does not support desktop notifications. In-app due-date reminders are still available.", "error");
        return;
    }
    try {
        const permission = await Notification.requestPermission();
        updateReminderButton();
        if (permission === "granted") {
            setMessage("Browser reminders enabled.", "success");
            notifyDueSoon();
        } else if (permission === "denied") {
            setMessage("Notifications were blocked. You can still see reminders in your StudyFlow dashboard.", "error");
        }
    } catch (error) {
        setMessage(`Could not enable browser reminders: ${error.message}`, "error");
    }
});

async function submitAssignmentForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const values = Object.fromEntries(new FormData(form));
        values.reminderDays = Number(values.reminderDays);
        await api("/api/assignments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(values)
        });
        form.reset();
        const details = form.closest("details");
        if (details) details.open = false;
        setMessage("Assignment added.", "success");
        await loadDashboard();
    } catch (error) {
        setMessage(error.message, "error");
    } finally {
        button.disabled = false;
    }
}

$("#createAssignmentForm")?.addEventListener("submit", submitAssignmentForm);
$("#createStudentAssignmentForm")?.addEventListener("submit", submitAssignmentForm);

$("#studentAssignments").addEventListener("change", async (event) => {
    const control = event.target.closest('[data-action="status"]');
    const reminderControl = event.target.closest('[data-action="reminder"]');
    const changedControl = control || reminderControl;
    if (!changedControl) return;
    const body = control
        ? { status: control.value }
        : { reminderDays: Number(reminderControl.value) };
    try {
        await api(`/api/assignments/${encodeURIComponent(changedControl.dataset.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        setMessage("Progress updated.", "success");
        await loadDashboard();
    } catch (error) {
        setMessage(error.message, "error");
        await loadDashboard();
    }
});

$("#studentAssignments").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === "delete" && !window.confirm("Delete this assignment?")) return;
    button.disabled = true;
    try {
        if (action === "delete") {
            await api(`/api/assignments/${encodeURIComponent(id)}`, { method: "DELETE" });
            setMessage("Assignment deleted.", "success");
        }
        await loadDashboard();
    } catch (error) {
        setMessage(error.message, "error");
        button.disabled = false;
    }
});

initialize();
updateReminderButton();
window.setInterval(() => {
    if (currentUser) loadDashboard();
}, REMINDER_CHECK_INTERVAL_MS);
