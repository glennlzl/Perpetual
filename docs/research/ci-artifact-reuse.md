# Reusing CI build outputs in a local Compose sandbox

核查日期：2026-10-08。范围是成熟的 CI 产物保留和本地 Docker Compose sandbox 消费方式，采用 GitHub、Docker、Next.js 及部署平台官方文档。本文是方案研究，不代表 Perpetual 已实现该流程。

## 结论

**首选：CI 用仓库 Dockerfile 为目标提交构建 runnable OCI image，推到 GHCR；sandbox 记录并拉取该镜像的不可变 digest，Compose 继续在本机运行。** 这比上传源码构建目录更直接，因为 Docker image 已含运行时和系统依赖，Compose 可用 `image:` 消费，不需要再 `build:`。不要把 `latest` 或可移动 SHA tag 当作身份；commit SHA 可作检索标签，digest 才是精确制品身份。

这条路径避免重复的依赖安装和应用编译，但不能保证首拉更快：首次仍需下载镜像层，速度受镜像大小、网络和 registry 影响。用户已有的本地 Docker Compose 仍是 sandbox；这不是切换到云 sandbox。若 build 中有浏览器可见的环境变量，构建时生成的前端 bundle 会固定其值，必须先明确构建参数和目标 URL/环境如何处理。

## 推荐流程

1. CI 先构建并发布目标提交的应用镜像；普通 CI 检查（例如 lint、单元测试）可以在发布前完成或并行完成。Perpetual 校验这些检查与镜像来源后，使用镜像建立 Sandbox，再执行该阶段已批准的 journeys，决定能否晋级。镜像发布不能依赖消费这个镜像的 journey gate，否则形成循环。
2. 发布 job checkout 同一 `github.sha`，以仓库 Dockerfile 用 Buildx 构建镜像并推 GHCR。将原有应用编译步骤整合到 Dockerfile，或让最终打包阶段直接复制已有的、兼容的构建输出；不要先编译一次又在 Dockerfile 内重新编译一次。每个必要的目标架构需要对应的构建产物。
3. 同时打 `sha-<full commit SHA>` 便于检索，保留 Buildx action 输出的 OCI digest。把 commit、digest、平台、Dockerfile/build 参数及普通 CI 检查结果作为 run 元数据返回给 sandbox。commit tag 仅是索引；本地实际拉取使用 `ghcr.io/acme/app@sha256:…`。
4. sandbox 只消费与所选 commit 完全相同、镜像构建成功且普通 CI 检查通过的 digest。Compose 的应用服务改为 `image: ${PERPETUAL_APP_IMAGE}`，运行时依赖服务和本机持久数据仍按当前 Compose 配置运行。若 Compose 对应用源代码做 bind mount，挂载会遮住 image 中的构建产物；这类开发模式不能同时声称复用该产物。
5. image 缺失、普通 CI 检查未通过、平台不匹配或 pull 失败时，明确报状态/错误。不要静默退回未标识的 `latest` 或把本地重建说成已复用 CI 输出。

