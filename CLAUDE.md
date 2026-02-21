# CLAUDE.md

> **Agents: keep this file up to date.** When you add a project, change the tech stack, add tooling, or modify conventions, update the relevant sections here.

## Repository overview

This is a **monorepo** for small projects hosted at **slop.zackpollard.pro**. Each project lives under `projects/<name>/` and is deployed as a subpath of the domain. The homepage project is special — it serves the root of the site.

## Repository structure

```
projects/
├── homepage/          # Landing page (serves site root)
└── roof-calculator/   # Satellite-based roof measurement tool
.github/workflows/
└── deploy-homepage.yml  # GitHub Pages deployment
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
4. The deployment workflow will automatically pick it up at `slop.zackpollard.pro/<project-name>/`

## Tech stack & conventions

- **No build step.** All projects are static HTML/CSS/JS served directly. No npm, no bundlers, no package managers.
- **External libraries via CDN only** (e.g. Leaflet, Google Fonts). No local `node_modules` or vendored dependencies.
- **No test framework or linter** is currently configured.
- **Styling:** Dark themes with accent color `#c4a24e`. Typography uses Inter (body) and JetBrains Mono (monospace) from Google Fonts.

## Deployment

- **Platform:** GitHub Pages
- **Workflow:** `.github/workflows/deploy-homepage.yml`
- **Trigger:** Push to `main` affecting `projects/**` or the workflow file itself, plus manual `workflow_dispatch`
- **How it works:** Copies `projects/homepage/*` to `_site/` root, then copies each other project directory into `_site/<project>/`. Deployed to the custom domain `slop.zackpollard.pro`.

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

- [ ] If you added a project: updated the projects table in this file, the root `README.md`, and the homepage `index.html`
- [ ] If you changed the deployment workflow or added new infrastructure: updated the Deployment section above
- [ ] If you introduced a build step, package manager, test framework, or linter: updated the Tech stack section above
- [ ] If you changed git conventions or branching strategy: updated the Git conventions section above
