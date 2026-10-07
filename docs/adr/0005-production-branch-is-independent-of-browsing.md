# Production branch is explicit and independent of browsing

The canvas can inspect different branches, so its selected branch must not silently change where a Pipeline may release. Save an explicit, GitHub-verified Production branch on the Pipeline and admit Perpetual deployments only from that branch's inspected commit, with the existing Build and journey gates; an unset value blocks deployment. Switching the canvas preserves this policy, and an unresolved deployment holds policy changes.
