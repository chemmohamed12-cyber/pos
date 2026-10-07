# Authorization program — verification tools (isolated environment only)

Scripts used to produce the F1/F2 gate evidence. They talk to the isolated verification environment (backend `127.0.0.1:3601`, Postgres `127.0.0.1:5656`, `bv_*` databases) and refuse nothing by themselves, so **never point them at a shared or production host**. Test credentials are NOT stored here: export `BV_TEST_PASSWORD` for the seeded test accounts.

- `f1-http-verification.js`, `f2-http-verification.js` — real-HTTP verification of `/auth/me`, navigation, organization (F1) and Company Users / invitations / multi-role (F2).
- `ab-latency-harness.js` — interleaved A/B latency against a pre-change build on port 3602. Counts EVERY non-200 per side and `ab-aggregate.js` discards the whole run if either side saw one (a Throttler 429 is a fast response and silently biases percentiles).
