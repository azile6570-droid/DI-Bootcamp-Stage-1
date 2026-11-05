const { CURRENT_TERMS_VERSION } = require("../config/terms");

async function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: "Please sign in first." });
    }

    try {
        const result = await req.app.locals.pool.query(
            `SELECT role, supplier_verified, supplier_application_status
             FROM users
             WHERE id = $1 AND deleted_at IS NULL`,
            [req.session.user.id]
        );
        if (!result.rowCount) {
            return req.session.destroy((error) => {
                if (error) return next(error);
                res.clearCookie("tradecircle.sid", {
                    httpOnly: true,
                    sameSite: "lax",
                    secure: process.env.NODE_ENV === "production"
                });
                res.status(401).json({ error: "This account is no longer available." });
            });
        }
        Object.assign(req.session.user, result.rows[0]);
        next();
    } catch (error) {
        next(error);
    }
}

async function requireTermsAccepted(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: "Please sign in first." });
    }

    try {
        const result = await req.app.locals.pool.query(
            "SELECT terms_accepted_version FROM users WHERE id = $1 AND deleted_at IS NULL",
            [req.session.user.id]
        );
        if (!result.rows[0]) {
            return res.status(401).json({ error: "Please sign in first." });
        }
        if (result.rows[0].terms_accepted_version !== CURRENT_TERMS_VERSION) {
            return res.status(428).json({
                error: "Please accept the current Terms and Conditions to continue.",
                terms_required: true
            });
        }
        next();
    } catch (error) {
        next(error);
    }
}

function requireRole(...roles) {
    return async (req, res, next) => {
        if (!req.session.user) {
            return res.status(401).json({ error: "Please sign in first." });
        }

        try {
            const result = await req.app.locals.pool.query(
                `SELECT role, terms_accepted_version, supplier_verified,
                        supplier_application_status
                 FROM users
                 WHERE id = $1 AND deleted_at IS NULL`,
                [req.session.user.id]
            );
            if (!result.rows[0]) {
                return res.status(401).json({ error: "Please sign in first." });
            }
            if (result.rows[0].terms_accepted_version !== CURRENT_TERMS_VERSION) {
                return res.status(428).json({
                    error: "Please accept the current Terms and Conditions to continue.",
                    terms_required: true
                });
            }

            const userRole = result.rows[0].role;
            req.session.user.role = userRole;
            req.session.user.supplier_verified = result.rows[0].supplier_verified;
            req.session.user.supplier_application_status =
                result.rows[0].supplier_application_status;
            const canBuy = ["buyer", "supplier", "buyer_supplier"].includes(userRole);
            const canSell = result.rows[0].supplier_verified === true &&
                ["supplier", "buyer_supplier"].includes(userRole);
            const hasRole = roles.some((role) => {
                if (role === "admin") return userRole === "admin";
                if (role === "buyer") return canBuy;
                if (role === "supplier") return canSell;
                return role === userRole;
            });

            if (!hasRole) {
                return res.status(403).json({ error: "You do not have permission." });
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = { requireAuth, requireRole, requireTermsAccepted };
