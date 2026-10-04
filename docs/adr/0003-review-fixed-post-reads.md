# 3. A person reviews fixed POST reads before discovery and control admit them

Method-only blocking made applications with POST-based reads unreadable, but permitting an endpoint or an agent-labelled GraphQL operation would also permit writes. A person therefore reviews each exact application URL and complete fixed JSON body; discovery and the write-blocked control admit only those bounded requests, with read redirects and automatic retries disabled, and the policy identity binds verification and approval. For a managed twin, policy identity binds the application service and fixed path/body so rebuilding that same service on a new port preserves CI/CD approval; ambiguous targets suspend rules and another application service receives none. Fresh GET evidence and an independently failed reviewed business outcome remain mandatory, while dynamic payloads, unreviewed reads and socket reads retain their existing restrictions.

Status: accepted; supersedes only ADR 0001's blanket POST-read limitation.

## Amendment: explicitly reviewed bodyless reads

Some application bootstraps send POST without a request body. A person can select **No body**, represented as `body: null`, separately from fixed JSON. Only zero body bytes and an absent Content-Type match this mode; JSON, form data, whitespace, method overrides and redirects remain refused. The exact URL restrictions and policy binding stay in force. Existing JSON policy identities are preserved; changing between JSON and No body changes the identity and requires verification and approval again. No request gains permission merely because it is bodyless.
