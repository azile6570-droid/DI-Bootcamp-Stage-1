ALTER TABLE users
    ADD COLUMN IF NOT EXISTS payment_methods TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS payment_instructions TEXT NOT NULL DEFAULT '';

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

ALTER TABLE supplier_order_payments
    DROP CONSTRAINT IF EXISTS supplier_order_payments_payment_methods_check,
    DROP CONSTRAINT IF EXISTS supplier_order_payments_selected_method_check;

ALTER TABLE supplier_order_payments
    ADD CONSTRAINT supplier_order_payments_payment_methods_check
        CHECK (
            cardinality(payment_methods) > 0
            AND payment_methods <@ ARRAY['mpesa', 'bank_transfer', 'card', 'cash', 'other']::TEXT[]
        ),
    ADD CONSTRAINT supplier_order_payments_selected_method_check
        CHECK (selected_method IS NULL OR selected_method IN ('mpesa', 'bank_transfer', 'card', 'cash', 'other'));
