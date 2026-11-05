ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
    ADD CONSTRAINT users_role_check
        CHECK (role IN ('buyer', 'supplier', 'buyer_supplier', 'admin', 'sales'));

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_id BIGINT NOT NULL REFERENCES users(id),
    action VARCHAR(80) NOT NULL,
    target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_followups (
    id BIGSERIAL PRIMARY KEY,
    sales_id BIGINT NOT NULL REFERENCES users(id),
    buyer_id BIGINT NOT NULL REFERENCES users(id),
    title VARCHAR(180) NOT NULL,
    notes VARCHAR(2000) NOT NULL DEFAULT '',
    due_at DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'completed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_rfqs (
    id BIGSERIAL PRIMARY KEY,
    sales_id BIGINT NOT NULL REFERENCES users(id),
    buyer_id BIGINT NOT NULL REFERENCES users(id),
    requirements TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    target_price NUMERIC(12, 2) CHECK (target_price IS NULL OR target_price >= 0),
    needed_by DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'quoted', 'won', 'lost', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_quotes (
    id BIGSERIAL PRIMARY KEY,
    rfq_id BIGINT NOT NULL REFERENCES sales_rfqs(id) ON DELETE CASCADE,
    sales_id BIGINT NOT NULL REFERENCES users(id),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    valid_until DATE,
    terms VARCHAR(2000) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'shared', 'accepted', 'declined', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created
    ON admin_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_followups_owner_status_due
    ON sales_followups(sales_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_sales_rfqs_owner_status
    ON sales_rfqs(sales_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_quotes_rfq
    ON sales_quotes(rfq_id, created_at DESC);
