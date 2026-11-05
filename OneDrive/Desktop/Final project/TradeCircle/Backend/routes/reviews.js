const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");

router.get("/:productId", async (req, res, next) => {
    const productId = Number(req.params.productId);
    if (!Number.isSafeInteger(productId) || productId < 1) {
        return res.status(400).json({ error: "Provide a valid product." });
    }

    try {
        const product = await req.app.locals.pool.query(
            `SELECT id FROM products WHERE id = $1 AND status = 'approved'`,
            [productId]
        );
        if (!product.rowCount) {
            return res.status(404).json({ error: "Approved product not found." });
        }

        const result = await req.app.locals.pool.query(
            `SELECT r.id, r.rating, r.review_text, r.created_at, u.name AS reviewer_name
             FROM product_reviews r
             JOIN users u ON u.id = r.buyer_id
             WHERE r.product_id = $1
             ORDER BY r.created_at DESC
             LIMIT 100`,
            [productId]
        );
        const summary = await req.app.locals.pool.query(
            `SELECT COUNT(*)::int AS review_count,
                    COALESCE(AVG(rating), 0)::numeric(3, 2) AS average_rating
             FROM product_reviews
             WHERE product_id = $1`,
            [productId]
        );
        res.json({ reviews: result.rows, summary: summary.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.post("/:productId", requireAuth, requireRole("buyer"), async (req, res, next) => {
    const productId = Number(req.params.productId);
    const rating = Number(req.body.rating);
    const reviewText = req.body.review_text === undefined ? "" : req.body.review_text;

    if (
        !Number.isSafeInteger(productId) || productId < 1 ||
        !Number.isInteger(rating) || rating < 1 || rating > 5 ||
        typeof reviewText !== "string" || reviewText.trim().length > 1000
    ) {
        return res.status(400).json({
            error: "Choose a rating from 1 to 5 and keep the review under 1,000 characters."
        });
    }

    try {
        const eligible = await req.app.locals.pool.query(
            `SELECT p.id
             FROM products p
             WHERE p.id = $1 AND p.status = 'approved'
               AND EXISTS (
                   SELECT 1
                   FROM order_items oi
                   JOIN orders o ON o.id = oi.order_id
                   WHERE oi.product_id = p.id
                     AND o.buyer_id = $2
                     AND o.payment_status = 'paid'
                     AND oi.fulfillment_status = 'delivered'
               )`,
            [productId, req.session.user.id]
        );
        if (!eligible.rowCount) {
            return res.status(403).json({
                error: "Reviews are available after you have paid for and received this product."
            });
        }

        const result = await req.app.locals.pool.query(
            `INSERT INTO product_reviews (product_id, buyer_id, rating, review_text)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (product_id, buyer_id) DO NOTHING
             RETURNING id, product_id, rating, review_text, created_at`,
            [productId, req.session.user.id, rating, reviewText.trim()]
        );
        if (!result.rowCount) {
            return res.status(409).json({
                error: "You have already reviewed this product."
            });
        }
        res.status(201).json({ review: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
