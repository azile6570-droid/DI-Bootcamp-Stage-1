"use strict";

const { createDatabase, createSuperAdmin } = require("./server");

const db = createDatabase();
try {
    const admin = createSuperAdmin(db);
    console.log(`Super Admin created for ${admin.email}.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    db.close();
}
