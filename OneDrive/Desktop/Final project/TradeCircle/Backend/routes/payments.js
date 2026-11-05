const router = require("express").Router();
const axios = require("axios");
const { requireAuth, requireRole } = require("../middleware/auth");

function mpesaBaseUrl() {
    return process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";
}

function getMpesaConfig() {
    const config = {
        shortcode: process.env.MPESA_SHORTCODE,
        passkey: process.env.MPESA_PASSKEY,
        callbackUrl: process.env.MPESA_CALLBACK_URL,
        transactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline"
    };
    let callbackUrl;
    try {
        callbackUrl = new URL(config.callbackUrl);
    } catch {
        return null;
    }

    if (
        !process.env.MPESA_CONSUMER_KEY ||
        !process.env.MPESA_CONSUMER_SECRET ||
        !config.shortcode ||
        !config.passkey ||
        callbackUrl.protocol !== "https:" ||
        !callbackUrl.hostname ||
        !["CustomerPayBillOnline", "CustomerBuyGoodsOnline"].includes(config.transactionType) ||
        !["sandbox", "production", undefined].includes(process.env.MPESA_ENV)
    ) {
        return null;
    }

    return config;
}

function formatPhone(value) {
    let phone = String(value || "").replace(/[\s+-]/g, "");
    if (phone.startsWith("0")) phone = "254" + phone.slice(1);
    if (phone.startsWith("7") || phone.startsWith("1")) phone = "254" + phone;
    return /^254[71]\d{8}$/.test(phone) ? phone : null;
}

