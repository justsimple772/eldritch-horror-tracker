# Shared-room lifecycle simulation

Tested on 2026-11-08 against production-source commit `9f0a5d0`, then against
the fixes in this branch. No production room was used.

## Results

Before the fixes, 3 of the original 9 server scenarios passed. Reproduced:

- All eight simultaneous claims on an empty seat received approval before any snapshot.
- A viewer's departure carrying stale seat numbers could delete another player's seat.
- An old socket closing could remove a replacement socket's participant.
- Temporary network disconnection immediately removed the participant.
- A snapshot arriving after an explicit departure could resurrect the participant.
- Snapshots without a successful claim, including an invalid seat, could enter the board.

After the fixes, all 10 server scenarios pass, including persisted room restoration.
The stress case runs 100 rounds of eight concurrent participant updates plus
100 explicit departures and rejoins, checking every seat's owner after each round.

The Chromium lifecycle test uses eight participant pages and one viewer page.
It passes 160 participant updates, 8 -> 6 -> 8 population changes, separate tab
identities, immediate leave/rejoin, dropped connection/reconnect, rejection of
stale socket state, absence of an ACK resend loop, and all participants leaving.
The separate two-page dice test also passes active-investigator assignment,
real dice UI -> viewer overlay -> stored history, and clearing a closed result.

## Behavior and limits

Explicit leave releases a seat immediately. A network disconnection reserves
it for 90 seconds, allowing the same tab to reconnect; after that it is released.
No system can instantly distinguish a temporary outage from an abandoned device.

These tests run the repository's actual Room class with simulated storage,
socket attachments, and time. Chromium runs the actual page code and routes
WebSocket messages to that Room class. Cloudflare's event scheduler, network
infrastructure, and real iPhone background suspension are not emulated.
Passing these scenarios is evidence for those cases, not a guarantee of no errors.

## Release requirement

The worker changes require a separate Cloudflare Workers deployment; a Pages
deployment does not deploy `worker/src/index.js`. Deploy the worker first, then
the client update. Update and reopen/rejoin all clients to establish the new
socket ownership records. Existing game data in localStorage is unchanged.

This workspace has GitHub access but no configured Cloudflare deployment
credentials. The branch is prepared for deployment review; no production release
of these lifecycle fixes has been claimed.
