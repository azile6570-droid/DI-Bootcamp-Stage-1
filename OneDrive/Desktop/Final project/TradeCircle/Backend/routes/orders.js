const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");

const PAYMENT_METHODS = new Set(["mpesa", "bank_transfer", "card", "cash", "other"]);
const MAX_ORDER_TOTAL_CENTS = 999999999999;

async function updateOrderPaymentStatus(client, orderId) {
    await client.query(
        `UPDATE orders
         SET payment_status = CASE
             WHEN NOT EXISTS (
                 SELECT 1 FROM supplier_order_payments
                 WHERE order_id = $1 AND status <> 'paid'
             ) THEN 'paid'
             WHEN EXISTS (
                 SELECT 1 FROM supplier_order_payments
                 WHERE order_id = $1 AND status = 'reported'
             ) THEN 'pending'
             ELSE 'unpaid'
         END
         WHERE id = $1`,
        [orderId]
    );
}

router.get("/mine", requireAuth, requireRole("buyer"), async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT o.id, o.total_amount, o.status, o.payment_status, o.created_at,
                    COALESCE(
                        json_agg(json_build_object(
                            'product_id', oi.product_id,
                            'name', p.name,
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price,
                            'unit_label', p.unit_label,
                            'group_deal_id', oi.group_deal_id,
                            'fulfillment_status', oi.fulfillment_status,
                            'supplier_name', s.name
                        )) FILTER (WHERE oi.id IS NOT NULL),
                        '[]'
                    ) AS items,
                    COALESCE(
                        (
                            SELECT json_agg(json_build_object(
                                'supplier_id', sop.supplier_id,
                                'supplier_name', supplier.name,
                                'amount', sop.amount,
                                'payment_methods', sop.payment_methods,
                                'payment_instructions', sop.payment_instructions,
                                'selected_method', sop.selected_method,
                                'status', sop.status
                            ) ORDER BY supplier.name)
                            FROM supplier_order_payments sop
                            JOIN users supplier ON supplier.id = sop.supplier_id
                            WHERE sop.order_id = o.id
                        ),
                        '[]'::json
                    ) AS supplier_payments
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN products p ON p.id = oi.product_id
             LEFT JOIN users s ON s.id = p.supplier_id
             WHERE o.buyer_id = $1
             GROUP BY o.id
             ORDER BY o.created_at DESC
             LIMIT 100`,
            [req.session.user.id]
        );
        res.json({ orders: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get("/supplier", requireAuth, requireRole("supplier"), async (req, res, next) => {
    try {
        const result = await req.app.locals.pool.query(
            `SELECT oi.id AS item_id, o.id AS order_id, o.created_at,
                    o.payment_status, u.name AS buyer_name,
                    sop.id AS supplier_payment_id,
                    sop.status AS supplier_payment_status,
                    sop.amount AS supplier_payment_amount,
                    sop.selected_method AS supplier_payment_method,
                    p.name AS product_name, p.unit_label,
                    oi.quantity, oi.unit_price,
                    oi.fulfillment_status
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             JOIN products p ON p.id = oi.product_id
             JOIN users u ON u.id = o.buyer_id
             LEFT JOIN supplier_order_payments sop
               ON sop.order_id = o.id AND sop.supplier_id = p.supplier_id
             WHERE p.supplier_id = $1
             ORDER BY o.created_at DESC, oi.id
             LIMIT 200`,
            [req.session.user.id]
        );
        res.json({ orders: result.rows });
    } catch (error) {
        next(error);
    }
});

router.get(
    "/supplier/payment-settings",
    requireAuth,
    requireRole("supplier"),
    async (req, res, next) => {
        try {
            const result = await req.app.locals.pool.query(
                `SELECT payment_methods, payment_instructions
                 FROM users WHERE id = $1`,
                [req.session.user.id]
            );
            res.json({ settings: result.rows[0] });
        } catch (error) {
            next(error);
        }
    }
);

router.put(
    "/supplier/payment-settings",
    requireAuth,
    requireRole("supplier"),
    async (req, res, next) => {
        const { payment_methods: methods, payment_instructions: instructions } = req.body;
        if (
            !Array.isArray(methods) ||
            methods.length < 1 ||
            methods.length > PAYMENT_METHODS.size ||
            methods.some((method) => typeof method !== "string" || !PAYMENT_METHODS.has(method)) ||
            new Set(methods).size !== methods.length ||
            typeof instructions !== "string" ||
            instructions.trim().length < 3 ||
            instructions.length > 2000
        ) {
            return res.status(400).json({
                error: "Select at least one payment method and provide payment instructions (up to 2,000 characters)."
            });
        }

        try {
            const result = await req.app.locals.pool.query(
                `UPDATE users
                 SET payment_methods = $1, payment_instructions = $2
                 WHERE id = $3
                 RETURNING payment_methods, payment_instructions`,
                [methods, instructions.trim(), req.session.user.id]
            );
            if (!result.rowCount) {
                return res.status(404).json({ error: "Supplier account not found." });
            }
            res.json({ settings: result.rows[0] });
        } catch (error) {
            next(error);
        }
    }
);

router.post(
    "/:orderId/supplier-payments/:supplierId/report",
    requireAuth,
    requireRole("buyer"),
    async (req, res, next) => {
        const orderId = Number(req.params.orderId);
        const supplierId = Number(req.params.supplierId);
        const method = req.body.payment_method;
        if (
            !Number.isSafeInteger(orderId) || orderId < 1 ||
            !Number.isSafeInteger(supplierId) || supplierId < 1 ||
            typeof method !== "string" || !PAYMENT_METHODS.has(method)
        ) {
            return res.status(400).json({ error: "Provide a valid order and payment method." });
        }

        const db = req.app.locals.pool;
        let client;
        try {
            client = await db.connect();
            await client.query("BEGIN");
            const paymentResult = await client.query(
                `SELECT sop.status, sop.payment_methods, o.buyer_id
                 FROM supplier_order_payments sop
                 JOIN orders o ON o.id = sop.order_id
                 WHERE sop.order_id = $1 AND sop.supplier_id = $2
                 FOR UPDATE OF sop, o`,
                [orderId, supplierId]
            );
            const payment = paymentResult.rows[0];
            if (!payment || String(payment.buyer_id) !== String(req.session.user.id)) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Supplier payment not found." });
            }
            if (payment.status !== "unpaid") {
                await client.query("ROLLBACK");
                return res.status(409).json({ error: "This supplier payment has already been reported." });
            }
            if (!payment.payment_methods.includes(method)) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "That supplier does not accept the selected payment method." });
            }

            await client.query(
                `UPDATE supplier_order_payments
                 SET status = 'reported', selected_method = $1, reported_at = NOW()
                 WHERE order_id = $2 AND supplier_id = $3`,
                [method, orderId, supplierId]
            );
            await updateOrderPaymentStatus(client, orderId);
            await client.query("COMMIT");
            res.json({ message: "Payment reported. The supplier will confirm when received." });
        } catch (error) {
            if (client) await client.query("ROLLBACK");
            next(error);
        } finally {
            if (client) client.release();
        }
    }
);

router.post(
    "/supplier-payments/:paymentId/confirm",
    requireAuth,
    requireRole("supplier"),
    async (req, res, next) => {
        const paymentId = Number(req.params.paymentId);
        if (!Number.isSafeInteger(paymentId) || paymentId < 1) {
            return res.status(400).json({ error: "Provide a valid supplier payment." });
        }

        const db = req.app.locals.pool;
        let client;
        try {
            client = await db.connect();
            await client.query("BEGIN");
            const paymentResult = await client.query(
                `SELECT sop.id, sop.order_id, sop.status
                 FROM supplier_order_payments sop
                 JOIN orders o ON o.id = sop.order_id
                 WHERE sop.id = $1 AND sop.supplier_id = $2
                 FOR UPDATE OF sop, o`,
                [paymentId, req.session.user.id]
            );
            const payment = paymentResult.rows[0];
            if (!payment) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Supplier payment not found." });
            }
            if (payment.status !== "reported") {
                await client.query("ROLLBACK");
                return res.status(409).json({ error: "Only a reported payment can be confirmed." });
            }

            await client.query(
                `UPDATE supplier_order_payments
                 SET status = 'paid', confirmed_at = NOW()
                 WHERE id = $1`,
                [paymentId]
            );
            await updateOrderPaymentStatus(client, payment.order_id);
            await client.query("COMMIT");
            res.json({ message: "Payment confirmed." });
        } catch (error) {
            if (client) await client.query("ROLLBACK");
            next(error);
        } finally {
            if (client) client.release();
        }
    }
);

router.patch(
    "/supplier/items/:itemId",
    requireAuth,
    requireRole("supplier"),
    async (req, res, next) => {
        const itemId = Number(req.params.itemId);
        const { status } = req.body;
        const validTransitions = {
            pending: ["confirmed", "cancelled"],
            confirmed: ["processing", "cancelled"],
            processing: ["shipped", "cancelled"],
            shipped: ["delivered"],
            delivered: [],
            cancelled: []
        };

        if (
            !Number.isSafeInteger(itemId) || itemId < 1 ||
            !Object.values(validTransitions).some((statuses) => statuses.includes(status))
        ) {
            return res.status(400).json({ error: "Provide a valid order item and fulfillment status." });
        }

        const db = req.app.locals.pool;
        let client;
        try {
            client = await db.connect();
            await client.query("BEGIN");
            const current = await client.query(
                `SELECT oi.order_id, oi.fulfillment_status,
                        COALESCE(sop.status, o.payment_status) AS supplier_payment_status
                 FROM order_items oi
                 JOIN products p ON p.id = oi.product_id
                 JOIN orders o ON o.id = oi.order_id
                 LEFT JOIN supplier_order_payments sop
                   ON sop.order_id = o.id AND sop.supplier_id = p.supplier_id
                 WHERE oi.id = $1 AND p.supplier_id = $2
                 FOR UPDATE OF oi`,
                [itemId, req.session.user.id]
            );
            if (!current.rowCount) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Order item not found." });
            }

            const orderItem = current.rows[0];
            if (status !== "cancelled" && orderItem.supplier_payment_status !== "paid") {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    error: "Orders must be paid before supplier fulfillment can begin."
                });
            }
            if (!validTransitions[orderItem.fulfillment_status].includes(status)) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    error: `Cannot change fulfillment from ${orderItem.fulfillment_status} to ${status}.`
                });
            }

            await client.query(
                "UPDATE order_items SET fulfillment_status = $1 WHERE id = $2",
                [status, itemId]
            );
            await client.query(
                `UPDATE orders o
                 SET status = (
                     SELECT CASE
                         WHEN bool_and(fulfillment_status = 'cancelled') THEN 'cancelled'
                         WHEN bool_and(fulfillment_status IN ('delivered', 'cancelled')) THEN 'delivered'
                         WHEN bool_or(fulfillment_status IN ('shipped', 'delivered')) THEN 'shipped'
                         WHEN bool_or(fulfillment_status = 'processing') THEN 'processing'
                         WHEN bool_or(fulfillment_status = 'confirmed') THEN 'confirmed'
                         ELSE 'pending'
                     END
                     FROM order_items
                     WHERE order_id = o.id
                 )
                 WHERE o.id = $1`,
                [orderItem.order_id]
            );
            await client.query("COMMIT");
            res.json({ item_id: itemId, fulfillment_status: status });
        } catch (error) {
            if (client) await client.query("ROLLBACK");
            next(error);
        } finally {
            if (client) client.release();
        }
    }
);

router.post("/", requireAuth, requireRole("buyer"), async (req, res, next) => {
    const items = req.body.items;
    if (
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > 100 ||
        items.some((item) =>
            !Number.isSafeInteger(Number(item?.product_id)) ||
            Number(item.product_id) < 1 ||
            !Number.isSafeInteger(Number(item?.quantity)) ||
            Number(item.quantity) < 1 ||
            Number(item.quantity) > 100000
        )
    ) {
        return res.status(400).json({ error: "Provide valid product IDs and quantities." });
    }

    const normalizedItems = items.map((item) => ({
        productId: Number(item.product_id),
        quantity: Number(item.quantity)
    }));
    const productIds = normalizedItems.map((item) => item.productId);

    if (new Set(productIds).size !== productIds.length) {
        return res.status(400).json({ error: "Each product can only appear once per order." });
    }

    const db = req.app.locals.pool;
    let client;

    try {
        client = await db.connect();
        await client.query("BEGIN");

        const productResult = await client.query(
            `SELECT p.id, p.name, p.wholesale_price, p.minimum_quantity,
                    p.stock_quantity, p.supplier_id, u.payment_methods,
                    u.payment_instructions, u.name AS supplier_name
             FROM products p
             JOIN users u ON u.id = p.supplier_id
             WHERE p.id = ANY($1::bigint[]) AND p.status = 'approved'
             FOR UPDATE OF p`,
            [productIds]
        );
        const productById = new Map(
            productResult.rows.map((product) => [String(product.id), product])
        );

        if (productById.size !== normalizedItems.length) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "One or more products are unavailable." });
        }

        let totalCents = 0;
        const orderLines = [];
        const supplierTotals = new Map();

        for (const item of normalizedItems) {
            const product = productById.get(String(item.productId));
            const methods = Array.isArray(product.payment_methods) ? product.payment_methods : [];
            if (!methods.length || !product.payment_instructions?.trim()) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    error: `${product.supplier_name} has not set up payment methods yet. Please contact the supplier before ordering.`
                });
            }
            const unitPriceCents = Math.round(Number(product.wholesale_price) * 100);
            const unitPrice = unitPriceCents / 100;

            if (
                item.quantity < Number(product.minimum_quantity) ||
                item.quantity > Number(product.stock_quantity)
            ) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    error: `${product.name} must be ordered in quantities from ${product.minimum_quantity} to ${product.stock_quantity}.`
                });
            }

            totalCents += unitPriceCents * item.quantity;
            const supplierId = Number(product.supplier_id);
            orderLines.push({ ...item, unitPrice, supplierId });
            const supplierTotal = supplierTotals.get(supplierId);
            if (supplierTotal) {
                supplierTotal.amountCents += unitPriceCents * item.quantity;
            } else {
                supplierTotals.set(supplierId, {
                    amountCents: unitPriceCents * item.quantity,
                    paymentMethods: methods,
                    paymentInstructions: product.payment_instructions
                });
            }
        }

        if (
            !Number.isSafeInteger(totalCents) ||
            totalCents < 100 ||
            totalCents > MAX_ORDER_TOTAL_CENTS
        ) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                error: "The order total must be between KSh 1 and KSh 9,999,999,999.99."
            });
        }

        const orderResult = await client.query(
            `INSERT INTO orders (buyer_id, total_amount)
             VALUES ($1, $2)
             RETURNING id, total_amount, status, payment_status, created_at`,
            [req.session.user.id, totalCents / 100]
        );
        const order = orderResult.rows[0];

        for (const [supplierId, supplierPayment] of supplierTotals) {
            await client.query(
                `INSERT INTO supplier_order_payments
                    (order_id, supplier_id, amount, payment_methods, payment_instructions)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    order.id,
                    supplierId,
                    supplierPayment.amountCents / 100,
                    supplierPayment.paymentMethods,
                    supplierPayment.paymentInstructions
                ]
            );
        }

        for (const item of orderLines) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
                 VALUES ($1, $2, $3, $4)`,
                [order.id, item.productId, item.quantity, item.unitPrice]
            );
            await client.query(
                `UPDATE products SET stock_quantity = stock_quantity - $1
                 WHERE id = $2`,
                [item.quantity, item.productId]
            );
        }

        await client.query("COMMIT");
        res.status(201).json({
            order: {
                ...order,
                items: orderLines.map((item) => ({
                    product_id: item.productId,
                    quantity: item.quantity,
                    unit_price: item.unitPrice
                }))
            }
        });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        next(error);
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
