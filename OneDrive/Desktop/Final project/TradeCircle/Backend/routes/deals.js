const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");

router.get("/requests/mine", requireAuth, requireRole("supplier"), async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT r.id, r.product_id, r.target_quantity, r.discounted_price,
                    r.ends_at, r.supplier_note, r.status, r.created_at,
                    p.name AS product_name, p.unit_label
             FROM group_deal_requests r
             JOIN products p ON p.id = r.product_id
             WHERE r.supplier_id = $1
             ORDER BY r.created_at DESC
             LIMIT 100`,
            [req.session.user.id]
        );
        res.json({ requests: result.rows });
    } catch (error) {
        next(error);
    }
});

router.post("/requests", requireAuth, requireRole("supplier"), async (req, res, next) => {
    const productId = Number(req.body.product_id);
    const targetQuantity = Number(req.body.target_quantity);
    const discountedPrice = Number(req.body.discounted_price);
    const endsAt = req.body.ends_at;
    const supplierNote = req.body.supplier_note === undefined ? "" : req.body.supplier_note;

    if (
        !Number.isSafeInteger(productId) || productId < 1 ||
        !Number.isSafeInteger(targetQuantity) || targetQuantity < 1 || targetQuantity > 1000000 ||
        !Number.isFinite(discountedPrice) || discountedPrice < 0 || discountedPrice > 9999999999.99 ||
        typeof endsAt !== "string" || Number.isNaN(Date.parse(endsAt)) ||
        typeof supplierNote !== "string" || supplierNote.trim().length > 1000
    ) {
        return res.status(400).json({ error: "Check the deal target, price, end date, and note." });
    }

    try {
        const result = await req.app.locals.pool.query(
            `INSERT INTO group_deal_requests
                (product_id, supplier_id, target_quantity, discounted_price, ends_at, supplier_note)
             SELECT p.id, p.supplier_id, $3, $4, $5, $6
             FROM products p
             WHERE p.id = $1 AND p.supplier_id = $2 AND p.status = 'approved'
               AND $4 < p.wholesale_price AND $5::timestamptz > NOW()
             RETURNING id, product_id, status, created_at`,
            [
                productId,
                req.session.user.id,
                targetQuantity,
                discountedPrice,
                endsAt,
                supplierNote.trim()
            ]
        );
        if (!result.rowCount) {
            return res.status(400).json({
                error: "Choose your own approved product, an end date in the future, and a deal price below the regular price. Resolve any pending request first."
            });
        }
        res.status(201).json({
            message: "Your featured group deal request was sent to an admin.",
            request: result.rows[0]
        });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                error: "There is already a pending featured-deal request for this product."
            });
        }
        next(error);
    }
});

router.get("/", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT d.id, d.product_id, d.target_quantity, d.current_quantity,
                    d.discounted_price, d.ends_at, p.name, p.description,
                    p.category, p.image_url, p.unit_label, p.minimum_quantity,
                    p.wholesale_price,
                    u.name AS supplier_name
             FROM group_deals d
             JOIN products p ON p.id = d.product_id
             JOIN users u ON u.id = p.supplier_id
             WHERE d.status IN ('active', 'completed') AND p.status = 'approved'
             ORDER BY d.ends_at NULLS LAST, d.created_at DESC
             LIMIT 100`
        );
        res.json({ deals: result.rows });
    } catch (error) {
        next(error);
    }
});

