# Maximize GitHub Runner Space

## Project Purpose

Forked from [easimon's maximize-build-space action](https://github.com/easimon/maximize-build-space), with additional cleanup coverage and controls.

This GitHub Action reclaims disk space on GitHub-hosted Ubuntu runners by removing selected preinstalled SDKs, toolchains, and caches.

## Quick Start

Run this action early in your workflow.

### Max cleanup with selective skips

```yaml
- name: Maximize runner disk
  uses: justinthelaw/maximize-github-runner-space@master
  with:
    cleanup-profile: max
    skip-components: java,browsers
```

### Custom cleanup (explicit toggles)

```yaml
- name: Maximize runner disk
  uses: justinthelaw/maximize-github-runner-space@master
  with:
    remove-android: 'true'
    remove-codeql: 'true'
    remove-cached-tools: 'true'
    remove-docker-images: 'true'
```

## Development

### What this action does

- Reports disk space before and after cleanup.
- Removes selected preinstalled components.
- Runs independent cleanup tasks in parallel with progress reporting.

### Validation

```bash
pre-commit run --all-files
```

CI matrix tests in `.github/workflows/test.yml` verify each removal toggle independently.

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for workflow and pull request expectations.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for supported versions and vulnerability reporting.

## Support

See [docs/SUPPORT.md](docs/SUPPORT.md) for issue routing and required context.

## License

MIT. See [LICENSE](LICENSE).
