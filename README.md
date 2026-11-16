# Kinetic Grooves — Custom Storefront

A responsive React + Vite storefront with an Express API, SQLite catalogue/order ledger, password-protected Dev Mode, image uploads, COD toggle, and a FamGateway UPI adapter. Live payments and COD are **off by default**.

## What's included

- Dark editorial streetwear storefront based on the recovered Kinetic Grooves references.
- Local brand PNGs in `client/public/assets/`.
- Product catalogue with category filters, search, product details, size selection and cart.
- Checkout form with UPI (FamGateway) and COD options; each option is controlled by a server environment flag.
- Dev Mode login with product create/edit/delete, stock, status, size, pricing, image URL/upload, and order status management.
- Express backend with server-side price calculation, inventory checks, signed short-lived admin bearer tokens, upload validation, rate limiting and HMAC-SHA256 FamGateway webhook verification.
- SQLite storage for products and orders.

## Run locally

Requirements: Node.js 20+ and npm 10+.

```bash
cp .env.example .env
# Edit DEV_MODE_PASSWORD and SESSION_SECRET before running
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:4000`.

Click **DEV MODE** in the footer and sign in using `DEV_MODE_PASSWORD`. Add products, set stock, and change status to `active` before they can be purchased.

## Environment variable names

| Variable | Purpose |
|---|---|
| `PORT` | Express port; hosting providers often inject this automatically |
| `NODE_ENV` | `development` or `production` |
| `CLIENT_ORIGIN` | Exact storefront origin allowed by backend CORS; comma-separated if multiple |
| `STOREFRONT_URL` | Public storefront URL used as FamGateway redirect destination |
| `PUBLIC_BASE_URL` | Public HTTPS backend URL; used for webhook registration and redirects |
| `VITE_API_BASE_URL` | Public backend origin compiled into the frontend; blank for local Vite proxy |
| `DEV_MODE_PASSWORD` | Secret password used to unlock Dev Mode |
| `SESSION_SECRET` | Long random server-only key used to sign Dev Mode sessions |
| `FAMGATEWAY_ENABLED` | `false` until the merchant account and live integration are verified |
| `FAMGATEWAY_API_KEY` | FamGateway secret API key; backend only, never a `VITE_` variable |
| `COD_ENABLED` | `true` only after courier, COD settlement and RTO process are arranged |
| `DATABASE_PATH` | SQLite database file path |
| `UPLOAD_DIR` | Product image upload directory |

**Never put `FAMGATEWAY_API_KEY`, `DEV_MODE_PASSWORD`, or `SESSION_SECRET` in frontend variables or commit your real `.env`.** Only `VITE_API_BASE_URL` is intended for the browser.

Generate a session secret with `openssl rand -hex 32` or another secure random generator. Use a unique, long Dev Mode password. `.env` is gitignored.

## FamGateway setup

The adapter uses the published FamGateway REST endpoints:

- `POST https://famgateway.in/api/create-order` with `X-Api-Key` server-side.
- Hosted checkout URL returned by the gateway.
- Public `GET /api/checkout-status.php?order_id=...` for status polling.
- `POST /api/famgateway-webhook` with raw-body HMAC-SHA256 verification using the FamGateway API key as the signing secret.

After deploying the backend:

1. Confirm the merchant account holder is eligible to use FamGateway for the intended commercial activity. Verify the provider's current terms, limits, settlement route, fees, support and refund process.
2. Put the API key in backend environment variables as `FAMGATEWAY_API_KEY`.
3. Set `FAMGATEWAY_ENABLED=true` only after provider setup and testing.
4. Register `https://YOUR_BACKEND_DOMAIN/api/famgateway-webhook` in FamGateway webhook settings.
5. Set `PUBLIC_BASE_URL` to the backend HTTPS URL and `STOREFRONT_URL` to the storefront URL.
6. Test a small payment, webhook signature, duplicate callback handling, status polling and manual refund process before launch.

FamGateway's published docs describe non-custodial UPI settlement and manual refunds. A successful browser redirect is **not** treated as payment proof; the server relies on verified webhook/status data.

## Deploy layout

- Frontend: Netlify. Set `VITE_API_BASE_URL` to the backend HTTPS origin at build time.
- Backend: deploy the Express app to a Node host that supports persistent disk. Set `CLIENT_ORIGIN`, `STOREFRONT_URL`, `PUBLIC_BASE_URL`, secrets and storage paths there.
- Ensure `DATABASE_PATH` and `UPLOAD_DIR` point to persistent volumes. Ephemeral filesystems will lose product uploads and SQLite data on redeploy.

For local combined production hosting, run `npm run build` then start with `NODE_ENV=production npm start` (on Windows PowerShell: `$env:NODE_ENV="production"; npm start`) to serve `dist/` from Express. For the planned Netlify + separate backend deployment, build the frontend on Netlify and run Express separately.

## Important launch blockers

- The six seeded catalogue entries are draft concepts with zero stock. Activate products and enter real inventory from Dev Mode only after the supplier, final garment specs, prices, photos and stock are confirmed.
- Concept mockups are not proof of manufactured garments. Replace them with accurate product photography before taking orders.
- COD requires an agreed courier/fulfilment partner, COD collection/settlement, RTO charges and return handling. It is disabled by default.
- FamGateway eligibility, commercial terms and refunds must be verified before live payments. A parent/guardian or properly authorised adult should handle merchant-account ownership and legal/financial obligations where required; do not bypass age or identity requirements.
- SQLite and local uploads need persistent storage and backups in production. For higher order volume, migrate to managed PostgreSQL/object storage.
- Add final shipping, returns, privacy, terms, contact and legal business details before launch.

## Build check

```bash
npm run build
```
