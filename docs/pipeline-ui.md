# Pipeline interface

Start the controller as described in the [README](../README.md) and open `http://127.0.0.1:4317`. The server binds only to loopback.

## Canvas

The **Pipeline** page opens directly onto the saved repository's delivery graph, with the left navigation collapsed; the header toggle expands it. Stages run horizontally, **Source → Build → Production**, on a dotted React Flow canvas with directional arrows. Source and Production stay the first and last stages. Without a repository, the page shows **Connect your GitHub** and one **Connect GitHub** button bearing the GitHub mark, which opens the Connect GitHub dialog directly.

The first frame shows the pipeline from its first stage at a readable zoom. When the pipeline is wider than the canvas, pan it. The canvas toolbar holds only zoom and **Fit view**, which shows the whole pipeline at any zoom. The canvas frames itself again after a window or sidebar resize, and after a layout change (a stage added, removed, expanded or collapsed) unless you have panned or zoomed since. Expanding nested content inside a card keeps the current zoom.

Select Source, a service action or a gate to open its configuration in a non-modal Sheet on the right; there is no separate edit mode. On a wide window the Sheet narrows the canvas, and the selected stage is panned into view without zooming. Closing the Sheet restores your previous frame unless you moved the canvas meanwhile. Below 901px the Sheet covers the canvas.

Stages, transition controls and collapse state persist separately for each repository.

## Stage cards

A card grows with its visible content: at least 256px wide and at most `clamp(256px, 70vw, 720px)`, with wrapping labels and natural height rather than an internal scroll area. Following stages are placed from the measured card widths plus a fixed gap, and the connection anchors follow the cards.

Configuration and execution status appears in a shadcn Badge to the right of the stage title. Discovered configuration alone never implies a successful deployment.

