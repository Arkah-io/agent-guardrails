# Releasing

Repository: [Arkah-io/agent-guardrails](https://github.com/Arkah-io/agent-guardrails). npm package: `arkah-agent-guardrails`. Keep the repository URL, npm name, exports, examples, and security-report link consistent.

## Validate the candidate

1. Update the version and changelog, then run `pnpm install --frozen-lockfile`, `pnpm verify`, and `pnpm smoke:package`.
2. Run `pnpm audit` and inspect findings. This checks the installed peer and development dependencies as well as direct dependencies.
3. Run `pnpm pack` and review the archive contents. It should include the declared public entry points, declarations, license, security policy, docs, and synthetic examples. Check for credentials, private fixtures, local paths, and accidental generated files.
4. Confirm the committed candidate passes GitHub CI. The weekly peer job is separate from locked pull-request checks, and its failures remain visible.

## First publication

The first npm package must be published from an authenticated maintainer account. Install that exact candidate archive into a clean project before publishing it. Use `npm publish ./PACKAGE-VERSION.tgz --access public` with the reviewed archive path; complete any npm authentication challenge locally. An npm name with no public registry record is not reserved until publication succeeds.

After publication, install the registry version in a fresh project and run the demo or public API smoke. Confirm the version, repository URL, entry points, peer dependencies, and package integrity in the registry.

## Later releases through GitHub

Configure an npm trusted publisher for this package with organization `Arkah-io`, repository `agent-guardrails`, and workflow filename `publish.yml`. Enable direct publishing for this connection: newer npm configurations can default to staged publishing. The workflow uses Node 24 and npm's OIDC authentication; no long-lived publish token is needed. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Push a reviewed Git tag that exactly matches `v` plus the package version. Run the **Publish** workflow manually for that tag and choose `latest` or `next`. It checks release identity, verifies and packs the source, then publishes the archive. After it succeeds, create the GitHub release for that same tag. Creating a GitHub release alone does not publish to npm. Publishing the same npm version twice fails; do not move a release tag to different code.

## Repository reporting and maintenance

Enable [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) before announcing the repository. Verify that `SECURITY.md` leads to the private report form. The markdown file does not enable the setting itself.

Maintain the required CI checks, review dependency-update pull requests, and subscribe a maintainer to security alerts. Keep unsupported guarantees out of the README and examples.

## Impact to User

- **What changed for users:** Releases are validated as installable packages and tied to source versions.
- **UX impact (positive/negative):** Broken imports and inconsistent metadata are caught before publication; authentication and CI failures stop a release.
- **Who is affected:** Maintainers and developers installing the package.
- **Risks/edge-cases for user experience:** Registry publication is permanent for normal versioning purposes; trusted-publisher setup must match the exact repository and workflow.
- **How to verify from a user perspective:** Install the published version in a fresh project and run its demo or public API smoke.
