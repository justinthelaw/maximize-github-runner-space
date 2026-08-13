# Support

## How To Get Help

- Bug reports: use the Bug Report issue template.
- Feature requests: use the Feature Request issue template.
- Security concerns: follow [Security policy](/docs/SECURITY.md).

## Before Opening An Issue

- Search open and closed issues first.
- If you recently upgraded, review [Migration guide](/docs/MIGRATIONS.md) for breaking changes.
- Include the exact workflow runner label and detected architecture.
- Copy the complete **Runner Image** block from the runner's **Set up job** log,
  including `ImageOS`, `ImageVersion`, and the Included Software links. Redact
  repository-specific or private values, but keep the image identifiers intact.
- Include the action tag or full commit SHA, the cleanup step's workflow snippet, and every supplied input.
- Include any `available-bytes-before`, `available-bytes-after`,
  `reclaimed-bytes`, `platform`, and `architecture` outputs the action emitted.
  Fatal failures can occur before outputs are emitted.
- Include the action's per-operation summary and relevant failure logs with credentials and other secrets removed.
