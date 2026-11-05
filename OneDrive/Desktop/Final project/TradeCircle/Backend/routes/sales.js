const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("sales"));

function validId(value) {
    if (typeof value !== "number" &&
        (typeof value !== "string" || !/^\d+$/.test(value))) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validDate(value) {
    if (value === undefined || value === null || value === "") return true;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function buyerExists(db, buyerId) {
    const result = await db.query(
        `SELECT id FROM users
         WHERE id = $1 AND role IN ('buyer', 'buyer_supplier') AND deleted_at IS NULL`,
        [buyerId]
    );
    return result.rowCount > 0;
}

router.get("/overview", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT
                (SELECT COUNT(*) FROM users
                 WHERE role IN ('buyer', 'buyer_supplier') AND deleted_at IS NULL)::int AS buyer_accounts,
                (SELECT COUNT(*) FROM orders)::int AS total_orders,
                (SELECT COUNT(*) FROM orders WHERE payment_status = 'paid')::int AS paid_orders,
                (SELECT COALESCE(SUM(amount), 0) FROM (
                    SELECT amount FROM payments WHERE status = 'paid'
                    UNION ALL
                    SELECT amount FROM supplier_order_payments WHERE status = 'paid'
                ) confirmed_payments) AS verified_payment_total,
                (SELECT COUNT(*) FROM sales_followups
                 WHERE sales_id = $1 AND status = 'open')::int AS open_followups,
                (SELECT COUNT(*) FROM sales_rfqs
                 WHERE sales_id = $1 AND status IN ('open', 'quoted'))::int AS open_rfqs`,
            [req.session.user.id]
        );
        res.json({ overview: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.get("/clients", async (req, res, next) => {
    const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    try {
        const result = await req.app.locals.pool.query(
            `SELECT u.id, u.name, u.email, u.phone, u.business_name, u.created_at,
                    COALESCE(order_stats.order_count, 0)::int AS order_count,
                    COALESCE(order_stats.open_orders, 0)::int AS open_orders,
                    COALESCE(order_stats.paid_total, 0) AS paid_total,
                    order_stats.latest_order_at
             FROM users u
             LEFT JOIN LATERAL (
                 SELECT COUNT(*) AS order_count,
                        COUNT(*) FILTER (
                            WHERE o.status NOT IN ('delivered', 'cancelled')
                        ) AS open_orders,
                        COALESCE(SUM(o.total_amount) FILTER (
                            WHERE o.payment_status = 'paid'
                        ), 0) AS paid_total,
                        MAX(o.created_at) AS latest_order_at
                 FROM orders o WHERE o.buyer_id = u.id
             ) order_stats ON TRUE
             WHERE u.role IN ('buyer', 'buyer_supplier') AND u.deleted_at IS NULL
               AND ($1 = '' OR u.name ILIKE $2 OR u.email ILIKE $2
                    OR COALESCE(u.business_name, '') ILIKE $2)
             ORDER BY order_stats.latest_order_at DESC NULLS LAST, u.created_at DESC
             LIMIT 200`,
            [search, `%${search}%`]
        );
        res.json({ clients: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/clients/:clientId", async (req, res, next) => {
    const clientId = validId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Provide a valid buyer account." });

    try {
        const db = req.app.locals.pool;
        const clientResult = await db.query(
            `SELECT id, name, email, phone, business_name, created_at
             FROM users
             WHERE id = $1 AND role IN ('buyer', 'buyer_supplier') AND deleted_at IS NULL`,
            [clientId]
        );
        if (!clientResult.rowCount) return res.status(404).json({ error: "Buyer account not found." });

        const [ordersResult, paymentsResult] = await Promise.all([
            db.query(
                `SELECT o.id, o.total_amount, o.status, o.payment_status, o.created_at,
                        COALESCE(json_agg(json_build_object(
                            'name', p.name, 'quantity', oi.quantity,
                            'unit_label', p.unit_label, 'unit_price', oi.unit_price
                        ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
                 FROM orders o
                 LEFT JOIN order_items oi ON oi.order_id = o.id
                 LEFT JOIN products p ON p.id = oi.product_id
                 WHERE o.buyer_id = $1
                 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 50`,
                [clientId]
            ),
            db.query(
                `SELECT p.id, p.amount, p.status, p.receipt_number, p.created_at,
                        p.order_id, p.provider, p.selected_method, p.supplier_name
                 FROM (
                     SELECT legacy.id, legacy.amount, legacy.status,
                            legacy.receipt_number, legacy.created_at, legacy.order_id,
                            legacy.provider, NULL::VARCHAR AS selected_method,
                            NULL::TEXT AS supplier_name
                     FROM payments legacy
                     UNION ALL
                     SELECT sop.id, sop.amount, sop.status, NULL::TEXT AS receipt_number,
                            sop.created_at, sop.order_id, 'supplier' AS provider,
                            sop.selected_method, supplier.name AS supplier_name
                     FROM supplier_order_payments sop
                     JOIN users supplier ON supplier.id = sop.supplier_id
                 ) p
                 JOIN orders o ON o.id = p.order_id
                 WHERE o.buyer_id = $1
                 ORDER BY p.created_at DESC LIMIT 50`,
                [clientId]
            )
        ]);
        res.json({
            client: clientResult.rows[0],
            orders: ordersResult.rows,
            payments: paymentsResult.rows
        });
    } catch (error) {
        next(error);
    }
});

router.get("/followups", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT f.id, f.buyer_id, f.title, f.notes, f.due_at, f.status,
                    f.created_at, u.name AS buyer_name, u.business_name
             FROM sales_followups f
             JOIN users u ON u.id = f.buyer_id
             WHERE f.sales_id = $1
             ORDER BY (f.status = 'open') DESC, f.due_at ASC NULLS LAST,
                      f.created_at DESC
             LIMIT 200`,
            [req.session.user.id]
        );
        res.json({ followups: result.rows });
    } catch (error) {
        next(error);
    }
});

router.post("/followups", async (req, res, next) => {
    const buyerId = validId(req.body?.buyer_id);
    const { title, notes = "", due_at: dueAt = null } = req.body || {};
    if (!buyerId || typeof title !== "string" || title.trim().length < 2 ||
        title.length > 180 || typeof notes !== "string" || notes.length > 2000 ||
        !validDate(dueAt)) {
        return res.status(400).json({ error: "Enter a client, a short follow-up title, valid notes, and a valid due date." });
    }

    try {
        const db = req.app.locals.pool;
        if (!await buyerExists(db, buyerId)) {
            return res.status(404).json({ error: "Buyer account not found." });
        }
        const result = await db.query(
            `INSERT INTO sales_followups (sales_id, buyer_id, title, notes, due_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, buyer_id, title, notes, due_at, status, created_at`,
            [req.session.user.id, buyerId, title.trim(), notes.trim(), dueAt || null]
        );
        res.status(201).json({ followup: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.patch("/followups/:followupId", async (req, res, next) => {
    const followupId = validId(req.params.followupId);
    if (!followupId || req.body?.status !== "completed") {
        return res.status(400).json({ error: "Choose a valid follow-up and mark it completed." });
    }
    try {
        const result = await req.app.locals.pool.query(
            `UPDATE sales_followups SET status = 'completed', updated_at = NOW()
             WHERE id = $1 AND sales_id = $2 AND status = 'open'
             RETURNING id, status`,
            [followupId, req.session.user.id]
        );
        if (!result.rowCount) return res.status(404).json({ error: "Open follow-up not found." });
        res.json({ followup: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.get("/rfqs", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT r.id, r.buyer_id, r.requirements, r.quantity, r.target_price,
                    r.needed_by, r.status, r.created_at,
                    u.name AS buyer_name, u.business_name,
                    COALESCE(json_agg(json_build_object(
                        'id', q.id, 'amount', q.amount, 'valid_until', q.valid_until,
                        'terms', q.terms, 'status', q.status, 'created_at', q.created_at
                    ) ORDER BY q.created_at DESC) FILTER (WHERE q.id IS NOT NULL), '[]') AS quotes
             FROM sales_rfqs r
             JOIN users u ON u.id = r.buyer_id
             LEFT JOIN sales_quotes q ON q.rfq_id = r.id AND q.sales_id = $1
             WHERE r.sales_id = $1
             GROUP BY r.id, u.id
             ORDER BY r.created_at DESC LIMIT 200`,
            [req.session.user.id]
        );
        res.json({ rfqs: result.rows });
    } catch (error) {
        next(error);
    }
}); 

router.post("/rfqs", async (req, res, next) => {
    const buyerId = validId(req.body?.buyer_id);
    const { requirements, quantity, target_price: targetPrice = null, needed_by: neededBy = null } = req.body || {};
    const quantityIsNumeric = typeof quantity === "number" ||
        (typeof quantity === "string" && /^\d+$/.test(quantity));
    const targetIsNumeric = targetPrice === null || targetPrice === "" ||
        typeof targetPrice === "number" ||
        (typeof targetPrice === "string" && /^\d+(?:\.\d{1,2})?$/.test(targetPrice));
    const normalizedQuantity = quantityIsNumeric ? Number(quantity) : NaN;
    const normalizedTarget = targetPrice === null || targetPrice === "" ? null : Number(targetPrice);
    if (!buyerId || typeof requirements !== "string" || requirements.trim().length < 5 ||
        requirements.length > 5000 || !Number.isSafeInteger(normalizedQuantity) ||
        !quantityIsNumeric || normalizedQuantity < 1 || normalizedQuantity > 100000 ||
        !targetIsNumeric ||
        (normalizedTarget !== null && (!Number.isFinite(normalizedTarget) || normalizedTarget < 0)) ||
        !validDate(neededBy)) {
        return res.status(400).json({ error: "Enter a client, requirements, whole-number quantity, and valid optional price and date." });
    }
    try {
        const db = req.app.locals.pool;
        if (!await buyerExists(db, buyerId)) {
            return res.status(404).json({ error: "Buyer account not found." });
        }
        const result = await db.query(
            `INSERT INTO sales_rfqs
                (sales_id, buyer_id, requirements, quantity, target_price, needed_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, buyer_id, requirements, quantity, target_price,
                       needed_by, status, created_at`,
            [req.session.user.id, buyerId, requirements.trim(), normalizedQuantity, normalizedTarget, neededBy || null]
        );
        res.status(201).json({ rfq: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.patch("/rfqs/:rfqId", async (req, res, next) => {
    const rfqId = validId(req.params.rfqId);
    const status = req.body?.status;
    if (!rfqId || !["won", "lost", "cancelled"].includes(status)) {
        return res.status(400).json({ error: "Choose a valid RFQ outcome." });
    }
    try {
        const result = await req.app.locals.pool.query(
            `UPDATE sales_rfqs SET status = $1, updated_at = NOW()
             WHERE id = $2 AND sales_id = $3 AND status IN ('open', 'quoted')
             RETURNING id, status`,
            [status, rfqId, req.session.user.id]
        );
        if (!result.rowCount) return res.status(404).json({ error: "Open RFQ not found." });
        res.json({ rfq: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.post("/rfqs/:rfqId/quotes", async (req, res, next) => {
    const rfqId = validId(req.params.rfqId);
    const amountValue = req.body?.amount;
    const amountIsNumeric = typeof amountValue === "number" ||
        (typeof amountValue === "string" && /^\d+(?:\.\d{1,2})?$/.test(amountValue));
    const amount = Number(amountValue);
    const validUntil = req.body?.valid_until ?? null;
    const terms = req.body?.terms ?? "";
    if (!rfqId || !amountIsNumeric || !Number.isFinite(amount) || amount <= 0 ||
        !validDate(validUntil) || typeof terms !== "string" || terms.length > 2000) {
        return res.status(400).json({ error: "Enter a positive quote amount, valid expiry date, and terms under 2,000 characters." });
    }
    const db = req.app.locals.pool;
    let client;
    try {
        client = await db.connect();
        await client.query("BEGIN");
        const rfqResult = await client.query(
            `SELECT id FROM sales_rfqs WHERE id = $1 AND sales_id = $2
             FOR UPDATE`,
            [rfqId, req.session.user.id]
        );
        if (!rfqResult.rowCount) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Your RFQ was not found." });
        }
        const quoteResult = await client.query(
            `INSERT INTO sales_quotes (rfq_id, sales_id, amount, valid_until, terms)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, rfq_id, amount, valid_until, terms, status, created_at`,
            [rfqId, req.session.user.id, amount, validUntil || null, terms.trim()]
        );
        await client.query(
            `UPDATE sales_rfqs SET status = 'quoted', updated_at = NOW()
             WHERE id = $1 AND status = 'open'`,
            [rfqId]
        );
        await client.query("COMMIT");
        res.status(201).json({ quote: quoteResult.rows[0] });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        next(error);
    } finally {
        if (client) client.release();
    }
});

router.patch("/quotes/:quoteId", async (req, res, next) => {
    const quoteId = validId(req.params.quoteId);
    const status = req.body?.status;
    if (!quoteId || !["shared", "accepted", "declined", "cancelled"].includes(status)) {
        return res.status(400).json({ error: "Choose a valid quote status." });
    }
    try {
        const result = await req.app.locals.pool.query(
            `UPDATE sales_quotes SET status = $1
             WHERE id = $2 AND sales_id = $3
               AND (($1 = 'shared' AND status = 'draft')
                    OR ($1 IN ('accepted', 'declined') AND status = 'shared')
                    OR ($1 = 'cancelled' AND status IN ('draft', 'shared')))
             RETURNING id, rfq_id, status`,
            [status, quoteId, req.session.user.id]
        );
        if (!result.rowCount) return res.status(404).json({ error: "Editable quote not found." });
        res.json({ quote: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
