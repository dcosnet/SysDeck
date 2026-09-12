# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- A complete Diataxis-oriented documentation set under [docs/](docs/), including
  tutorials, guides, concepts, design reference, technical reference, and
  standalone SVG architecture diagrams.
- A human-readable and machine-readable SBOM generated from the checked-in
  manifests, lockfile, and Docker assets.
- A repository-local SBOM generation script at `scripts/generate_sbom.ts`.

### Changed

- Root documentation was aligned with the current PostgreSQL-backed
  architecture, same-origin control-plane flow, and shipped observability stack.
- Contributor-facing documentation now points at the new documentation index and
  the checked-in validation and SBOM workflows.

### Security

- Security documentation now points directly at the current security model,
  SBOM, and private-reporting workflow.

## Historical note

The repository does not currently expose a tag-based release history. Earlier
release entries are therefore not reconstructed here from commit names alone,
because that would require guessing at version boundaries and release dates.
