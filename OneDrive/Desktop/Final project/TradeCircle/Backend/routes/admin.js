const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const { decryptBusinessProfile } = require("../config/business-profile");

router.use(requireAuth, requireRole("admin"));

router.get("/summary", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT
                (SELECT COUNT(*) FROM products WHERE status = 'pending')::int AS pending_products,
                (SELECT COUNT(*) FROM products WHERE status = 'approved')::int AS approved_products,
                (SELECT COUNT(*) FROM group_deal_requests WHERE status = 'pending')::int AS pending_deal_requests,
                (SELECT COUNT(*) FROM users
                                 WHERE supplier_verified = TRUE
                   AND deleted_at IS NULL)::int AS suppliers,
                (SELECT COUNT(*) FROM users
                 WHERE role <> 'admin' AND deleted_at IS NULL)::int AS total_accounts,
                (SELECT COUNT(*) FROM orders)::int AS total_orders,
                (SELECT COUNT(*) FROM (
                    SELECT status FROM payments
                    UNION ALL
                    SELECT status FROM supplier_order_payments
                ) payment_records WHERE status = 'paid')::int AS paid_payments`
        );
        res.json({ summary: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.get("/business-metrics", async (req, res, next) => {
    try {
        const db = req.app.locals.pool;
        const [revenueResult, monthlyRevenueResult, funnelResult, inventoryResult,
            inventoryForecastResult, paymentHealthResult] = await Promise.all([
            db.query(
                `SELECT
                    COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS lifetime_paid_revenue,
                    COALESCE(SUM(amount) FILTER (
                        WHERE status = 'paid' AND created_at >= NOW() - INTERVAL '30 days'
                    ), 0) AS paid_revenue_30d,
                    COALESCE(SUM(amount) FILTER (
                        WHERE status = 'paid'
                          AND created_at >= NOW() - INTERVAL '60 days'
                          AND created_at < NOW() - INTERVAL '30 days'
                    ), 0) AS paid_revenue_previous_30d,
                    COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_payment_count,
                    COALESCE(AVG(amount) FILTER (WHERE status = 'paid'), 0) AS average_paid_payment
                 FROM (
                     SELECT amount, status, created_at FROM payments
                     UNION ALL
                     SELECT amount, status, created_at FROM supplier_order_payments
                 ) payment_records`
            ),
            db.query(
                `SELECT TO_CHAR(months.month_start, 'Mon YYYY') AS month,
                        COALESCE(SUM(p.amount), 0) AS revenue
                 FROM generate_series(
                     DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months',
                     DATE_TRUNC('month', CURRENT_DATE),
                     INTERVAL '1 month'
                 ) AS months(month_start)
                 LEFT JOIN (
                     SELECT amount, status, created_at FROM payments
                     UNION ALL
                     SELECT amount, status, created_at FROM supplier_order_payments
                 ) p
                   ON p.status = 'paid'
                  AND p.created_at >= months.month_start
                  AND p.created_at < months.month_start + INTERVAL '1 month'
                 GROUP BY months.month_start
                 ORDER BY months.month_start`
            ),
            db.query(
                `SELECT COUNT(*)::int AS buyer_accounts,
                        COUNT(*) FILTER (WHERE EXISTS (
                            SELECT 1 FROM orders o WHERE o.buyer_id = u.id
                        ))::int AS buyers_with_orders,
                        COUNT(*) FILTER (WHERE EXISTS (
                            SELECT 1 FROM orders o
                            WHERE o.buyer_id = u.id AND o.payment_status = 'paid'
                        ))::int AS buyers_with_paid_orders,
                        COUNT(*) FILTER (
                            WHERE u.created_at >= NOW() - INTERVAL '30 days'
                        )::int AS new_buyers_30d
                 FROM users u
                 WHERE u.role IN ('buyer', 'supplier', 'buyer_supplier')
                   AND u.deleted_at IS NULL`
            ),
            db.query(
                `SELECT COUNT(*)::int AS approved_skus,
                        COUNT(*) FILTER (WHERE stock_quantity > 0)::int AS in_stock_skus,
                        COUNT(*) FILTER (
                            WHERE stock_quantity < minimum_quantity
                        )::int AS below_minimum_skus,
                        COUNT(*) FILTER (WHERE stock_quantity = 0)::int AS out_of_stock_skus
                 FROM products
                 WHERE status = 'approved'`
            ),
            db.query(
                `SELECT p.id, p.name, p.category, p.stock_quantity, p.minimum_quantity,
                        p.unit_label, COALESCE(s.business_name, s.name) AS supplier_name,
                        COALESCE(demand.units_sold_30d, 0)::int AS units_sold_30d,
                        CASE WHEN COALESCE(demand.units_sold_30d, 0) > 0
                            THEN ROUND(
                                p.stock_quantity::numeric * 30 / demand.units_sold_30d, 1
                            )
                            ELSE NULL
                        END AS estimated_days_on_hand
                 FROM products p
                 JOIN users s ON s.id = p.supplier_id
                 LEFT JOIN LATERAL (
                     SELECT SUM(oi.quantity) AS units_sold_30d
                     FROM order_items oi
                     JOIN orders o ON o.id = oi.order_id
                     WHERE oi.product_id = p.id
                       AND o.payment_status = 'paid'
                       AND o.status <> 'cancelled'
                       AND oi.fulfillment_status <> 'cancelled'
                       AND o.created_at >= NOW() - INTERVAL '30 days'
                 ) demand ON TRUE
                 WHERE p.status = 'approved'
                 ORDER BY
                    CASE WHEN COALESCE(demand.units_sold_30d, 0) > 0
                        THEN p.stock_quantity::numeric / demand.units_sold_30d
                        ELSE NULL
                    END ASC NULLS LAST,
                    p.stock_quantity ASC,
                    p.name ASC
                 LIMIT 12`
            ),
            db.query(
                `SELECT COUNT(*)::int AS total_transactions,
                        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_transactions,
                        COUNT(*) FILTER (WHERE status IN ('pending', 'reported'))::int AS pending_transactions,
                        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_transactions,
                        COUNT(*) FILTER (WHERE status = 'unpaid')::int AS unpaid_transactions,
                        COUNT(*) FILTER (WHERE provider = 'supplier')::int AS supplier_transactions
                 FROM (
                     SELECT status, provider FROM payments
                     UNION ALL
                     SELECT status, 'supplier' AS provider FROM supplier_order_payments
                 ) payment_records`
            )
        ]);

        res.json({
            revenue: revenueResult.rows[0],
            monthly_revenue: monthlyRevenueResult.rows,
            funnel: funnelResult.rows[0],
            inventory: inventoryResult.rows[0],
            inventory_forecast: inventoryForecastResult.rows,
            payment_health: paymentHealthResult.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

router.get("/accounts", async (req, res, next) => {
    const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const kind = ["buyers", "suppliers", "employees"].includes(req.query.kind)
        ? req.query.kind
        : "all";

    try {
        const result = await req.app.locals.pool.query(
            `SELECT u.id, u.name, u.email, u.phone, u.role, u.business_name,
                    u.supplier_verified, u.supplier_application_status,
                    u.created_at,
                    COALESCE(order_counts.total, 0)::int AS order_count,
                    COALESCE(product_counts.active, 0)::int AS active_product_count
             FROM users u
             LEFT JOIN LATERAL (
                 SELECT COUNT(*) AS total FROM orders o WHERE o.buyer_id = u.id
             ) order_counts ON TRUE
             LEFT JOIN LATERAL (
                 SELECT COUNT(*) AS active FROM products p
                 WHERE p.supplier_id = u.id AND p.status = 'approved'
             ) product_counts ON TRUE
             WHERE u.deleted_at IS NULL AND u.role <> 'admin'
               AND ($1 = '' OR u.name ILIKE $2 OR u.email ILIKE $2
                    OR COALESCE(u.business_name, '') ILIKE $2)
               AND ($3 = 'all'
                    OR ($3 = 'buyers' AND u.role IN ('buyer', 'buyer_supplier'))
                    OR ($3 = 'suppliers' AND (
                        u.supplier_verified = TRUE OR
                        u.supplier_application_status <> 'none' OR u.role = 'supplier'
                    ))
                    OR ($3 = 'employees' AND u.role = 'sales'))
             ORDER BY u.created_at DESC
             LIMIT 200`,
            [search, `%${search}%`, kind]
        );
        res.json({ accounts: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/accounts/:accountId", async (req, res, next) => {
    const accountId = Number(req.params.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 1) {
        return res.status(400).json({ error: "Provide a valid account." });
    }

    try {
        const db = req.app.locals.pool;
        const accountResult = await db.query(
            `SELECT id, name, email, phone, role, business_name,
                    supplier_verified, supplier_application_status,
                    supplier_application_note, business_profile, created_at
             FROM users
             WHERE id = $1 AND role <> 'admin' AND deleted_at IS NULL`,
            [accountId]
        );
        const account = accountResult.rows[0];
        if (!account) return res.status(404).json({ error: "Account not found." });
        account.business_profile = decryptBusinessProfile(account.business_profile);

        const [buyerResult, supplierResult] = await Promise.all([
            db.query(
                `SELECT o.id, o.total_amount, o.status, o.payment_status, o.created_at,
                        COALESCE(json_agg(json_build_object(
                            'product_id', p.id,
                            'product_name', p.name,
                            'supplier_id', s.id,
                            'supplier_name', COALESCE(s.business_name, s.name),
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price,
                            'fulfillment_status', oi.fulfillment_status,
                            'group_deal_id', oi.group_deal_id
                        ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
                 FROM orders o
                 LEFT JOIN order_items oi ON oi.order_id = o.id
                 LEFT JOIN products p ON p.id = oi.product_id
                 LEFT JOIN users s ON s.id = p.supplier_id
                 WHERE o.buyer_id = $1
                 GROUP BY o.id
                 ORDER BY o.created_at DESC
                 LIMIT 30`,
                [accountId]
            ),
            db.query(
                `SELECT p.id, p.name, p.category, p.image_url, p.status, p.stock_quantity,
                        p.wholesale_price, p.unit_label, p.created_at,
                        COUNT(DISTINCT oi.order_id)::int AS order_count,
                        COALESCE(SUM(oi.quantity * oi.unit_price)
                            FILTER (WHERE o.payment_status = 'paid'), 0) AS paid_sales
                 FROM products p
                 LEFT JOIN order_items oi ON oi.product_id = p.id
                 LEFT JOIN orders o ON o.id = oi.order_id
                 WHERE p.supplier_id = $1
                 GROUP BY p.id
                 ORDER BY p.created_at DESC
                 LIMIT 100`,
                [accountId]
            )
        ]);

        const buyerOrders = buyerResult.rows;
        const supplierProducts = supplierResult.rows;
        let supplierPaidSales = 0;
        for (const product of supplierProducts) {
            supplierPaidSales += Number(product.paid_sales) || 0;
        }
        const [buyerDealsResult, supplierOrdersResult, supplierDealsResult] = await Promise.all([
            db.query(
                `SELECT d.id, d.status, d.target_quantity, d.current_quantity,
                        d.discounted_price, d.ends_at, participant.quantity,
                        o.id AS order_id, o.payment_status,
                        p.name AS product_name, p.unit_label,
                        COALESCE(s.business_name, s.name) AS supplier_name
                 FROM group_deal_participants participant
                 JOIN group_deals d ON d.id = participant.deal_id
                 JOIN products p ON p.id = d.product_id
                 JOIN users s ON s.id = p.supplier_id
                 LEFT JOIN orders o ON o.id = participant.order_id
                 WHERE participant.user_id = $1
                 ORDER BY participant.created_at DESC
                 LIMIT 50`,
                [accountId]
            ),
            db.query(
                `SELECT o.id AS order_id, o.created_at, o.status AS order_status,
                        o.payment_status, o.total_amount,
                        oi.id AS item_id, oi.quantity, oi.unit_price,
                        oi.fulfillment_status, p.id AS product_id, p.name AS product_name,
                        p.unit_label, b.id AS buyer_id, b.name AS buyer_name,
                        b.email AS buyer_email
                 FROM order_items oi
                 JOIN orders o ON o.id = oi.order_id
                 JOIN products p ON p.id = oi.product_id
                 JOIN users b ON b.id = o.buyer_id
                 WHERE p.supplier_id = $1
                 ORDER BY o.created_at DESC, oi.id
                 LIMIT 100`,
                [accountId]
            ),
            db.query(
                `SELECT d.id, d.status, d.target_quantity, d.current_quantity,
                        d.discounted_price, d.ends_at, p.name AS product_name,
                        p.unit_label, COUNT(participant.id)::int AS participant_count
                 FROM group_deals d
                 JOIN products p ON p.id = d.product_id
                 LEFT JOIN group_deal_participants participant ON participant.deal_id = d.id
                 WHERE p.supplier_id = $1
                 GROUP BY d.id, p.id
                 ORDER BY d.created_at DESC
                 LIMIT 50`,
                [accountId]
            )
        ]);
        const supplierStatsResult = await db.query(
            `SELECT
                COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'approved')::int AS active_products,
                COUNT(DISTINCT oi.order_id) FILTER (WHERE o.payment_status = 'paid')::int AS paid_orders,
                COUNT(DISTINCT oi.order_id) FILTER (
                    WHERE oi.fulfillment_status IN ('pending', 'confirmed', 'processing', 'shipped')
                )::int AS open_orders
             FROM products p
             LEFT JOIN order_items oi ON oi.product_id = p.id
             LEFT JOIN orders o ON o.id = oi.order_id
             WHERE p.supplier_id = $1`,
            [accountId]
        );
        const buyerStatsResult = await db.query(
            `SELECT COUNT(*)::int AS order_count,
                    COUNT(*) FILTER (WHERE status NOT IN ('delivered', 'cancelled'))::int AS open_orders,
                    COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'paid'), 0) AS paid_total
             FROM orders WHERE buyer_id = $1`,
            [accountId]
        );

        res.json({
            account,
            buyer: {
                ...buyerStatsResult.rows[0],
                orders: buyerOrders,
                group_deals: buyerDealsResult.rows
            },
            supplier: {
                ...supplierStatsResult.rows[0],
                paid_sales: supplierPaidSales,
                products: supplierProducts,
                orders: supplierOrdersResult.rows,
                group_deals: supplierDealsResult.rows
            }
        });
    } catch (error) {
        next(error);
    }
});

router.patch("/accounts/:accountId/sales-access", async (req, res, next) => {
    const accountId = Number(req.params.accountId);
    const enabled = req.body?.enabled;
    if (!Number.isSafeInteger(accountId) || accountId < 1 ||
        typeof enabled !== "boolean") {
        return res.status(400).json({ error: "Provide a valid account and sales-access setting." });
    }

    const db = req.app.locals.pool;
    let client;
    try {
        client = await db.connect();
        await client.query("BEGIN");
        const accountResult = await client.query(
            `SELECT id, role, supplier_verified, supplier_application_status
             FROM users
             WHERE id = $1 AND deleted_at IS NULL
             FOR UPDATE`,
            [accountId]
        );
        const account = accountResult.rows[0];
        if (!account) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Account not found." });
        }
        if (!["buyer", "sales"].includes(account.role) ||
            account.supplier_verified ||
            account.supplier_application_status !== "none") {
            await client.query("ROLLBACK");
            return res.status(409).json({
                error: "Sales access can only be granted to a buyer account without supplier access or a pending supplier application."
            });
        }

        const role = enabled ? "sales" : "buyer";
        const updated = await client.query(
            "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, role",
            [role, accountId]
        );
        await client.query(
            `INSERT INTO admin_audit_log (actor_id, action, target_user_id, details)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [
                req.session.user.id,
                enabled ? "sales_access_granted" : "sales_access_revoked",
                accountId,
                JSON.stringify({ previous_role: account.role, role })
            ]
        );
        await client.query("COMMIT");
        res.json({ account: updated.rows[0] });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        next(error);
    } finally {
        if (client) client.release();
    }
});