router.post("/:dealId/join", requireAuth, requireRole("buyer"), async (req, res, next) => {
    const dealId = Number(req.params.dealId);
    const quantity = Number(req.body.quantity);

    if (
        !Number.isSafeInteger(dealId) || dealId < 1 ||
        !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000
    ) {
        return res.status(400).json({ error: "Provide a valid deal and quantity." });
    }

    const db = req.app.locals.pool;
    let client;

    try {
        client = await db.connect();
        await client.query("BEGIN");
        const result = await client.query(
            `SELECT d.id, d.product_id, d.target_quantity, d.current_quantity,
                    d.discounted_price, d.status, d.ends_at <= NOW() AS expired,
                    p.name AS product_name, p.wholesale_price,
                    p.minimum_quantity, p.stock_quantity, p.supplier_id,
                    u.payment_methods, u.payment_instructions
             FROM group_deals d
             JOIN products p ON p.id = d.product_id
             JOIN users u ON u.id = p.supplier_id
             WHERE d.id = $1 AND p.status = 'approved'
             FOR UPDATE OF d, p`,
            [dealId]
        );
        const deal = result.rows[0];

        if (!deal || deal.status !== "active") {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "This group deal is no longer available." });
        }
        if (deal.expired) {
            await client.query(
                "UPDATE group_deals SET status = 'expired' WHERE id = $1",
                [dealId]
            );
            await client.query("COMMIT");
            return res.status(410).json({ error: "This group deal has expired." });
        }
        if (quantity < Number(deal.minimum_quantity)) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                error: `The minimum contribution is ${deal.minimum_quantity}.`
            });
        }
        if (Number(deal.current_quantity) + quantity > Number(deal.target_quantity)) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "That quantity exceeds the deal's remaining target." });
        }
        if (quantity > Number(deal.stock_quantity)) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "There is not enough stock to reserve that group-deal quantity." });
        }
        const paymentMethods = Array.isArray(deal.payment_methods) ? deal.payment_methods : [];
        if (!paymentMethods.length || !deal.payment_instructions?.trim()) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                error: "This supplier has not set up payment methods for the group deal yet."
            });
        }

        const unitPriceCents = Math.round(Number(deal.discounted_price) * 100);
        const totalCents = unitPriceCents * quantity;
        if (
            !Number.isSafeInteger(totalCents) ||
            totalCents < 100 ||
            totalCents > 999999999999
        ) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                error: "The group order total must be between KSh 1 and KSh 9,999,999,999.99."
            });
        }

        const orderResult = await client.query(
            `INSERT INTO orders (buyer_id, total_amount)
             VALUES ($1, $2)
             RETURNING id, total_amount, status, payment_status, created_at`,
            [req.session.user.id, totalCents / 100]
        );
        const order = orderResult.rows[0];
        await client.query(
            `INSERT INTO supplier_order_payments
                (order_id, supplier_id, amount, payment_methods, payment_instructions)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                order.id,
                deal.supplier_id,
                totalCents / 100,
                paymentMethods,
                deal.payment_instructions
            ]
        );
        await client.query(
            `INSERT INTO order_items
                (order_id, product_id, group_deal_id, quantity, unit_price)
             VALUES ($1, $2, $3, $4, $5)`,
            [order.id, deal.product_id, dealId, quantity, unitPriceCents / 100]
        );

        await client.query(
            `INSERT INTO group_deal_participants (deal_id, user_id, quantity, order_id)
             VALUES ($1, $2, $3, $4)`,
            [dealId, req.session.user.id, quantity, order.id]
        );
        const updated = await client.query(
            `UPDATE group_deals
             SET current_quantity = current_quantity + $1,
                 status = CASE
                     WHEN current_quantity + $1 >= target_quantity THEN 'completed'
                     ELSE status
                 END
             WHERE id = $2
             RETURNING id, current_quantity, target_quantity, status`,
            [quantity, dealId]
        );
        await client.query(
            `UPDATE products SET stock_quantity = stock_quantity - $1
             WHERE id = $2`,
            [quantity, deal.product_id]
        );

        await client.query("COMMIT");
        res.status(201).json({
            deal: updated.rows[0],
            order: {
                ...order,
                product_name: deal.product_name,
                quantity,
                unit_price: unitPriceCents / 100
            }
        });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        if (error.code === "23505") {
            return res.status(409).json({ error: "You have already joined this group deal." });
        }
        next(error);
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