现有部署平台的官方指引也展示了 CI 构建/推送 image 后，让平台通过 Compose `image:` 拉取；Coolify 文档说明 CI 应先完成 required checks，部署再使用已发布 image。Dokploy 的生产部署指南采用 Build & Publish on CI 的同类模式。它们是部署平台实践，可佐证模式成熟；Perpetual 应保留自己的 gate 和本地消费者边界，不需要引入平台 webhook。[Coolify：GitHub Actions source](https://coolify.io/docs/applications/sources/github/actions)、[Dokploy：Going to production](https://docs.dokploy.com/docs/core/applications/going-production)

## 最小工作流示例

以下是镜像发布 workflow 示例，假设仓库已有可运行的 Dockerfile；它本身不执行或证明任何测试通过。接入现有 CI 时，可让发布 job 依赖普通检查 job，或让消费者另外查询该提交的普通检查结果。Perpetual 的业务 journey gate 在镜像被 Sandbox 消费之后运行，仍然控制晋级。将 `main` 改为实际跟踪分支，将 `ghcr.io/acme/app` 改为有发布权限的全小写镜像名。动作主版本来自官方仓库；落地时固定审查过的完整 action commit SHA。示例选 `linux/amd64`；ARM 本机需要对应变体。

```yaml
name: sandbox-image

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

env:
  IMAGE: ghcr.io/acme/app

jobs:
  publish-image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      digest: ${{ steps.image.outputs.digest }}
      image: ${{ env.IMAGE }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.sha }}
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: image
        uses: docker/build-push-action@v7
        with:
          context: .
          file: ./Dockerfile
          platforms: linux/amd64
          push: true
          tags: |
            ${{ env.IMAGE }}:sha-${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

The action output `digest` must be persisted with the source commit and publish run identity for the local consumer. A job output alone is not a durable external handoff. Perpetual still needs this integration; the example publishes an image but does not implement discovery or digest handoff. A small run artifact containing that mapping is sufficient initially. The official GitHub Docker publish example grants `contents: read` and `packages: write`, logs into GHCR with `github.actor` and `GITHUB_TOKEN`, then pushes through `build-push-action`; Buildx's `digest` output identifies the pushed image. [GitHub: publish Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [build-push-action outputs](https://github.com/docker/build-push-action#outputs), [current Docker action examples](https://docs.docker.com/build/ci/github-actions/multi-platform/)

Compose consumes the exact digest supplied for the selected commit:

```yaml
services:
  app:
    image: ${PERPETUAL_APP_IMAGE:?select a successful commit image}
    # Keep local dependency services and owned data volumes here.
```

Set `PERPETUAL_APP_IMAGE=ghcr.io/acme/app@sha256:<recorded-digest>` only after validating that the recorded commit equals the selected commit and the image build and required ordinary CI checks passed. Avoid committing personal credentials in `.env`; The host-side Docker CLI can use a configured credential helper for pulls; do not pass registry credentials into application containers.

## Identity, access, retention, and cache

- **Identity:** OCI tags are mutable names. Store full source commit SHA alongside image digest, and consume `name@sha256:…`; a short SHA tag is convenient for lookup, not a cryptographic pin. A multi-platform image digest identifies its manifest index; Docker selects a platform-specific image from it.
- **Private GHCR pull:** a local user must authenticate to `ghcr.io` with a GitHub classic PAT that has `read:packages` and package access, then Compose can pull. Use Docker's credential store/credential helper, not a token embedded in Compose, source, or logs. In Actions, `GITHUB_TOKEN` can publish with `packages: write`; ensure the package grants read to the intended repository/workflow. An existing GitHub repository connection does not by itself establish that the local Docker client has registry credentials or package read access; credential acquisition and storage need an explicit supported path. [GHCR auth and permissions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- **Public alternative:** mark the GHCR package public if code and image contents may be public; public container images can be pulled anonymously. That changes access policy, not digest handling. Verify package visibility and inherited permissions before rollout. [GitHub Packages access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- **Retention:** workflow artifacts are files attached to workflow runs; their retention is configured in days, constrained by repository/organization/enterprise limits, and deleting a workflow run deletes its artifacts. Packages/images have a separate lifecycle from workflow artifacts. For GHCR, implement desired age/count cleanup through package-version deletion tooling or a maintenance workflow; `retention-days` is not a GHCR image setting. Preserve active/pinned digests and remove only unreferenced historical versions; keep a shorter-lived artifact for diagnostics or metadata only. [Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts), [artifact retention](https://docs.github.com/en/actions/tutorials/store-and-share-data#configuring-a-custom-retention-period-for-an-artifact)
- **Build cache:** `cache-to/from: type=gha` stores reusable BuildKit layers to accelerate a future CI build; it is not the runnable image and the local Compose sandbox cannot pull it as an app. GitHub's cache can be evicted under limits/policy. Keep cache and image publication separate in both naming and reasoning. [Docker GHA cache backend](https://docs.docker.com/build/cache/backends/gha/), [GitHub artifact vs cache](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts#artifacts-versus-dependency-caching)
- **Architecture:** `ubuntu-latest` commonly yields amd64. An arm64 Mac sandbox needs an arm64 image or a multi-platform manifest (`linux/amd64,linux/arm64`); multi-platform Buildx pushes a manifest list so Docker selects a matching variant. Emulated builds can be slower. Use one platform when the supported local platform is known, or explicitly publish both. [Docker multi-platform builds](https://docs.docker.com/build/ci/github-actions/multi-platform/)

## Build-time configuration and app packaging

For Next.js, `NEXT_PUBLIC_*` values are inlined into browser JavaScript during `next build`; publishing one image cannot safely change those values at container startup. Choose among: (a) build a separate image for each explicit environment/configuration, with that config recorded as a build input; (b) change the app to fetch browser-safe public configuration at runtime; or (c) use server-only runtime environment variables for values that remain on the server. Never bake secrets into public build args or image layers. Any browser endpoint baked into the bundle must be known before building; an application that reads public configuration at runtime does not have that constraint. [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser)

If a separate runtime bundle is preferred, GitHub `upload-artifact`/`download-artifact` can retain files, but then the consumer must know the matching OS/CPU, Node/runtime version, native dependencies, install layout, and how to reconstruct the runnable service in Compose. For Next standalone output, `.next/standalone` includes a minimal server and traced dependencies; public assets and `.next/static` need copying as documented. This can be smaller than an image, but creates an extraction/reconstruction protocol and platform-specific artifacts. It is a reasonable alternative only when the sandbox already has a compatible runtime contract; for a Docker Compose twin, publishing the runnable OCI image is the simpler boundary. [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output#automatically-copying-traced-files), [GitHub upload/download artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)

If using that fallback, create the complete runnable archive in the existing packaging step, then upload it. A tar archive preserves permissions and hidden files; include required runtime dependencies and assets. Set explicit retention, such as thirty days within repository limits. The consumer validates its source commit, run, digest and compatibility; on expiry or absence, report unavailable or explicitly fall back to local build. [Artifact upload limitations](https://github.com/actions/upload-artifact#limitations)

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: runtime-bundle-${{ github.sha }}
    path: dist/runtime-bundle.tar.zst
    if-no-files-found: error
    retention-days: 30
```

## Applicability and limits

The repository's current local sandbox repeats dependency installation (~32 seconds) and application build (~40 seconds), while the examined application CI has no retained runnable Actions artifacts and may skip build jobs for unchanged paths. This does not establish the absence of images published by some separate deployment platform. The integration must distinguish a successful overall CI run from an actual image build and publish. Sandbox journeys consume the published image and run afterwards; they cannot be prerequisites for producing it. Path filtering can continue to skip truly unaffected work; do not claim an image exists for a skipped build. The first local pull still transfers image layers, and disk use/registry storage become costs. Measure image compressed size, cold pull, warm pull, and sandbox startup before setting a speed target.

This is a proposal only: it does not claim a workflow, package, digest handoff, Compose setting, new cloud sandbox, or retention rule has been implemented. No product change or CI mutation was made for this research.
