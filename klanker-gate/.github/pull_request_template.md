## Summary

Briefly explain the purpose of this PR and the problem it solves.

## Changes

- What was changed and why
- Any notable design decisions or trade-offs

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Documentation
- [ ] Chore/CI

## Affected areas

- [ ] Gateway / core
- [ ] Providers/Integrations
- [ ] Config / persistence
- [ ] Plugins
- [ ] Control UI
- [ ] Docs / CI

## How to test

Describe the steps to validate this change. Include commands and expected
outcomes.

```sh
# Gateway (Deno) — run from repository root
deno fmt --check
deno lint
deno task check
deno task test

# Control UI (driven through Deno; no npm)
deno task setup      # once: installs the whole workspace
deno task test-ui
deno task build-ui
```

If adding new configs or environment variables, document them here.

## Screenshots/Recordings

If UI changes, add before/after screenshots or short clips.

## Breaking changes

- [ ] Yes
- [ ] No

If yes, describe impact and migration instructions.

## Related issues

Link related issues and discussions. Example: Closes #123

## Security considerations

Note any security implications (auth, secrets, PII, sandboxing, etc.).

## Checklist

- [ ] I read `README.md` and followed the guidelines
- [ ] I added/updated tests where appropriate
- [ ] I updated documentation where needed
- [ ] I verified builds succeed (Deno gateway and control UI)
- [ ] I ran the full gate locally and pasted the commands and results below
      (nothing runs it automatically - there is no CI in this repository)