async function getAccessToken() {
    const response = await axios.get(
        `${mpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
        {
            auth: {
                username: process.env.MPESA_CONSUMER_KEY,
                password: process.env.MPESA_CONSUMER_SECRET
            },
            timeout: 15000
        }
    );

    if (typeof response.data?.access_token !== "string") {
        throw new Error("Safaricom did not return an access token.");
    }
    return response.data.access_token;
}

function getTimestamp() {
    const date = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return date.getUTCFullYear().toString()
        + String(date.getUTCMonth() + 1).padStart(2, "0")
        + String(date.getUTCDate()).padStart(2, "0")
        + String(date.getUTCHours()).padStart(2, "0")
        + String(date.getUTCMinutes()).padStart(2, "0")
        + String(date.getUTCSeconds()).padStart(2, "0");
}

function getPassword(shortcode, passkey, timestamp) {
    return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

async function queryStkPayment(checkoutRequestId, config, token) {
    const timestamp = getTimestamp();
    const response = await axios.post(
        `${mpesaBaseUrl()}/mpesa/stkpushquery/v1/query`,
        {
            BusinessShortCode: config.shortcode,
            Password: getPassword(config.shortcode, config.passkey, timestamp),
            Timestamp: timestamp,
            CheckoutRequestID: checkoutRequestId
        },
        {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15000
        }
    );
    return response.data;
}

async function applyPaymentResult(db, checkoutRequestId, status, receiptNumber = null) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const paymentResult = await client.query(
            `SELECT id, order_id, status
             FROM payments
             WHERE checkout_request_id = $1
             FOR UPDATE`,
            [checkoutRequestId]
        );
        const payment = paymentResult.rows[0];
        if (!payment || payment.status !== "pending") {
            await client.query("COMMIT");
            return false;
        }

        await client.query(
            `UPDATE payments
             SET status = $1, receipt_number = COALESCE($2, receipt_number)
             WHERE id = $3`,
            [status, receiptNumber, payment.id]
        );

        if (status === "paid") {
            await client.query(
                `UPDATE orders SET payment_status = 'paid'
                 WHERE id = $1 AND payment_status <> 'paid'`,
                [payment.order_id]
            );
        } else {
            await client.query(
                `UPDATE orders
                 SET payment_status = 'failed'
                 WHERE id = $1
                   AND payment_status = 'pending'
                   AND NOT EXISTS (
                       SELECT 1 FROM payments newer
                       WHERE newer.order_id = $1 AND newer.id > $2
                         AND newer.status = 'pending'
                   )`,
                [payment.order_id, payment.id]
            );
        }

        await client.query("COMMIT");
        return true;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

router.post("/stk-push", requireAuth, requireRole("buyer"), async (req, res, next) => {
    try {
        const phone = formatPhone(req.body.phone);
        const orderId = Number(req.body.order_id);
        if (!phone || !Number.isSafeInteger(orderId) || orderId < 1) {
            return res.status(400).json({
                error: "Provide a valid Kenyan M-Pesa phone number and order ID."
            });
        }

        const config = getMpesaConfig();
        if (!config) {
            return res.status(503).json({
                error: "M-Pesa checkout is not configured. Set the Daraja credentials and public HTTPS callback URL."
            });
        }

        const db = req.app.locals.pool;
        const orderResult = await db.query(
            `SELECT id, total_amount, payment_status, status
             FROM orders WHERE id = $1 AND buyer_id = $2`,
            [orderId, req.session.user.id]
        );
        const order = orderResult.rows[0];
        if (!order) return res.status(404).json({ error: "Order not found." });
        if (order.payment_status === "paid") {
            return res.status(409).json({ error: "This order is already paid." });
        }
        if (order.status === "cancelled") {
            return res.status(409).json({ error: "This order was cancelled and cannot be paid." });
        }

        const supplierPaymentResult = await db.query(
            `SELECT 1 FROM supplier_order_payments WHERE order_id = $1 LIMIT 1`,
            [order.id]
        );
        if (supplierPaymentResult.rowCount) {
            return res.status(409).json({
                error: "This order is paid directly to its suppliers. Use the payment methods in your order details."
            });
        }

        const latestPaymentResult = await db.query(
            `SELECT checkout_request_id, status, phone
             FROM payments
             WHERE order_id = $1
             ORDER BY id DESC
             LIMIT 1`,
            [order.id]
        );
        const latestPayment = latestPaymentResult.rows[0];
        if (latestPayment?.status === "pending") {
            return res.json({
                message: `A payment request is already in progress for a phone ending in ${String(latestPayment.phone).slice(-3)}. Check that phone.`,
                checkout_request_id: latestPayment.checkout_request_id
            });
        }

        const amount = Number(order.total_amount);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 150000) {
            return res.status(400).json({
                error: "M-Pesa checkout requires an order total from KSh 1 to KSh 150,000 in whole shillings."
            });
        }

        const token = await getAccessToken();
        const timestamp = getTimestamp();
        const response = await axios.post(
            `${mpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
            {
                BusinessShortCode: config.shortcode,
                Password: getPassword(config.shortcode, config.passkey, timestamp),
                Timestamp: timestamp,
                TransactionType: config.transactionType,
                Amount: amount,
                PartyA: phone,
                PartyB: config.shortcode,
                PhoneNumber: phone,
                CallBackURL: config.callbackUrl,
                AccountReference: `TC-${order.id}`,
                TransactionDesc: `TradeCircle order ${order.id}`
            },
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000
            }
        );
        const data = response.data;
        if (data.ResponseCode !== "0" || !data.CheckoutRequestID) {
            return res.status(502).json({
                error: data.ResponseDescription || "M-Pesa did not accept the request."
            });
        }

        await db.query(
            `INSERT INTO payments
                (order_id, merchant_request_id, checkout_request_id, amount, phone, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')
             ON CONFLICT (checkout_request_id) DO NOTHING`,
            [
                order.id,
                data.MerchantRequestID || null,
                data.CheckoutRequestID,
                amount,
                phone
            ]
        );
        await db.query(
            `UPDATE orders SET payment_status = 'pending' WHERE id = $1`,
            [order.id]
        );

        res.json({
            message: "M-Pesa prompt sent. Enter your M-Pesa PIN on your phone.",
            checkout_request_id: data.CheckoutRequestID
        });
    } catch (error) {
        console.error(
            "M-Pesa request failed:",
            error.response?.status || error.code || error.message
        );
        next(error);
    }
});

