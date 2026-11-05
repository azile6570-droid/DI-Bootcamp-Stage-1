const router = require("express").Router();
const { requireAuth, requireTermsAccepted } = require("../middleware/auth");

router.get("/:userId", requireAuth, requireTermsAccepted, async (req, res, next) => {
    try {
        const otherUserId = Number(req.params.userId);

        if (!Number.isSafeInteger(otherUserId) || otherUserId < 1) {
            return res.status(400).json({ error: "Invalid recipient." });
        }

        const result = await req.app.locals.pool.query(
            `SELECT id, sender_id, recipient_id, ciphertext, iv, created_at
             FROM messages
             WHERE (sender_id = $1 AND recipient_id = $2)
                OR (sender_id = $2 AND recipient_id = $1)
             ORDER BY created_at ASC
             LIMIT 500`,
            [req.session.user.id, otherUserId]
        );

        res.json({ messages: result.rows });
    } catch (error) {
        next(error);
    }
});

router.post("/", requireAuth, requireTermsAccepted, async (req, res, next) => {
    try {
        const senderId = req.session.user.id;
        const recipientId = Number(req.body.recipient_id);
        const { ciphertext, iv } = req.body;

        if (
            !Number.isSafeInteger(recipientId) ||
            recipientId < 1 ||
            recipientId === senderId ||
            typeof ciphertext !== "string" ||
            typeof iv !== "string" ||
            ciphertext.length < 1 ||
            ciphertext.length > 20000 ||
            iv.length > 100
        ) {
            return res.status(400).json({
                error: "Invalid encrypted message."
            });
        }

        const recipient = await req.app.locals.pool.query(
            "SELECT id FROM users WHERE id = $1",
            [recipientId]
        );

        if (!recipient.rowCount) {
            return res.status(404).json({ error: "Recipient not found." });
        }

        const result = await req.app.locals.pool.query(
            `INSERT INTO messages (sender_id, recipient_id, ciphertext, iv)
             VALUES ($1, $2, $3, $4)
             RETURNING id, sender_id, recipient_id, ciphertext, iv, created_at`,
            [senderId, recipientId, ciphertext, iv]
        );

        res.status(201).json({ message: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
