const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");

router.get("/", async (req, res, next) => {
    try {
        const { search = "", category = "" } = req.query;

        const result = await req.app.locals.pool.query(
            `SELECT p.id, p.name, p.description, p.category, p.image_url,
                    p.wholesale_price, p.unit_label, p.minimum_quantity,
                    p.stock_quantity,
                    p.supplier_id, u.name AS supplier_name,
                    u.supplier_verified,
                    COALESCE(review_summary.review_count, 0)::int AS review_count,
                    COALESCE(review_summary.average_rating, 0)::numeric(3, 2) AS average_rating
             FROM products p
             JOIN users u ON u.id = p.supplier_id
             LEFT JOIN (
                 SELECT product_id, COUNT(*)::int AS review_count, AVG(rating) AS average_rating
                 FROM product_reviews
                 GROUP BY product_id
             ) review_summary ON review_summary.product_id = p.id
             WHERE p.status = 'approved'
               AND ($1 = '' OR p.name ILIKE '%' || $1 || '%'
                    OR p.description ILIKE '%' || $1 || '%')
               AND ($2 = '' OR p.category = $2)
             ORDER BY p.created_at DESC
             LIMIT 100`,
            [
                typeof search === "string" ? search.slice(0, 100) : "",
                typeof category === "string" ? category.slice(0, 100) : ""
            ]
        );

        res.json({ products: result.rows });
    } catch (error) {
        next(error);
    }
});

router.post("/", requireAuth, requireRole("supplier"), async (req, res, next) => {
    try {
        const supplierResult = await req.app.locals.pool.query(
            "SELECT supplier_verified FROM users WHERE id = $1",
            [req.session.user.id]
        );
        if (supplierResult.rows[0]?.supplier_verified !== true) {
            return res.status(403).json({
                error: "An admin must verify your supplier account before you can submit product listings."
            });
        }

        const {
            name, description, category, image_url, unit_label,
            wholesale_price, minimum_quantity, stock_quantity
        } = req.body;

        const price = Number(wholesale_price);
        const minQty = Number(minimum_quantity);
        const stock = Number(stock_quantity);
        const unit = typeof unit_label === "string" ? unit_label.trim() : "";

        if (
            typeof name !== "string" || name.trim().length < 2 ||
            typeof category !== "string" || !category.trim() ||
            !unit || unit.length > 40 ||
            !Number.isFinite(price) || price < 0 ||
            !Number.isInteger(minQty) || minQty < 1 ||
            !Number.isInteger(stock) || stock < 0
        ) {
            return res.status(400).json({ error: "Check the product details and quantities." });
        }

        if (image_url && (
            typeof image_url !== "string" ||
            !/^https?:\/\//i.test(image_url)
        )) {
            return res.status(400).json({ error: "Image URL must start with http:// or https://." });
        }

        const result = await req.app.locals.pool.query(
            `INSERT INTO products
                (supplier_id, name, description, category, image_url, unit_label,
                 wholesale_price, minimum_quantity, stock_quantity)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                req.session.user.id,
                name.trim().slice(0, 180),
                typeof description === "string" ? description.slice(0, 5000) : "",
                category.trim().slice(0, 100),
                image_url || null,
                unit,
                price,
                minQty,
                stock
            ]
        );

        res.status(201).json({
            message: "Product submitted for admin approval.",
            product: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

router.get("/mine", requireAuth, requireRole("supplier"), async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT * FROM products
             WHERE supplier_id = $1
             ORDER BY created_at DESC`,
            [req.session.user.id]
        );
        const supplierResult = await req.app.locals.pool.query(
            "SELECT supplier_verified FROM users WHERE id = $1",
            [req.session.user.id]
        );
        res.json({
            products: result.rows,
            supplier_verified: supplierResult.rows[0]?.supplier_verified === true
        });
    } catch (error) {
        next(error);
    }
});

router.patch("/:productId/stock", requireAuth, requireRole("supplier"), async (req, res, next) => {
    const productId = Number(req.params.productId);
    const stock = Number(req.body.stock_quantity);
    if (
        !Number.isSafeInteger(productId) || productId < 1 ||
        !Number.isSafeInteger(stock) || stock < 0
    ) {
        return res.status(400).json({ error: "Provide a valid product and stock quantity." });
    }

    try {
        const result = await req.app.locals.pool.query(
            `UPDATE products
             SET stock_quantity = $1
             WHERE id = $2 AND supplier_id = $3
             RETURNING id, stock_quantity, status`,
            [stock, productId, req.session.user.id]
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: "Product not found." });
        }
        res.json({ product: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.patch("/:productId", requireAuth, requireRole("supplier"), async (req, res, next) => {
    const productId = Number(req.params.productId);
    const {
        name, description, category, image_url, unit_label,
        wholesale_price, minimum_quantity
    } = req.body;
    const price = Number(wholesale_price);
    const minQty = Number(minimum_quantity);
    const unit = typeof unit_label === "string" ? unit_label.trim() : "";

    if (
        !Number.isSafeInteger(productId) || productId < 1 ||
        typeof name !== "string" || name.trim().length < 2 ||
        typeof category !== "string" || !category.trim() ||
        !unit || unit.length > 40 ||
        !Number.isFinite(price) || price < 0 ||
        !Number.isInteger(minQty) || minQty < 1 ||
        (description !== undefined && typeof description !== "string") ||
        (image_url && (typeof image_url !== "string" || !/^https?:\/\//i.test(image_url)))
    ) {
        return res.status(400).json({ error: "Check the product details and minimum quantity." });
    }

    try {
        const result = await req.app.locals.pool.query(
            `UPDATE products
             SET name = $1, description = $2, category = $3, image_url = $4,
                 unit_label = $5, wholesale_price = $6, minimum_quantity = $7,
                 status = 'pending'
             WHERE id = $8 AND supplier_id = $9
             RETURNING *`,
            [
                name.trim().slice(0, 180),
                typeof description === "string" ? description.slice(0, 5000) : "",
                category.trim().slice(0, 100),
                image_url || null,
                unit,
                price,
                minQty,
                productId,
                req.session.user.id
            ]
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: "Product not found." });
        }
        res.json({
            message: "Listing updated and sent for admin approval.",
            product: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
