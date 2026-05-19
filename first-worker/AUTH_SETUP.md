# Auth Secret Setup (Step 1)

This worker expects a Supabase JWT secret at runtime:

- `SUPABASE_JWT_SECRET`

## Local development

Use `.dev.vars` (already ignored by git):

```env
SUPABASE_JWT_SECRET=your_actual_secret_here
RESEND_API_KEY=your_actual_key_here
```

## Cloudflare environments (staging/production)

Set secrets with Wrangler (run from `first-worker/`):

```bash
npx wrangler secret put SUPABASE_JWT_SECRET
npx wrangler secret put RESEND_API_KEY
```

Wrangler will prompt for each secret value and store it securely for the worker.

## Verify quickly

You can confirm secret names exist in your deployed worker with:

```bash
npx wrangler secret list
```

Do not commit real secret values to source control.

## Protected API routes (step 3)

Login and signup stay in the mobile app via `@supabase/supabase-js`. After sign-in, send the Supabase **access token** on every protected Worker request:

```http
Authorization: Bearer <session.access_token>
```

| Route | Auth |
|-------|------|
| `GET /` | Public (health) |
| `GET /auth/me` | Bearer required |
| `GET /users/:id` | Bearer required |
| `GET/POST /messages/*` | Bearer required |
| `GET /chat/:roomId` | Bearer required |
| `GET/PUT /files/*` | Bearer required |

`POST /messages` body: `{ "roomId", "text" }` only. The user id comes from the verified JWT (`sub`), not from the client body.

### Frontend example (Expo)

```ts
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;
if (!token) throw new Error("Not signed in");

await fetch(`${WORKER_URL}/messages/room-1`, {
  headers: { Authorization: `Bearer ${token}` },
});
```
