# Security Policy

## Overview

Security is a first-class implementation concern in Frosty Deno. The gateway
fails closed around durable state, governance, and config encryption; redacts
secrets before they reach the browser; and keeps its runtime permissions
intentionally narrow.

The detailed implementation model is documented in
[docs/concepts/security-model.md](docs/concepts/security-model.md). The full
dependency inventory and SBOM are documented in
[docs/reference/sbom.md](docs/reference/sbom.md).

## Supported versions

The current checked-in gateway version is `0.9.0`. The repository does not
publish a richer tagged release matrix, so the support statement is
intentionally conservative.

| Version line                          | Supported                               |
| ------------------------------------- | --------------------------------------- |
| `0.9.x`                               | Yes                                     |
| Earlier or untagged historical states | No support commitment published in-repo |

## Reporting a vulnerability

Do not open a public GitHub issue for a security vulnerability.

Use a private channel instead:

1. If the repository is hosted on GitHub with security advisories enabled, use
   the repository's **Security** tab and choose **Report a vulnerability**.
2. If that private advisory flow is unavailable in the hosting environment,
   contact the maintainers through a private maintainer channel rather than a
   public issue.

No dedicated security email address is defined in the checked-in repository
files, so this document intentionally does not invent one.

Include the following in your report:

- a clear description of the issue and why it matters
- affected routes, components, or integrations
- reproduction steps, including required configuration
- the version or commit you tested
- any logs, payloads, or proof-of-concept details that help reproduce the issue
  safely

## Disclosure process

The intended process is:

1. Acknowledge the report privately.
2. Reproduce the issue and assess scope and severity.
3. Prepare a fix and matching regression coverage.
4. Release or publish the remediation.
5. Coordinate public disclosure after a fix exists.

## Dependency security

The checked-in SBOM and the repository-local SBOM generator are the source of
truth for dependency inventory:

- [docs/reference/sbom.md](docs/reference/sbom.md)
- [docs/reference/sbom/sbom.cyclonedx.json](docs/reference/sbom/sbom.cyclonedx.json)
- `scripts/generate_sbom.ts`

Recommended follow-up scans are documented in the SBOM itself.
