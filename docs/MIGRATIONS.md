# Migrations

This document captures breaking changes and notable behavior shifts between releases so users can migrate safely.

## Table of Contents

- [0.6.x -> 0.7.0](#06x---070)

## 0.6.x -> 0.7.0

**Summary**

`cleanup-profile: max` now removes a much wider set of preinstalled tools. If your workflows rely on any of the components listed below, add them to `skip-components` or switch to `cleanup-profile: custom` and opt in to specific `remove-*` toggles.

**Breaking changes and behavior shifts**

- **Max profile scope expanded**. The default `max` profile now enables all removal toggles, including cloud CLIs, Kubernetes tooling, container tooling, build tools, databases, and services. If you previously used `max` and expected these tools to remain available, you must explicitly keep them.
- **New skip-components values**. Many new component names are available for `skip-components` (see `README.md`). If you want to keep a specific tool, you must now include its component name.
- **Browser and toolcache grouping behavior**. Listing any browser subcomponent (`chrome`, `chromium`, `edge`, `firefox`, `webdrivers`, `selenium`) or toolcache subcomponent (`cached-go`, `cached-node`, `cached-python`, `cached-pypy`, `cached-ruby`) in `skip-components` automatically disables the group removal (`browsers` or `cached-tools`). This ensures granular control but changes the default behavior when you skip a single subcomponent.
- **Docker availability**. `remove-docker-engine` is new and enabled by `max`. If you need Docker for build or test steps, add `docker-engine` to `skip-components`.

**New toggles introduced in 0.7.0**

- Cloud and DevOps tooling: `remove-aws-cli`, `remove-aws-sam-cli`, `remove-azure-cli`, `remove-gh-cli`, `remove-gcloud-cli`, `remove-azcopy`, `remove-kubectl`, `remove-helm`, `remove-kind`, `remove-minikube`, `remove-kustomize`.
- Container tooling: `remove-docker-engine`, `remove-buildah`, `remove-podman`.
- Build tools: `remove-maven`, `remove-gradle`, `remove-ant`.
- Languages and package managers: `remove-rust`, `remove-miniconda`, `remove-homebrew`, `remove-vcpkg`.
- Browsers and drivers: `remove-chrome`, `remove-chromium`, `remove-edge`, `remove-firefox`, `remove-webdrivers`, `remove-selenium`.
- toolcache subsets: `remove-cached-go`, `remove-cached-node`, `remove-cached-python`, `remove-cached-pypy`, `remove-cached-ruby`.
- Databases and services: `remove-postgresql`, `remove-mysql`, `remove-apache`, `remove-nginx`.

**Migration checklist**

- If you use `cleanup-profile: max`, add all required tools to `skip-components`.
- If you want stricter control, switch to `cleanup-profile: custom` and enable only the `remove-*` toggles you need.
- Review the `Inputs reference` section in `README.md` to confirm what each toggle removes.
