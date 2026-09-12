# Development Planning Guidelines

This guide captures the planning and quality expectations expressed by the
current repository documentation and task surface.

## Planning process

### Evaluate requests against the shipped architecture

Before planning work, check:

- whether the behavior already exists in `apps/gateway/routes/*`, `packages/*`,
  or `apps/control-ui/src/*`
- whether the decision log already records the behavior as deferred, shipped, or
  intentionally absent
- whether the change affects the canonical request lifecycle, same-origin UI
  model, PostgreSQL hard dependency, or middleware order

### Write plans in implementation terms

Useful plan anchors in this codebase:

- route files for HTTP behavior
- shared contracts for cross-boundary shape changes
- provider adapters for upstream behavior
- settings, governance, cache, and telemetry packages for cross-cutting work
- control UI views and components for operator-facing behavior

### Break work down by seam

Good task slices in this repo are usually:

- one route family
- one provider adapter or provider capability
- one governance or telemetry behavior
- one control-plane view plus its API contract
- one deployment or observability path

## Development guidelines

### Code review expectations

- Preserve the middleware order unless the change explicitly requires a routing
  or policy move.
- Keep the canonical error envelope intact.
- Do not bypass shared contracts with route-local ad hoc JSON shapes.
- When changing provider, cache, governance, or settings behavior, verify both
  the API surface and the control-plane projection.

### Testing expectations

- Fixed bugs should gain regression coverage in the matching suite.
- Route or contract changes should include the narrowest relevant route,
  integration, or contract test.
- UI changes should include `test-ui` coverage when they affect reusable
  components or view behavior.
- Release-facing changes should be checked against the full gate, not only a
  local slice.

### Documentation expectations

- Update reference docs when routes, settings, environment variables, commands,
  or data shapes change.
- Update concept docs when architectural or security-relevant behavior changes.
- Regenerate the SBOM on dependency changes.

## Best practices

### Performance

- Use `deno task test:load` for end-to-end gateway-over-HTTP measurement.
- Use `deno task bench` for pure-function or micro-benchmark work.
- Treat measure-first performance guidance as a real requirement, not a
  suggestion.

### Security

- Protect `/api/*` in non-local environments with `FROSTY_ADMIN_TOKEN`.
- Respect the fail-closed behavior around PostgreSQL and config encryption.
- Do not widen Deno permissions casually; the current permission set is part of
  the runtime contract.
- Keep secrets out of browser responses and committed files.

### Accessibility

- Follow the control UI conventions around `PageHeader`, keyboard paths, hit
  targets, and shared primitives.
- Keep route-change focus behavior intact.

### Internationalization

- No i18n framework is present in the shipped UI. Any i18n work would be new
  implementation, not an existing extension point.

## Definition of done

- Code or docs match the intended seam and do not fight the repository's core
  architecture.
- Relevant tests or validation commands pass for the changed slice.
- Documentation is updated where the public, operator, or developer contract
  changed.
- For dependency work, the SBOM is regenerated.
- For deployment or observability work, the Compose and runtime implications are
  reflected in the docs.
