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

Seat lifecycle:

- Claim reserves the seat before acknowledging it, including before the first snapshot.
- Snapshots and explicit departures must belong to the socket session that owns the seat.
- Explicit departure frees seats immediately. Network loss reserves them for 90 seconds;
  reconnecting with the same tab identity reclaims them. An alarm frees abandoned seats.
- A snapshot uses `snapAck`; only a seat claim uses `ok`, including for older clients.

Validation from the repository root:

```sh
node tests/room-lifecycle.cjs
# With Playwright and Chromium installed:
node tests/browser-lifecycle.cjs
node tests/room-sync.cjs
```

Set `CHROMIUM_PATH` to use a system Chromium executable.
The lifecycle tests exercise the actual Room class with simulated storage/sockets
and a controllable clock. Browser tests route real app messages to the same Room
class; they do not contact production rooms. They do not emulate Cloudflare's
hibernation scheduler or iOS network suspension.

Deploy the relay from this directory with `npx wrangler deploy` after authenticating
to its Cloudflare account. Deploy the relay before releasing the accompanying
client update. Updating the Pages site alone does not deploy this worker.
