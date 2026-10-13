# DAII — T1 host-level proxy compatibility check: protocol for the host owner — 2026-10-14

**Status: NOT PERFORMED — requires host access that the engineering team does not have.** The T1 change updates `proxy-addr` (2.0.7 → 2.0.8) to clear a critical advisory (IP spoofing through IPv4-mapped IPv6 addresses in the *trust proxy* subnet logic). DEC-20/D-01 asked that the host be checked so the update is shown compatible with how the application is actually deployed. Responsible role: `ENVIRONMENT_OWNER` (host access) with the `SECURITY_AND_DEPENDENCY_OWNER`.

## 1. What the code says (re-verified at `dbb0a3e`, read-only)
The application source contains **no** `trust proxy` setting, no use of `X-Forwarded-*` headers, and no use of `req.ip`, `req.ips` or the socket address (searches of `backend/src` return nothing). Express therefore keeps its default (`trust proxy` off): `proxy-addr` is only consulted when `trust proxy` is configured, so the advisory is not reachable through application code as written. One related behaviour: the global rate limiter (`ThrottlerGuard`, 300 requests per 60 s, with stricter limits on authentication routes) uses its default tracker, which is the client address as Express reports it. **Behind a reverse proxy with `trust proxy` off, that address is the proxy's**, so all clients would share one rate-limit bucket. This is a deployment-behaviour question, independent of the advisory, and is part of the host check below.

## 2. What the host owner is asked to establish (read-only; record the answer and the date)
| # | Question | How to answer without changing anything |
|---|---|---|
| H1 | Is the application served directly, or behind a reverse proxy / load balancer / CDN? Which? | inspect the host's service and proxy configuration |
| H2 | Does anything set Express `trust proxy` outside the repository (an environment variable, a wrapper, a process manager flag, a patched `main`)? | search the deployed release package and the process environment for `trust proxy`; compare the deployed `dist/main.js` with the release package |
| H3 | Does the proxy forward `X-Forwarded-For` / `Forwarded`, and does anything downstream rely on them (logs, rate limits, allow-lists, geo rules)? | read the proxy configuration; sample a request log |
| H4 | What client address does the rate limiter see in production (the real client, or the proxy)? | one controlled request from a known address and a look at the application's throttling behaviour or logs |
| H5 | Which `proxy-addr` version is installed in the deployed package, and which Node/Express versions? | `npm ls proxy-addr express` in the *deployed release package* (not the shared development tree) |
## 3. Pass criteria for the T1 host gate
(a) H2 answer: `trust proxy` is **not** set, or, if it is set, the value is recorded and the upgraded `proxy-addr` 2.0.8 is shown to behave correctly for that value in a disposable copy; (b) H5 shows the version actually deployed after the T1 release package is built; (c) H4 is recorded — if all clients share one bucket today, that finding goes to the owner as a separate item (it is not caused by T1). Outcome: `PASS` / `FAIL` / `NOT DETERMINABLE`, with the exact source identity (release package version and checksum, host name, date, who ran it). Until recorded, the host gate stays **NOT PERFORMED** and T1 stays pending final acceptance.
## 4. Prohibited while checking
No change to the proxy or the application, no production traffic generated beyond one controlled request, no credentials or configuration values copied into the evidence.
