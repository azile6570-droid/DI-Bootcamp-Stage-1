# TradeCircle Code Map

Use this guide to find the file that owns a feature before changing it.

## Frontend

- `Frontend/Public/index.html` — Page structure, forms, dashboard panels, IDs, and navigation buttons.
- `Frontend/Public/style.css` — Layout, colors, responsive behavior, and visual states.
- `Frontend/Public/script.js` — Browser behavior, API calls, login routing, dashboard navigation, rendering, and event handlers. New orders show each supplier's payment methods and instructions; buyers report payments and suppliers confirm receipt.

## Backend

- `Backend/server.js` — Express setup, middleware, API registration, static frontend hosting, and server startup.
- `Backend/routes/auth.js` — Registration, sign-in, session creation, logout, and account actions.
- `Backend/routes/admin.js` — Admin-only APIs for accounts, products, supplier verification, orders, payments, group deals, and activity.
- `Backend/routes/sales.js` — Sales-employee APIs for buyer accounts, real order/payment history, private follow-ups, RFQs, and internal quote tracking.
- `Backend/routes/products.js` — Public product listings and supplier product management.
- `Backend/routes/orders.js` — Buyer orders, supplier fulfillment and payment settings, per-supplier order payments, buyer payment reports, and supplier receipt confirmation.
- `Backend/routes/deals.js` — Group-buy requests, deals, participants, and joining a deal.
- `Backend/routes/payments.js` — Legacy M-Pesa checkout and callback verification for older orders.
- `Backend/middleware/auth.js` — Signed-in, role, and terms-acceptance checks.
- `Backend/database/schema.sql` — PostgreSQL tables, columns, constraints, and indexes.
- `Backend/database/migrations/001_sales_workspace.sql` — Repeatable migration that adds the sales role, follow-up/RFQ/quote tables, and admin access audit records.
- `Backend/database/migrations/002_supplier_payments.sql` — Repeatable migration for supplier payment preferences and per-supplier order payment tracking.

## Common Changes

- Change dashboard text or add a panel: update `Frontend/Public/index.html`, then wire rendering and navigation in `Frontend/Public/script.js`.
- Change dashboard appearance: update `Frontend/Public/style.css`.
- Change admin data or access: update the matching handler in `Backend/routes/admin.js`; keep it behind the admin role guard.
- Change sign-in or account roles: check `Backend/routes/auth.js`, `Backend/middleware/auth.js`, and the corresponding frontend flow in `Frontend/Public/script.js`.
- Change product, order, deal, or payment behavior: use the matching backend route file above, then update the frontend that calls it.
- Suppliers configure accepted payment methods and instructions in their dashboard. Buyers pay suppliers directly, report the method used, and suppliers confirm receipt before fulfillment can proceed.
- Add or change persisted fields: update `Backend/database/schema.sql` and the API queries that read or write those fields.
- Apply the sales workspace migration from `TradeCircle/Backend` with `npm run migrate:sales-workspace` before starting or restarting the backend. An admin grants sales access from a buyer account's profile in the account directory.
- Apply the supplier payment migration from `TradeCircle/Backend` with `npm run migrate:supplier-payments` before starting or restarting the backend.
- Sales quotes and RFQs are internal records only; quote sharing is manually marked and no customer or supplier message is sent.

## Run Locally

From `TradeCircle/Backend`, run `npm.cmd start`. The app serves the frontend and API at `http://localhost:3001` unless `PORT` is set.

For backend errors, check the terminal running the server. For frontend errors, check the browser developer console. Never put passwords or API secrets in this guide or source files; keep them in the backend environment file.
