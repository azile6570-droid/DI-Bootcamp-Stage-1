-- TradeCircle PostgreSQL schema.

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20),
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'buyer'
        CHECK (role IN ('buyer', 'supplier', 'buyer_supplier', 'admin', 'sales')),
    terms_accepted_version VARCHAR(20),
    terms_accepted_at TIMESTAMPTZ,
    supplier_application_status VARCHAR(20) NOT NULL DEFAULT 'none'
        CHECK (supplier_application_status IN ('none', 'pending', 'approved', 'rejected')),
    business_name VARCHAR(180),
    supplier_application_note VARCHAR(1000),
    business_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS terms_accepted_version VARCHAR(20),
    ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS supplier_verified BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS supplier_application_status VARCHAR(20) NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS business_name VARCHAR(180),
    ADD COLUMN IF NOT EXISTS supplier_application_note VARCHAR(1000),
    ADD COLUMN IF NOT EXISTS business_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS payment_methods TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS payment_instructions TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_supplier_application_status_check;

ALTER TABLE users
    ADD CONSTRAINT users_supplier_application_status_check
        CHECK (supplier_application_status IN ('none', 'pending', 'approved', 'rejected'));

UPDATE users
SET supplier_application_status = CASE
        WHEN supplier_verified THEN 'approved'
        ELSE 'pending'
    END,
    role = CASE
        WHEN supplier_verified THEN 'buyer_supplier'
        ELSE 'buyer'
    END
WHERE role IN ('supplier', 'buyer_supplier')
  AND supplier_application_status = 'none';

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
    ADD CONSTRAINT users_role_check
        CHECK (role IN ('buyer', 'supplier', 'buyer_supplier', 'admin', 'sales'));

CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    supplier_id BIGINT NOT NULL REFERENCES users(id),
    name VARCHAR(180) NOT NULL,
    description TEXT DEFAULT '',
    category VARCHAR(100) NOT NULL,
    image_url TEXT,
    wholesale_price NUMERIC(12, 2) NOT NULL CHECK (wholesale_price >= 0),
    unit_label VARCHAR(40) NOT NULL DEFAULT 'unit',
    minimum_quantity INTEGER NOT NULL DEFAULT 1
        CHECK (minimum_quantity > 0),
    stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS unit_label VARCHAR(40) NOT NULL DEFAULT 'unit';

CREATE TABLE IF NOT EXISTS wishlists (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS product_reviews (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_text VARCHAR(1000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (product_id, buyer_id)
);

CREATE TABLE IF NOT EXISTS group_deals (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    target_quantity INTEGER NOT NULL CHECK (target_quantity > 0),
    current_quantity INTEGER NOT NULL DEFAULT 0 CHECK (current_quantity >= 0),
    discounted_price NUMERIC(12, 2) NOT NULL CHECK (discounted_price >= 0),
    ends_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_deal_requests (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    supplier_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_quantity INTEGER NOT NULL CHECK (target_quantity > 0),
    discounted_price NUMERIC(12, 2) NOT NULL CHECK (discounted_price >= 0),
    ends_at TIMESTAMPTZ NOT NULL,
    supplier_note VARCHAR(1000) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    group_deal_id BIGINT REFERENCES group_deals(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_deal_requests_pending_product
    ON group_deal_requests(product_id)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS group_deal_participants (
    id BIGSERIAL PRIMARY KEY,
    deal_id BIGINT NOT NULL REFERENCES group_deals(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (deal_id, user_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    buyer_id BIGINT NOT NULL REFERENCES users(id),
    total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'confirmed', 'processing',
            'shipped', 'delivered', 'cancelled'
        )),
    payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
        CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id),
    group_deal_id BIGINT REFERENCES group_deals(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    fulfillment_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (fulfillment_status IN (
            'pending', 'confirmed', 'processing', 'shipped',
            'delivered', 'cancelled'
        ))
);

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS group_deal_id BIGINT REFERENCES group_deals(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS fulfillment_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (fulfillment_status IN (
            'pending', 'confirmed', 'processing', 'shipped',
            'delivered', 'cancelled'
        ));

ALTER TABLE group_deal_participants
    ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id),
    provider VARCHAR(30) NOT NULL DEFAULT 'mpesa',
    merchant_request_id TEXT,
    checkout_request_id TEXT UNIQUE,
    receipt_number TEXT,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    phone VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_order_payments (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    supplier_id BIGINT NOT NULL REFERENCES users(id),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    payment_methods TEXT[] NOT NULL
        CHECK (
            cardinality(payment_methods) > 0
            AND payment_methods <@ ARRAY['mpesa', 'bank_transfer', 'card', 'cash', 'other']::TEXT[]
        ),
    payment_instructions TEXT NOT NULL DEFAULT '',
    selected_method VARCHAR(30)
        CHECK (selected_method IS NULL OR selected_method IN ('mpesa', 'bank_transfer', 'card', 'cash', 'other')),
    status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
        CHECK (status IN ('unpaid', 'reported', 'paid')),
    reported_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_id, supplier_id)
);

-- Stores encrypted message payloads; the server must not receive plaintext
-- message content or users' private encryption keys.
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    sender_id BIGINT NOT NULL REFERENCES users(id),
    recipient_id BIGINT NOT NULL REFERENCES users(id),
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE INDEX IF NOT EXISTS idx_products_status_category
    ON products(status, category);

CREATE INDEX IF NOT EXISTS idx_orders_buyer
    ON orders(buyer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_participants
    ON messages(sender_id, recipient_id, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created
    ON admin_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_followups_owner_status_due
    ON sales_followups(sales_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_sales_rfqs_owner_status
    ON sales_rfqs(sales_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_quotes_rfq
    ON sales_quotes(rfq_id, created_at DESC);
