require("dotenv").config();

const { Pool } = require("pg");

async function main() {
    const email = process.argv[2];
    if (!process.env.DATABASE_URL || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error("Usage: npm run make-admin -- account@example.com");
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : false
    });

    try {
        const result = await pool.query(
            "UPDATE users SET role = 'admin' WHERE email = $1 RETURNING id",
            [email.trim().toLowerCase()]
        );
        if (!result.rowCount) {
            throw new Error("No matching account found. Register that account first.");
        }
        console.log("Account promoted to admin. Sign out and sign back in to refresh its permissions.");
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
