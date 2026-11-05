const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("buyer"));

router.get("/", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT p.id, p.name, p.description, p.category, p.image_url,
                    p.wholesale_price, p.unit_label, p.minimum_quantity,
                    p.stock_quantity, p.supplier_id, u.name AS supplier_name,
                    u.supplier_verified
             FROM wishlists w
             JOIN products p ON p.id = w.product_id
             JOIN users u ON u.id = p.supplier_id
             WHERE w.user_id = $1 AND p.status = 'approved'
             ORDER BY w.created_at DESC
             LIMIT 100`,
            [req.session.user.id]
        );
        res.json({ products: result.rows });
    } catch (error) {
        next(error);
    }
});

router.post("/", async (req, res, next) => {
    const productId = Number(req.body.product_id);
    if (!Number.isSafeInteger(productId) || productId < 1) {
        return res.status(400).json({ error: "Provide a valid product." });
    }

    try {
        const product = await req.app.locals.pool.query(
            "SELECT id FROM products WHERE id = $1 AND status = 'approved'",
            [productId]
        );
        if (!product.rowCount) {
            return res.status(404).json({ error: "Approved product not found." });
        }

        await req.app.locals.pool.query(
            `INSERT INTO wishlists (user_id, product_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, product_id) DO NOTHING`,
            [req.session.user.id, productId]
        );
        res.status(201).json({ product_id: productId, saved: true });
    } catch (error) {
        next(error);
    }
});

router.delete("/:productId", async (req, res, next) => {
    const productId = Number(req.params.productId);
    if (!Number.isSafeInteger(productId) || productId < 1) {
        return res.status(400).json({ error: "Provide a valid product." });
    }

    try {
        await req.app.locals.pool.query(
            "DELETE FROM wishlists WHERE user_id = $1 AND product_id = $2",
            [req.session.user.id, productId]
        );
        res.json({ product_id: productId, saved: false });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
