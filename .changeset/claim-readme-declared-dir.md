---
"@rgstr/cli": patch
---

`rgstr claim` puts the badge where rgstr will read it. A monorepo package whose npm metadata has no `repository.directory` is read from the repository's root README, so the badge now goes there (with a note suggesting `repository.directory` for the next release) instead of the package folder's README, which `claim --check` would never see. A declared directory (`repository.directory` or a `/tree/<ref>/<dir>` URL) sends the badge to that folder's README.
