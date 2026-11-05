# Legacy M-Pesa STK setup

New TradeCircle orders use supplier-configured payment methods. A supplier can
list M-Pesa, bank transfer, card, cash, or another method and provide payment
instructions. Buyers pay the supplier directly, report the method used, and the
supplier confirms receipt. New orders do not use the platform's Daraja STK Push,
and do not require Daraja credentials.

The Daraja endpoint remains available only for legacy orders created before
supplier payment records existed. Do not configure it for new supplier orders.

## Sandbox

1. Create a Daraja developer account and a sandbox app with the Lipa Na M-Pesa
   Online product enabled. Get its consumer key and consumer secret, and use the
   shortcode and passkey provided by Daraja for sandbox testing.
2. Add these values to `Backend/.env` without removing the database or session
   settings already there:

   ```dotenv
   MPESA_ENV=sandbox
   MPESA_CONSUMER_KEY=your_sandbox_consumer_key
   MPESA_CONSUMER_SECRET=your_sandbox_consumer_secret
   MPESA_SHORTCODE=your_sandbox_shortcode
   MPESA_PASSKEY=your_sandbox_passkey
   MPESA_TRANSACTION_TYPE=CustomerPayBillOnline
   MPESA_CALLBACK_URL=https://your-public-host/api/payments/callback
   ```

   Use `CustomerBuyGoodsOnline` for an M-Pesa Till; use
   `CustomerPayBillOnline` for a PayBill. If omitted, the transaction type
   defaults to `CustomerPayBillOnline`.
3. Safaricom must be able to reach the callback URL over public HTTPS. For local
   development, expose port `3002` with a secure tunnel and set
   `MPESA_CALLBACK_URL` to that tunnel's HTTPS URL ending in
   `/api/payments/callback`. A localhost URL cannot receive Daraja callbacks.
4. Ensure the PostgreSQL database has been initialized with
   `database/schema.sql`, then restart the backend after changing `.env`.
   Retry only a pre-migration order that has no supplier payment record; new
   orders are not eligible for the legacy STK flow.

The legacy checkout route returns `503` until all four Daraja credentials
(`MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, and
`MPESA_PASSKEY`) are populated. Do not use placeholder values; obtain credentials
from your Daraja app and keep them only in the local, ignored `.env` file.

## Production

If you intentionally need the legacy endpoint, use production credentials and
shortcode/passkey issued for your approved Safaricom merchant account, set
`MPESA_ENV=production`, and use a stable public HTTPS callback URL. Do not switch
to production until Safaricom has enabled your merchant account and you have
tested the end-to-end callback.

Never commit `.env` or share consumer secrets/passkeys. M-Pesa accepts whole
Kenyan shillings for this checkout, with a current per-order limit of KSh 150,000.
