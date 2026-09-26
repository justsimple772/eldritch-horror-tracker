# Eldritch room relay

Cloudflare Durable Object relay for hostless shared rooms.

- One Durable Object per room code
- Hibernatable WebSockets
- Server-side seat claims and room snapshots
- Automatic deletion after 24 hours of inactivity

Local development:

```powershell
npx wrangler dev --local --port 8787
```

The tracker can use the local relay with `?relay=local`.