router.get(
    "/status/:checkoutRequestId",
    requireAuth,
    requireRole("buyer"),
    async (req, res, next) => {
        try {
            const result = await req.app.locals.pool.query(
                `SELECT p.status, p.receipt_number, p.amount, p.created_at,
                        o.id AS order_id, o.payment_status
                 FROM payments p
                 JOIN orders o ON o.id = p.order_id
                 WHERE p.checkout_request_id = $1 AND o.buyer_id = $2`,
                [req.params.checkoutRequestId, req.session.user.id]
            );
            if (!result.rows[0]) {
                return res.status(404).json({ error: "Payment request not found." });
            }
            res.json({ payment: result.rows[0] });
        } catch (error) {
            next(error);
        }
    }
);

router.post("/callback", async (req, res) => {
    try {
        const callback = req.body?.Body?.stkCallback;
        const checkoutRequestId = callback?.CheckoutRequestID;
        if (
            typeof checkoutRequestId !== "string" ||
            checkoutRequestId.length < 1 ||
            checkoutRequestId.length > 128 ||
            !["string", "number"].includes(typeof callback.ResultCode) ||
            !Number.isSafeInteger(Number(callback.ResultCode))
        ) {
            return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid callback" });
        }

        const db = req.app.locals.pool;
        const config = getMpesaConfig();
        if (!config) {
            console.error("M-Pesa callback received without complete Daraja configuration.");
            return res.status(503).json({ ResultCode: 1, ResultDesc: "Payment verification unavailable" });
        }

        const pendingResult = await db.query(
            `SELECT amount FROM payments
             WHERE checkout_request_id = $1 AND status = 'pending'`,
            [checkoutRequestId]
        );
        const pendingPayment = pendingResult.rows[0];
        if (!pendingPayment) {
            return res.json({ ResultCode: 0, ResultDesc: "Callback received" });
        }

        const token = await getAccessToken();
        const verification = await queryStkPayment(checkoutRequestId, config, token);
        if (
            verification.CheckoutRequestID !== checkoutRequestId ||
            verification.ResponseCode !== "0" ||
            !Number.isSafeInteger(Number(verification.ResultCode))
        ) {
            console.warn("M-Pesa STK query has not confirmed a final payment status.");
            return res.json({ ResultCode: 0, ResultDesc: "Payment verification pending" });
        }

        if (Number(verification.ResultCode) !== 0) {
            await applyPaymentResult(db, checkoutRequestId, "failed");
            return res.json({ ResultCode: 0, ResultDesc: "Payment failure verified" });
        }

        const metadataItems = callback.CallbackMetadata?.Item;
        const metadata = new Map(
            (Array.isArray(metadataItems) ? metadataItems : [])
                .filter((item) => item && typeof item.Name === "string")
                .map((item) => [item.Name, item.Value])
        );
        const amount = Number(metadata.get("Amount"));
        const receiptNumber = metadata.get("MpesaReceiptNumber");
        if (
            Number(callback.ResultCode) !== 0 ||
            !pendingPayment ||
            amount !== Number(pendingPayment.amount) ||
            typeof receiptNumber !== "string" ||
            !receiptNumber
        ) {
            console.error("M-Pesa success callback did not match a pending payment.");
            return res.json({ ResultCode: 0, ResultDesc: "Callback received" });
        }

        await applyPaymentResult(db, checkoutRequestId, "paid", receiptNumber);
        res.json({ ResultCode: 0, ResultDesc: "Payment verified" });
    } catch (error) {
        console.error(
            "M-Pesa callback processing failed:",
            error.response?.status || error.code || error.message
        );
        res.status(500).json({ ResultCode: 1, ResultDesc: "Callback processing failed" });
    }
});

module.exports = router;