router.get("/orders", async (req, res, next) => {
    const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const orderStatus = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"]
        .includes(req.query.status) ? req.query.status : "all";
    const paymentStatus = ["unpaid", "pending", "paid", "failed"].includes(req.query.payment)
        ? req.query.payment : "all";

    try {
        const result = await req.app.locals.pool.query(
            `SELECT o.id, o.total_amount, o.status, o.payment_status, o.created_at,
                    b.id AS buyer_id, b.name AS buyer_name, b.email AS buyer_email,
                    COALESCE(json_agg(json_build_object(
                        'product_id', p.id,
                        'product_name', p.name,
                        'image_url', p.image_url,
                        'supplier_id', s.id,
                        'supplier_name', COALESCE(s.business_name, s.name),
                        'supplier_email', s.email,
                        'quantity', oi.quantity,
                        'unit_price', oi.unit_price,
                        'unit_label', p.unit_label,
                        'fulfillment_status', oi.fulfillment_status,
                        'group_deal_id', oi.group_deal_id
                    ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items,
                    latest_payment.id AS latest_payment_id,
                    latest_payment.status AS latest_payment_status,
                    latest_payment.receipt_number AS latest_receipt_number
             FROM orders o
             JOIN users b ON b.id = o.buyer_id
             LEFT JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN products p ON p.id = oi.product_id
             LEFT JOIN users s ON s.id = p.supplier_id
             LEFT JOIN LATERAL (
                 SELECT id, status, receipt_number FROM payments
                 WHERE order_id = o.id ORDER BY id DESC LIMIT 1
             ) latest_payment ON TRUE
             WHERE ($1 = '' OR o.id::text ILIKE $2 OR b.name ILIKE $2 OR b.email ILIKE $2
                    OR EXISTS (
                        SELECT 1 FROM order_items search_items
                        JOIN products search_products ON search_products.id = search_items.product_id
                        JOIN users search_suppliers ON search_suppliers.id = search_products.supplier_id
                        WHERE search_items.order_id = o.id
                          AND (search_products.name ILIKE $2
                               OR search_suppliers.name ILIKE $2
                               OR search_suppliers.business_name ILIKE $2)
                    ))
               AND ($3 = 'all' OR o.status = $3)
               AND ($4 = 'all' OR o.payment_status = $4)
             GROUP BY o.id, b.id, latest_payment.id,
                      latest_payment.status, latest_payment.receipt_number
             ORDER BY o.created_at DESC
             LIMIT 200`,
            [search, `%${search}%`, orderStatus, paymentStatus]
        );
        res.json({ orders: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/payments", async (req, res, next) => {
    const status = ["unpaid", "reported", "pending", "paid", "failed"].includes(req.query.status)
        ? req.query.status : "all";
    try {
        const result = await req.app.locals.pool.query(
            `SELECT p.id, p.order_id, p.provider, p.receipt_number,
                    p.amount, p.status, p.created_at, p.supplier_name,
                    p.selected_method,
                    u.id AS buyer_id, u.name AS buyer_name, u.email AS buyer_email,
                    o.payment_status AS order_payment_status
             FROM (
                 SELECT sop.id, sop.order_id, 'supplier' AS provider,
                        NULL::TEXT AS receipt_number, sop.amount, sop.status,
                        sop.created_at, supplier.name AS supplier_name,
                        sop.selected_method
                 FROM supplier_order_payments sop
                 JOIN users supplier ON supplier.id = sop.supplier_id
                 UNION ALL
                 SELECT legacy.id, legacy.order_id, legacy.provider,
                        legacy.receipt_number, legacy.amount, legacy.status,
                        legacy.created_at, NULL::TEXT AS supplier_name,
                        NULL::VARCHAR AS selected_method
                 FROM payments legacy
             ) p
             JOIN orders o ON o.id = p.order_id
             JOIN users u ON u.id = o.buyer_id
             WHERE ($1 = 'all' OR p.status = $1)
             ORDER BY p.created_at DESC
             LIMIT 200`,
            [status]
        );
        res.json({ payments: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/group-deals", async (req, res, next) => {
    const status = ["active", "completed", "expired", "cancelled"].includes(req.query.status)
        ? req.query.status : "all";
    try {
        const result = await req.app.locals.pool.query(
            `SELECT d.id, d.product_id, d.target_quantity, d.current_quantity,
                    d.discounted_price, d.ends_at, d.status, d.created_at,
                    p.name AS product_name, p.image_url, p.unit_label, p.wholesale_price,
                    p.status AS product_status,
                    s.id AS supplier_id, COALESCE(s.business_name, s.name) AS supplier_name,
                    COUNT(DISTINCT participant.id)::int AS participant_count,
                    COALESCE(json_agg(DISTINCT jsonb_build_object(
                        'id', participant_user.id,
                        'name', participant_user.name,
                        'business_name', participant_user.business_name,
                        'quantity', participant.quantity
                    )) FILTER (WHERE participant.id IS NOT NULL), '[]') AS participants
             FROM group_deals d
             JOIN products p ON p.id = d.product_id
             JOIN users s ON s.id = p.supplier_id
             LEFT JOIN group_deal_participants participant ON participant.deal_id = d.id
             LEFT JOIN users participant_user ON participant_user.id = participant.user_id
             WHERE ($1 = 'all' OR d.status = $1)
             GROUP BY d.id, p.id, s.id
             ORDER BY CASE d.status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
                      d.ends_at NULLS LAST, d.created_at DESC
             LIMIT 200`,
            [status]
        );
        res.json({ deals: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/activity", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT * FROM (
                SELECT 'account' AS kind, 'account-' || id AS id,
                       'New account registered' AS title,
                       name || ' · ' || role AS detail,
                       created_at, role AS status
                FROM users WHERE role <> 'admin' AND deleted_at IS NULL
                UNION ALL
                SELECT 'listing', 'product-' || p.id,
                       'Product submitted for review',
                       p.name || ' · ' || COALESCE(u.business_name, u.name),
                       p.created_at, p.status
                FROM products p JOIN users u ON u.id = p.supplier_id
                UNION ALL
                SELECT 'deal', 'deal-' || d.id,
                       'Group deal opened',
                       p.name || ' · ' || COALESCE(u.business_name, u.name),
                       d.created_at, d.status
                FROM group_deals d
                JOIN products p ON p.id = d.product_id
                JOIN users u ON u.id = p.supplier_id
                UNION ALL
                SELECT 'order', 'order-' || o.id,
                       'Order placed',
                       'Order #' || o.id || ' · ' || u.name,
                       o.created_at, o.status
                FROM orders o JOIN users u ON u.id = o.buyer_id
                UNION ALL
                SELECT 'payment', 'payment-' || p.id,
                       'M-Pesa payment ' || p.status,
                       'Order #' || p.order_id || ' · KSh ' || p.amount,
                       p.created_at, p.status
                FROM payments p
                UNION ALL
                SELECT 'payment', 'supplier-payment-' || sop.id,
                       CASE sop.status
                           WHEN 'paid' THEN 'Supplier payment confirmed'
                           WHEN 'reported' THEN 'Buyer reported supplier payment'
                           ELSE 'Supplier payment awaiting buyer'
                       END,
                       'Order #' || sop.order_id || ' · ' || supplier.name
                           || ' · KSh ' || sop.amount,
                       COALESCE(sop.confirmed_at, sop.reported_at, sop.created_at),
                       sop.status
                FROM supplier_order_payments sop
                JOIN users supplier ON supplier.id = sop.supplier_id
                UNION ALL
                SELECT 'account', 'audit-' || audit.id,
                       'Administrator changed sales access',
                       actor.name || ' · ' || COALESCE(target.name, 'Deleted account')
                           || ' · ' || audit.action,
                       audit.created_at, audit.action
                FROM admin_audit_log audit
                JOIN users actor ON actor.id = audit.actor_id
                LEFT JOIN users target ON target.id = audit.target_user_id
                WHERE audit.action IN ('sales_access_granted', 'sales_access_revoked')
             ) activity
             ORDER BY created_at DESC
             LIMIT 60`
        );
        res.json({ activity: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/products/pending", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT p.id, p.name, p.description, p.category, p.image_url,
                    p.wholesale_price, p.unit_label, p.minimum_quantity,
                    p.stock_quantity,
                    p.created_at, u.name AS supplier_name, u.email AS supplier_email
             FROM products p
             JOIN users u ON u.id = p.supplier_id
             WHERE p.status = 'pending'
             ORDER BY p.created_at ASC
             LIMIT 100`
        );
        res.json({ products: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/products/approved", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT p.id, p.name, p.category, p.wholesale_price, p.unit_label,
                    p.stock_quantity, p.created_at,
                    u.name AS supplier_name, u.email AS supplier_email
             FROM products p
             JOIN users u ON u.id = p.supplier_id
             WHERE p.status = 'approved'
             ORDER BY p.created_at DESC
             LIMIT 200`
        );
        res.json({ products: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/products/:productId", async (req, res, next) => {
    const productId = Number(req.params.productId);
    if (!Number.isSafeInteger(productId) || productId < 1) {
        return res.status(400).json({ error: "Provide a valid product." });
    }
    try {
        const result = await req.app.locals.pool.query(
            `SELECT p.id, p.name, p.description, p.category, p.image_url,
                    p.wholesale_price, p.unit_label, p.minimum_quantity,
                    p.stock_quantity, p.status, p.created_at,
                    u.id AS supplier_id, COALESCE(u.business_name, u.name) AS supplier_name,
                    u.email AS supplier_email, u.supplier_verified,
                    COALESCE(order_stats.order_count, 0)::int AS order_count,
                    COALESCE(order_stats.paid_sales, 0) AS paid_sales,
                    COALESCE(deal_stats.deals, '[]') AS group_deals
             FROM products p
             JOIN users u ON u.id = p.supplier_id
             LEFT JOIN LATERAL (
                 SELECT COUNT(DISTINCT oi.order_id) AS order_count,
                        SUM(oi.quantity * oi.unit_price)
                            FILTER (WHERE o.payment_status = 'paid') AS paid_sales
                 FROM order_items oi
                 JOIN orders o ON o.id = oi.order_id
                 WHERE oi.product_id = p.id
             ) order_stats ON TRUE
             LEFT JOIN LATERAL (
                 SELECT json_agg(json_build_object(
                     'id', d.id,
                     'status', d.status,
                     'target_quantity', d.target_quantity,
                     'current_quantity', d.current_quantity,
                     'discounted_price', d.discounted_price,
                     'ends_at', d.ends_at
                 ) ORDER BY d.created_at DESC) AS deals
                 FROM group_deals d WHERE d.product_id = p.id
             ) deal_stats ON TRUE
             WHERE p.id = $1`,
            [productId]
        );
        if (!result.rows[0]) return res.status(404).json({ error: "Product not found." });
        res.json({ product: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.get("/deal-requests", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT r.id, r.product_id, r.target_quantity, r.discounted_price,
                    r.ends_at, r.supplier_note, r.created_at,
                    p.name AS product_name, p.unit_label, p.wholesale_price,
                    u.name AS supplier_name, u.email AS supplier_email
             FROM group_deal_requests r
             JOIN products p ON p.id = r.product_id
             JOIN users u ON u.id = r.supplier_id
             WHERE r.status = 'pending'
             ORDER BY r.created_at ASC
             LIMIT 100`
        );
        res.json({ requests: result.rows });
    } catch (error) {
        next(error);
    }
});

router.patch("/deal-requests/:requestId", async (req, res, next) => {
    const requestId = Number(req.params.requestId);
    const { status } = req.body;
    if (!Number.isSafeInteger(requestId) || requestId < 1 ||
        !["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Choose approve or reject for a valid deal request." });
    }

    const db = req.app.locals.pool;
    let client;
    try {
        client = await db.connect();
        await client.query("BEGIN");
        const requestResult = await client.query(
            `SELECT r.id, r.product_id, r.target_quantity, r.discounted_price,
                    r.ends_at, p.wholesale_price, p.status AS product_status
             FROM group_deal_requests r
             JOIN products p ON p.id = r.product_id
             WHERE r.id = $1 AND r.status = 'pending'
             FOR UPDATE OF r`,
            [requestId]
        );
        const request = requestResult.rows[0];
        if (!request) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Pending group deal request not found." });
        }

        if (status === "approved" &&
            (request.product_status !== "approved" ||
             Number(request.discounted_price) >= Number(request.wholesale_price) ||
             new Date(request.ends_at).getTime() <= Date.now())) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                error: "This product is no longer approved or the requested deal has expired. Ask the supplier to submit a new request."
            });
        }

        let groupDealId = null;
        if (status === "approved") {
            const dealResult = await client.query(
                `INSERT INTO group_deals
                    (product_id, target_quantity, discounted_price, ends_at, status)
                 VALUES ($1, $2, $3, $4, 'active')
                 RETURNING id`,
                [
                    request.product_id,
                    request.target_quantity,
                    request.discounted_price,
                    request.ends_at
                ]
            );
            groupDealId = dealResult.rows[0].id;
        }

        await client.query(
            `UPDATE group_deal_requests
             SET status = $1, group_deal_id = $2, reviewed_at = NOW()
             WHERE id = $3`,
            [status, groupDealId, requestId]
        );
        await client.query("COMMIT");
        res.json({ status, group_deal_id: groupDealId });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        next(error);
    } finally {
        if (client) client.release();
    }
});

router.get("/suppliers", async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT id, name, email, phone, business_name,
                    supplier_application_note, supplier_application_status,
                    created_at
             FROM users
             WHERE supplier_application_status = 'pending' AND deleted_at IS NULL
             ORDER BY created_at ASC
             LIMIT 200`
        );
        res.json({ suppliers: result.rows });
    } catch (error) {
        next(error);
    }
});

router.patch("/suppliers/:supplierId/verification", async (req, res, next) => {
    const supplierId = Number(req.params.supplierId);
    const { status } = req.body;

    if (!Number.isSafeInteger(supplierId) || supplierId < 1 ||
        !["approved", "rejected"].includes(status)) {
        return res.status(400).json({
            error: "Choose approve or reject for a valid supplier application."
        });
    }

    try {
        const result = await req.app.locals.pool.query(
            `UPDATE users
             SET supplier_verified = ($1 = 'approved'),
                 supplier_application_status = $1,
                 role = CASE WHEN $1 = 'approved' THEN 'buyer_supplier' ELSE 'buyer' END
             WHERE id = $2 AND deleted_at IS NULL
               AND supplier_application_status = 'pending'
             RETURNING id, supplier_verified, supplier_application_status, role`,
            [status, supplierId]
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: "Pending supplier application not found." });
        }
        res.json({ supplier: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.patch("/products/:productId", async (req, res, next) => {
    const productId = Number(req.params.productId);
    const { status } = req.body;

    if (
        !Number.isSafeInteger(productId) || productId < 1 ||
        !["approved", "rejected"].includes(status)
    ) {
        return res.status(400).json({ error: "Choose approve or reject for a valid product." });
    }

    try {
        const result = await req.app.locals.pool.query(
            `UPDATE products
             SET status = $1
             WHERE id = $2 AND status = 'pending'
             RETURNING id, status`,
            [status, productId]
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: "Pending product not found." });
        }
        res.json({ product: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

router.delete("/products/:productId", async (req, res, next) => {
    const productId = Number(req.params.productId);
    if (!Number.isSafeInteger(productId) || productId < 1) {
        return res.status(400).json({ error: "Provide a valid product." });
    }
    try {
        const result = await req.app.locals.pool.query(
            `UPDATE products
             SET status = 'rejected'
             WHERE id = $1 AND status = 'approved'
             RETURNING id, status`,
            [productId]
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: "Approved product not found." });
        }
        res.json({ product: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