Provider rows, tests and nested GitHub workflow steps use shadcn Item and Separator compositions: circular marks on a continuous vertical rail, content on the right, and Collapsible expansion. This is application layout built from registry components, not an official Timeline component. See [Asset provenance](ASSETS.md#registry-components).

## Sandbox stages

The **+** on an eligible connection inserts a **Sandbox** stage there, such as Beta or Gamma. A Sandbox stage follows Build or another Sandbox stage; the Source → Build connection has no insertion control. A pipeline holds at most 12 stages.

Only Sandbox stages offer **Add test**. Their footer also holds **Run now** for the [journey gate](gate.md), **Release** when a gate needs one, and the rename and delete controls. Stage settings only rename the stage. Deleting a stage asks for confirmation and removes it only after its owned environments are cleaned up; see [Twins](twins.md#shared-use-and-recovery).

A Sandbox card lists the stage's twin **Services** and its integration tests. A **Behind** Badge marks a twin built from an older commit than the scanned one; its tooltip shows both commits. A twin a repair's journey gate built at a pull request head shows a **PR head** Badge instead, whose tooltip names the repair branch and the head's short commit. The gate Badge (`Queued`, `Running`, `Passed`, `Failed`, `Needs release` or `Released`) shows the commit it applies to, and its tooltip gives the reason or a commit status report error. Production shows `Ready` with the newest commit that every Sandbox gate passed or released; before a gate reports, it reads `Unverified`, or `Not connected` when neither the repository nor its GitHub deployments name a deployment target. Its tooltip says what the Badge rests on: the commit every gate passed, that no commit has passed every gate yet, or, without a Sandbox stage, that none gates commits before Production and Beta can be added with the **+** after Build.

## Transition controls

The pause control beneath each arrow opens a shadcn Alert Dialog with **Cancel** and **Pause deployment** (or **Resume deployment**). Confirming saves the open or paused state of that transition and keeps any previously saved reason. It does not resize or move the canvas.

These controls describe the pipeline only: they do not block GitHub, Vercel or Railway deployments. The [journey gate](gate.md) is what reports a commit status that branch protection can require. Rollback is not available.

## Build and Production

Build and Production are expanded by default and show their provider rows; each provider group and its nested content start collapsed. Build holds only the workflow runner. Production holds the deployment targets the repository configures, which are its production deployments, never Build steps, and the deployments GitHub records for the scanned commit. An application directory such as `frontend` stays in the underlying scan and is not promoted into a separate step.

- **GitHub Actions**, in Build: one card for every discovered workflow, including those that deploy or configure Vercel preview aliases. Its nested Collapsible list shows each workflow, job and step name. Expanding it does not select, dispatch or change a workflow. Workflow YAML and execution settings stay out of the interface. With a GitHub connection, workflows, jobs and steps carry the status of their GitHub Actions runs for the scanned commit, and the stage Badge combines them; a run for another commit never counts. Runs are polled every 5 seconds while one is active and every minute otherwise, only while the page is visible. Workflows that have no file in `.github/workflows`, such as Dependabot runs, never set the stage status.
- **Vercel**, in Production: a separate group for discovered project previews, including those inferred from alias configuration. Repository clues do not verify cloud access.
- **Railway**, in Production: a separate group. Its drawer keeps only configuration file links, without read-only Build and Deploy field sections.
- **Recorded deployments**, in Production: with a GitHub connection, the deployments GitHub records for the scanned commit, as the app that made them reported them, such as Vercel's or Railway's Git integration. Each joins its provider's group, or forms one after the discovered groups, as a row named by its environment, with the latest state GitHub holds for it (`Queued`, `Deploying`, `Deployed`, `Failed` or `Inactive`) and a link to its address. The row's title names the reporting app and the time. A record for another commit never counts. Records are read every 5 seconds while one is queued or in progress and every minute otherwise, only while the page is visible. A provider that reports nothing to GitHub appears only through the repository's files, and a record is the provider's report, not Perpetual's verification: the stage Badge still reads from the [journey gate](gate.md).

The backend supplies the delivery projection (`source`, `build` and `production`), and the interface renders those groups as supplied, without reclassifying or filtering providers; recorded deployments are added to those groups, and none is removed. Workflow runners and deployment targets stay separate, including targets discovered through workflows. Discovery keeps explicit configuration paths, project names and deduplicated workflow evidence, and bindings follow that evidence rather than connecting every frontend to every Vercel target.

## Autopilot

Autopilot makes changes for the repository on its own. Today it fixes a failed build, the first kind of change ([Build repair](repair.md)); deployment fixes and dependency updates follow the same design ([Autopilot](architecture/autopilot.md)). The interface shows only what the controller records; a card without an Autopilot record shows nothing about it, so only Build carries one today, and only for a managed GitHub source.

- **Badge**: a shadcn Badge after the stage's status Badge reads the mode while nothing is under way, `Autopilot` (changes merge once the stage verifies them, the default) or `Ask first` (changes open a pull request and wait for a person); the title of the work under way, such as `Fixing build`; or the latest change's end, `Merged`, `Passed` (the failure cleared without a change, such as a rerun that passed), `Needs review` or `Not merged`, while that change is the scanned commit's or the watched head's; an older commit's change stays on the rail, and the Badge reads the mode again. The Badge opens a native shadcn Dropdown Menu with the two modes, **Merge changes** and **Ask before merging**, and a link to the change's pull request when it has one. A mode that could not be saved is marked on the Badge and explained in the menu.
- **Beam**: while a change is under way, a light runs along the card's border, the Magic UI Border Beam recorded in [Asset provenance](ASSETS.md#registry-components); with reduced motion the card keeps a still ring instead.
- **Change rows**: each change is a row on the stage rail after the provider rows, with its title and end. A change under way starts expanded, the one exception to nested content starting collapsed, and lists its steps on a nested rail, such as Found or Read the failure, Plan or Diagnose, Change, Verify and Merge, each with its state and a one-line detail whose facts, such as a failed job, a version, a file or a pull request, are set in mono chips, linked when the controller gave an https address. A change under way also offers **Stop**; its pull request stays open.
- **Repair**: a failed workflow row of the GitHub Actions card offers **Repair** for the watched head's own failed run of that workflow, with the head's short commit when it is newer than the scanned one, while the head has no change under way or waiting with its pull request.
- Autopilot is read every 2 seconds while a change is under way and every 15 otherwise, only while the page is visible.

Service settings read the repository's current configuration when opened. A configuration file link opens GitHub's editor for the scanned branch when that branch exists on GitHub (otherwise the path is plain text); edits happen there, not through a local Save button. Repository configuration does not represent verified cloud settings.

Each scan records a `discoveryVersion`. At startup the server attempts one read-only rescan of cached discovery from an older version and saves it while keeping the stages and source; if the rescan fails, the cached data stays. `/api/state` recomputes the delivery projection. A pipeline saved while Build was the single Build & Deploy stage loads with that stage as Build, keeping its state and transitions.

## Branch selector

A shadcn branch Select sits at the upper left of the canvas. It shows the scanned branch and lists the repository's branches through the GitHub connection, with **Load more…** for further pages. Without a connection it offers **Connect GitHub…**, which opens Source settings.

Choosing a branch uses the managed source checkout (see [Provider connections](providers.md#github)) and refreshes the graph. It does not change your working checkout or trigger a deployment, and a branch name never implies a deployment environment. Old `/?view=environments` links open this layout.

## Git graph

The **Git graph** button beside the branch selector opens the same non-modal right-hand Sheet, widened for history. The `@jalco/commit-graph` community registry component draws real commits, parent relationships, branch refs, tags and clickable commit details. `/?preview=branch-map` opens it directly.

- **Current branch** (the default) follows the selected source branch; **All branches** shows the repository-wide history. History loads 100 commits at a time with **Load more**, up to 500.
- For a GitHub source under Perpetual's managed source directory, opening the graph first fetches full commit ancestry and every remote branch head, and **Refresh history** fetches again. Fetches omit file blobs, leave the scanned HEAD and working tree unchanged, and are reused for pagination. Current-branch history follows the fetched remote tip, so newly pushed commits appear after a refresh while the source files stay pinned to the scanned commit. The footer shows **GitHub history**.
- An original user checkout is read-only and shows **Local history**; this feature never fetches or modifies it. **Shallow clone** marks incomplete local history.

The graph is a community registry component, not an official shadcn primitive. Its license and local adaptations are recorded in [Asset provenance](ASSETS.md#registry-components).
