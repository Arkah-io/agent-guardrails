# Contributing

Use Node 20+ and pnpm 9.1.0. Run `pnpm install --frozen-lockfile`, then `pnpm verify` and `pnpm smoke:package`. Changes to middleware should include a real `createAgent` integration test; claims about interrupts should include a checkpoint/resume test. Preserve the package's text-result contract and explicit trusted boundaries.

Do not add provider credentials, production data, application prompts, or private application dependencies. Use synthetic documents in examples. Peer ranges start at the versions in the lockfile, which CI tests on every push. A separate weekly job installs newer releases within those peer majors and reports failures. Fix any incompatibility or narrow the range before the next release. Never lower a floor without adding that version to CI.

The store interface is a correctness boundary. Adapter contributions must exercise concurrent workers, failed transactions, and the side-effect/result crash gap. Avoid describing middleware claims as exactly-once side effects.

For a public contribution, describe the concrete behavior, evidence, and limitations. Keep changes small enough to review. The [community proposal](docs/community-proposal.md) records the intended upstream discussion.

Release maintainers should follow [the release guide](docs/releasing.md). Pull requests should explain observable behavior and finish with the Impact to User section in the repository template.
