# CF Race

Copy these files into your repository and push to Render. Start command: `npm start`.

Keep your existing Clerk, Codeforces and Supabase environment variables.
Set `ADMIN_CLERK_USER_ID` to your admin account's `user_...` ID from Clerk.
`SUPABASE_KEY` must be a server secret/service-role key, never a client key.

Uses your existing Supabase `public.kv` table (`key text primary key`, `value jsonb`).
Fresh app storage initializes automatically. Existing app state is preserved.
Database errors stop loading rather than replacing data with an empty state.
No local JSON import or migration step is included.

Admin access: sign in on the home page, then open `/admin`. Other users get 404.
Public finished rooms and code are under `/archive` after the paste window closes.
