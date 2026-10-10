Audit source: `npm-audit-frontend.json` — packages scanned: 73 (prod 7, dev 67). Counts by severity: critical 0, high 1, moderate 2, low 0, info 0, total 3.
Runtime-reachable vulnerable packages: 2; dev-only: 1; direct dependencies: 1.

| Package | Severity | Scope | Direct | Advisory (confirmed by the registry database) | Affected range | Fix available |
|---|---|---|---|---|---|---|
| source-map-js | high | dev only | no | source-map-js allows event-loop denial of service through indexed source-map section offsets (https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | 1.0.0 - 1.2.1 | yes (non-breaking) |
| react-router | moderate | runtime | no | React Router: Open redirect via backslash in <Link> and useNavigate (CVE-2025-68470 bypass) (https://github.com/advisories/GHSA-wrjc-x8rr-h8h6)<br>React Router: Arbitrary Constructor Injection via deserializeErrors() in React Router SSR Hydration (https://github.com/advisories/GHSA-337j-9hxr-rhxg) | 6.0.0 - 7.17.0 | yes — react-router-dom@7.18.4 (SEMVER-MAJOR) |
| react-router-dom | moderate | runtime | yes | via react-router | 6.0.0-alpha.0 - 7.17.0 | yes — react-router-dom@7.18.4 (SEMVER-MAJOR) |
