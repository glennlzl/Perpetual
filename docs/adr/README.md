# Architecture decision records

An architecture decision record (ADR) notes one decision that is hard to reverse, surprising without context, and the result of a real trade-off. A decision that is easy to reverse or follows the obvious path needs no ADR. Vocabulary belongs in the root `CONTEXT.md`, and longer designs in `docs/architecture/`.

## Convention

- One decision per file, numbered in sequence: `0001-slug.md`, `0002-slug.md`. Take the number after the highest existing one, and never reuse a number.
- Title the file with the decision, then write one to three sentences: the context, what was decided, and why.
- Add a **Status** (`proposed`, `accepted`, `deprecated` or `superseded by ADR-NNNN`), **Considered options** or **Consequences** only when they add something a reader needs.
- To change a decision, write a new ADR and mark the old one superseded rather than rewriting it.

## Decisions

- [0001: Gate and manual runs execute approved Playwright code](0001-gate-runs-approved-playwright-code.md) (accepted)
- [0002: A repair merges itself only after CI and every journey gate pass at its exact head](0002-repairs-merge-after-ci-and-journey-gates.md) (accepted)

- [0003: A person reviews fixed POST reads before discovery and control admit them](0003-review-fixed-post-reads.md) (accepted)

- [0004: Review application callback aliases independently of published ports](0004-review-application-callbacks.md) (accepted)

- [0005: Production branch is explicit and independent of browsing](0005-production-branch-is-independent-of-browsing.md) (accepted)
