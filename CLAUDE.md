# CLAUDE.md

> **Agents: keep this file up to date.** When you add a project, change the tech stack, add tooling, or modify conventions, update the relevant sections here.

## Repository overview

This is a **monorepo** for small projects hosted under **slop.zackpollard.pro**. Each project lives under `projects/<name>/` and is deployed to its own Cloudflare Pages project with a subdomain (e.g. `roof-calculator.slop.zackpollard.pro`). The homepage project is special — it serves the root at `slop.zackpollard.pro`.

## Repository structure

```
projects/
├── homepage/          # Landing page (serves slop.zackpollard.pro)
└── roof-calculator/   # Satellite-based roof measurement tool
tofu/                  # OpenTofu infrastructure (Cloudflare Pages + DNS)
.github/workflows/
├── infra.yml          # OpenTofu plan/apply
└── deploy.yml         # Cloudflare Pages deployment
```

## Projects

| Project | Path | Tech | Description |
|---------|------|------|-------------|
| homepage | `projects/homepage/` | Static HTML/CSS | Main landing page and project directory |
| roof-calculator | `projects/roof-calculator/` | Static HTML/CSS/JS, Leaflet.js | Satellite map-based roof area measurement tool |

**When adding a new project:**
1. Create `projects/<project-name>/` with a `README.md`
2. Add the project to the table above **and** to the table in the root `README.md`
3. Update `projects/homepage/index.html` to link to the new project
4. Add the project to `tofu/variables.tf` in the `projects` map (with its subdomain)
5. Add the project to the matrix in `.github/workflows/deploy.yml`
6. Run `tofu apply` (or merge to `main` to trigger the infra workflow) to create the Cloudflare Pages project and DNS records

## Tech stack & conventions

- **No build step.** All projects are static HTML/CSS/JS served directly. No npm, no bundlers, no package managers.
- **External libraries via CDN only** (e.g. Leaflet, Google Fonts). No local `node_modules` or vendored dependencies.
- **Infrastructure as Code:** OpenTofu (v1.8+) with the Cloudflare provider (~> 4.0) manages Pages projects and DNS records. Config lives in `tofu/`.
- **No test framework or linter** is currently configured.
- **Styling:** Dark themes with accent color `#c4a24e`. Typography uses Inter (body) and JetBrains Mono (monospace) from Google Fonts.

## Deployment

- **Platform:** Cloudflare Pages (one Pages project per project in this repo)
- **Infrastructure:** OpenTofu manages Cloudflare Pages projects, custom domains, and DNS CNAME records. State is stored in Cloudflare R2 (`tofu-state` bucket, key prefix `slop/`).
- **Workflows:**
  - `.github/workflows/infra.yml` — Runs `tofu plan` on PRs and `tofu apply` on push to `main` (triggered by changes to `tofu/**`)
  - `.github/workflows/deploy.yml` — Deploys each project to its Cloudflare Pages project via Wrangler (triggered by changes to `projects/**`)
- **Preview deployments:** PRs automatically get preview deployments. Preview URLs are posted as PR comments.
- **Domains:**
  - Homepage → `slop.zackpollard.pro`
  - Other projects → `<project-name>.slop.zackpollard.pro`
- **Required GitHub Actions secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

## Git conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages and PR titles (e.g. `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`)
- All PRs are squash-merged
- Default branch is `main`

## Local development

Projects have no build step. Serve any project directory with a static file server:

```bash
# From a project directory
python3 -m http.server 8000
# or
npx serve .
```

## Maintenance checklist for agents

When making changes to this repo, check off the applicable items:

- [ ] If you added a project: updated the projects table in this file, the root `README.md`, homepage `index.html`, `tofu/variables.tf`, and `.github/workflows/deploy.yml` matrix
- [ ] If you changed the deployment workflow or added new infrastructure: updated the Deployment section above
- [ ] If you introduced a build step, package manager, test framework, or linter: updated the Tech stack section above
- [ ] If you changed git conventions or branching strategy: updated the Git conventions section above
- [ ] If you changed OpenTofu configuration: verified `tofu plan` shows expected changes
