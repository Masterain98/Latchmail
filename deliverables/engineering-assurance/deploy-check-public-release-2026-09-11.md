# Latchmail public-release pre-deploy check

## TL;DR

The repository is suitable for publishing as source after the cleanup completed in this audit. The full source-reference scan is clean, no credentials or private keys were found, production dependencies have no reported vulnerabilities, and the local build/test gate passes. Cloudflare deployment remains manual and pending real resource identifiers, origins, secrets, DNS/MX, and staging acceptance. One production security item remains open: webhook destinations must be revalidated immediately before delivery to prevent DNS rebinding.

Severity distribution: 1 open P1 runtime security item, 3 P2 release-hardening items, and no source-publication blocker. The cloud release decision is MANUAL_PENDING until the operational checklist is completed.

## Core Conclusion Card

| Item | Result |
| --- | --- |
| Overall source-release rating | GO |
| Cloud deployment rating | MANUAL_PENDING |
| Open P1 items | 1 |
| Open P2 items | 3 |
| Automated local gate | PASS |
| Next step | Populate private deployment values, run staging acceptance, and close the webhook delivery review |

## Action List

| # | Action | Owner | Urgency | Target |
| --- | --- | --- | --- | --- |
| 1 | Resolve and block private, reserved, mapped, and rebinding destinations immediately before every webhook delivery; add regression tests. | Backend owner | P1 | Before cloud release |
| 2 | Supply real D1/R2 identifiers, `APP_ORIGIN`, and all three runtime secrets through the private deployment process; never commit them. | Release owner | P1 | Before staging deploy |
| 3 | Run staging checks for login, CSRF, private downloads, receipt, parsing, retention, scheduled maintenance, and signed webhook delivery. | QA/SRE owner | P1 | Before production deploy |
| 4 | Add authenticated UI and webhook integration coverage to the CI gate. | QA owner | P2 | Next iteration |
| 5 | Release only from a clean tracked-file archive and verify ignored build/runtime state is excluded. | Release owner | P2 | Every release |

## Checklist (item / status / owner)

| Item | Status | Owner |
| --- | --- | --- |
| Project naming and bilingual documentation | PASS | Maintainer |
| Brand assets are repository-local and self-contained | PASS | Maintainer |
| Deployment automation removed; deployment is documented as manual | PASS | Release owner |
| Temporary/generated directories excluded by `.gitignore` | PASS | Release owner |
| Credential/private-key scan | PASS | Security owner |
| Source-reference scan | PASS | Security owner |
| Production dependency audit | PASS | Dependency owner |
| Typecheck, lint, unit, integration, build, Wrangler dry-run | PASS | CI owner |
| Browser locale persistence smoke test | PASS | QA owner |
| Real Cloudflare account/resources and DNS/MX | MANUAL_PENDING | Release owner |
| Staging external-mail and webhook acceptance | MANUAL_PENDING | QA/SRE owner |

## Security Risks

1. Webhook host validation currently occurs when the setting is saved. Delivery later performs a fresh network lookup, so a DNS change can bypass the earlier decision. Revalidate immediately before each delivery or enforce an equivalent egress policy, fail closed on empty answers, and cover IPv4-mapped IPv6 and reserved ranges.
2. Deployment configuration intentionally contains replacement markers and example origins. These are safe placeholders but must be replaced in a private environment-specific configuration before deployment.
3. The health endpoint is a liveness response only; it does not prove that D1, R2, secrets, or scheduled work are ready.
4. D1 has no down migration. Rollback across incompatible schema changes requires a data-aware recovery plan.

## Test Coverage & CI Status

Executed successfully on 2026-09-11:

- `npm run check` (typecheck, lint, unit, integration, production build, Wrangler dry-run)
- `npm run test:e2e`
- `npm audit --audit-level=high`
- `npm audit --omit=dev --audit-level=high`
- full-text scans for credentials, private keys, local-only paths, generated artifacts, and source-reference markers

The test suite does not yet exercise authenticated browser flows, the complete webhook status/retry matrix, DNS rebinding, or real Cloudflare resources. CI currently runs the standard check command; staging acceptance remains an operator step.

## Go/No-Go Decision

Source publication: **GO**, provided the release archive contains tracked project files only.

Cloudflare production deployment: **NO-GO until MANUAL_PENDING items are completed and the P1 webhook destination review is closed**.

## Rollback Plan

Before deployment, export D1 and record the current R2 object inventory and Worker version. For code-only regressions with a compatible schema, roll back to the previous Worker version and verify login, private reads, receipt, parsing, and webhook delivery. For schema changes, restore data and code together rather than blindly reverting one side. During a severe mail incident, pause routing, preserve queued objects, and rotate webhook/session secrets with an overlap plan.

## Disclaimer

本报告由工程保障团队 AI 协作生成，关键决策请由人类工程负责人复核。
