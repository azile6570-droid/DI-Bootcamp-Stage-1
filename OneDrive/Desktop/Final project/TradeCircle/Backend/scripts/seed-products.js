require("dotenv").config();

const { Pool } = require("pg");

const starterProducts = [
    [
        "Maize Flour 2 kg Bag", "Groceries", "bag", 135, 20, 500,
        "Bulk orders of 2 kg maize flour bags for Kenyan shops and food businesses.",
        "https://images.unsplash.com/photo-1627485937980-221c88ac04f9?auto=format&fit=crop&w=800&q=80",
        "Demo Maize Flour 2 kg"
    ],
    [
        "Long-Grain Rice 5 kg Bag", "Groceries", "bag", 720, 10, 250,
        "Long-grain rice in wholesale 5 kg bags, sold in bulk quantities.",
        "https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=800&q=80",
        "Demo Long-Grain Rice 5 kg"
    ],
    [
        "Cooking Oil 5 L Jerrycan", "Groceries", "jerrycan", 1050, 4, 180,
        "5 L cooking oil jerrycans for bulk wholesale orders.",
        "https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=800&q=80",
        "Demo Cooking Oil 5 L"
    ],
    [
        "LED Bulb 12 W Carton (20)", "Electronics", "carton", 3600, 2, 15,
        "Wholesale carton of 20 energy-saving 12-watt LED bulbs.",
        "https://images.unsplash.com/photo-1565814329452-e1efa11c5b89?auto=format&fit=crop&w=800&q=80",
        "Demo LED Bulb 12 W"
    ],
    [
        "Reusable Shopping Bags Bale (50)", "Packaging", "bale", 650, 5, 120,
        "Wholesale bale of 50 reusable shopping bags for retailers.",
        "https://upload.wikimedia.org/wikipedia/commons/c/c5/Blue_reusable_shopping_bag.JPG",
        "Demo Reusable Shopping Bags (50)"
    ],
    [
        "Cleaning Detergent 5 L Jerrycan", "Home & Cleaning", "jerrycan", 890, 4, 100,
        "Wholesale 5 L cleaning detergent jerrycans for homes and businesses.",
        "https://images.unsplash.com/photo-1583947215259-38e31be8751f?auto=format&fit=crop&w=800&q=80",
        "Demo Cleaning Detergent 5 L"
    ],
    [
        "Dry Red Beans 25 kg Sack", "Groceries", "sack", 4200, 2, 60,
        "Dry red beans in 25 kg wholesale sacks for shops and food businesses.",
        "https://images.pexels.com/photos/4110253/pexels-photo-4110253.jpeg?auto=compress&cs=tinysrgb&w=800",
        "Demo Dry Red Beans 25 kg"
    ],
    [
        "Black Tea Bags Carton (24)", "Groceries", "carton", 2880, 2, 40,
        "Wholesale carton of 24 black tea packs for neighborhood shops and offices.",
        "https://images.pexels.com/photos/3735149/pexels-photo-3735149.jpeg?auto=compress&cs=tinysrgb&w=800",
        "Demo Black Tea Bags Carton"
    ],
    [
        "Fresh Tomatoes 10 kg Crate", "Groceries", "crate", 950, 3, 35,
        "Fresh tomatoes packed in 10 kg crates  for retailers and food businesses.",
        "https://images.pexels.com/photos/2255935/pexels-photo-2255935.jpeg?auto=compress&cs=tinysrgb&w=800",
        "Demo Fresh Tomatoes 10 kg"
    ],
    [
        "Mixed Fresh Produce Crate", "Groceries", "crate", 1800, 2, 30,
        "A wholesale crate of assorted fresh market vegetables for food businesses.",
        "https://images.pexels.com/photos/264636/pexels-photo-264636.jpeg?auto=compress&cs=tinysrgb&w=800",
        "Demo Mixed Fresh Produce Crate"
    ],
    [
        "Laundry Soap Bars Carton (24)", "Home & Cleaning", "carton", 1920, 2, 45,
        "Wholesale carton of 24 laundry soap bars for home and shop use.",
        "https://cdn.thewirecutter.com/wp-content/media/2025/10/BEST-BAR-SOAPS-SUB-9272-2x1-1.jpg?width=1024&quality=75&crop=2:1&auto=web", 
        "Demo Laundry Soap Bars Carton"
    ],
    [
        "Reusable Shopping Bags Bale (100)", "Packaging", "bale", 1100, 3, 80,
        "Wholesale bale of 100 reusable carry bags for retailers and market vendors.",
        "https://images.pexels.com/photos/3735218/pexels-photo-3735218.jpeg?auto=compress&cs=tinysrgb&w=800",
        "Demo Reusable Shopping Bags (100)"
    ]
];

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL must be configured.");
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : false
    });

    try {
        const suppliers = await pool.query(
            "SELECT id FROM users WHERE role = 'supplier' ORDER BY id"
        );
        if (suppliers.rowCount !== 1) {
            throw new Error(
                "Create exactly one supplier account before seeding demo products."
            );
        }

        let updated = 0;
        let inserted = 0;
        let photosAdded = 0;
        for (const [
            name, category, unitLabel, price, minimum, stock, description, imageUrl, legacyName
        ] of starterProducts) {
            const migrated = await pool.query(
                `UPDATE products
                 SET name = $3, description = $4, unit_label = $5,
                     wholesale_price = $6, minimum_quantity = $7,
                     stock_quantity = $8, image_url = COALESCE(image_url, $9)
                 WHERE supplier_id = $1 AND name = $2`,
                [
                    suppliers.rows[0].id, legacyName, name, description, unitLabel,
                    price, minimum, stock, imageUrl
                ]
            );
            updated += migrated.rowCount;

            const result = await pool.query(
                `INSERT INTO products
                    (supplier_id, name, description, category, wholesale_price,
                     unit_label, minimum_quantity, stock_quantity, status, image_url)
                 SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'approved', $9
                 WHERE NOT EXISTS (
                     SELECT 1 FROM products
                     WHERE supplier_id = $1::bigint AND name = $2::varchar
                 )`,
                [
                    suppliers.rows[0].id, name, description, category, price,
                    unitLabel, minimum, stock, imageUrl
                ]
            );
            inserted += result.rowCount;

            const photoResult = await pool.query(
                `UPDATE products
                 SET image_url = $3
                 WHERE supplier_id = $1 AND name = $2`,
                [suppliers.rows[0].id, name, imageUrl]
            );
            photosAdded += photoResult.rowCount;
        }

        const demoDeal = await pool.query(
            `INSERT INTO group_deals
                (product_id, target_quantity, current_quantity, discounted_price, ends_at)
             SELECT p.id, 80, 0, 680, NOW() + INTERVAL '7 days'
             FROM products p
             WHERE p.supplier_id = $1 AND p.name = $2 AND p.status = 'approved'
               AND NOT EXISTS (
                   SELECT 1 FROM group_deals d WHERE d.product_id = p.id
               )
             RETURNING id`,
            [suppliers.rows[0].id, "Long-Grain Rice 5 kg Bag"]
        );

        console.log(
            `Updated ${updated} legacy listings, added ${inserted} listings, and added photos to ${photosAdded} listings.`
        );
        if (demoDeal.rowCount) {
            console.log("Added a sample rice group deal ending in 7 days.");
        }
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
