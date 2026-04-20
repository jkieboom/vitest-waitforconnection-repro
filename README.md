# Vitest waitForConnection reconnect repro

This scratch project reproduces the Vitest browser-client reconnect bug where an
existing `waitForConnection()` waiter can stay attached to the first websocket
attempt even after Vitest replaces `client.ws` during reconnect.

The repro uses a local reverse proxy in front of the Vitest server. In the
broken case, that proxy holds only the first tester websocket upgrade open long
enough for the browser-side waiter to attach to the initial `openPromise`, then
drops the socket before the handshake completes. The browser reconnects
naturally, but the original waiter remains stuck on the stale promise.

## Run

From this directory:

```sh
npm install
npx playwright install chromium
node ./run-repro.mjs
```

Expected behavior:

- the `control` case exits successfully
- the `broken` case logs that the first tester websocket was dropped and stays running past the harness timeout

Unlike the earlier page-level shim, this keeps the native browser `WebSocket`
implementation intact and introduces the failure at the transport layer instead.
