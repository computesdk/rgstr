# Changesets

Every user-facing change ships with a changeset (`pnpm changeset`, patch by
default). Merging to `main` opens/updates the "Version Packages" PR; merging
that publishes `rgstr` to npm with provenance (`.github/workflows/release.yml`).
