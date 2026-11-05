require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL must be configured before running this migration.");
    }

    const migrationPath = path.join(
        __dirname,
        "..",
        "database",
        "migrations",
        "001_sales_workspace.sql"
    );
    const migration = fs.readFileSync(migrationPath, "utf8");
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : false
    });

    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query(migration);
        await client.query("COMMIT");
        console.log("Sales workspace database migration applied.");
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        throw error;
    } finally {
        if (client) client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error("Sales workspace migration failed:", error.message);
    process.exitCode = 1;
});
