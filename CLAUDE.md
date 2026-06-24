# CLAUDE.md

> **Agents: keep this file up to date.** When you add a project, change the tech stack, add tooling, or modify conventions, update the relevant sections here.

## Repository overview

This is a **monorepo** for small projects hosted under **slop.zackpollard.pro**. Each project lives under `projects/<name>/` and is deployed to its own Cloudflare Pages project with a subdomain (e.g. `roof-calculator.slop.zackpollard.pro`). The homepage project is special — it serves the root at `slop.zackpollard.pro`.

## Repository structure

```
projects/
├── homepage/                  # Landing page (serves slop.zackpollard.pro)
├── roof-calculator/           # Satellite-based roof measurement tool
├── dnd-encounter-generator/   # D&D 2024 combat encounter generator
├── cron/                      # Cron expression translator with timeline
├── subnet/                    # IPv4 subnet calculator with binary breakdown
├── json/                      # JSON formatter, tree viewer, and diff tool
├── flip-7/                    # Flip 7 card game scoreboard
├── uno-no-mercy/              # UNO No Mercy scoreboard
├── exploding-kittens/         # Exploding Kittens game assistant
├── herd-mentality/            # Herd Mentality game companion
├── texas-holdem/              # Multiplayer Texas Hold'em poker
├── cards-against-humanity/    # P2P Cards Against Humanity party game
├── waze-beep-sound-pack/      # Beeps-only Waze sound pack generator
└── unifi-store/               # Parody UniFi Store with fake checkout
tofu/                  # OpenTofu infrastructure (Cloudflare Pages + DNS)
.github/workflows/
├── deploy.yml         # Infrastructure (tofu plan/apply) + production deployment
├── preview.yml        # PR preview deployment (combined subpath site)
└── waze-pack.yml      # Builds + uploads the Waze beep voice pack (CI-only, opt-in)
```

## Projects

| Project | Path | Tech | Description |
|---------|------|------|-------------|
| homepage | `projects/homepage/` | Static HTML/CSS | Main landing page and project directory |
| roof-calculator | `projects/roof-calculator/` | Static HTML/CSS/JS, Leaflet.js | Satellite map-based roof area measurement tool |
| dnd-encounter-generator | `projects/dnd-encounter-generator/` | Static HTML/CSS/JS | D&D 2024 combat encounter generator |
| cron | `projects/cron/` | Static HTML/CSS/JS | Cron expression translator with timeline visualization |
| subnet | `projects/subnet/` | Static HTML/CSS/JS | IPv4 subnet calculator with binary breakdown |
| json | `projects/json/` | Static HTML/CSS/JS | JSON formatter, tree viewer, and diff tool |
| flip-7 | `projects/flip-7/` | Static HTML/CSS/JS | Flip 7 card game scoreboard |
| uno-no-mercy | `projects/uno-no-mercy/` | Static HTML/CSS/JS | UNO No Mercy scoreboard |
| exploding-kittens | `projects/exploding-kittens/` | Static HTML/CSS/JS | Exploding Kittens game assistant with card reference and probability calculator |
| herd-mentality | `projects/herd-mentality/` | Static HTML/CSS/JS | Herd Mentality game companion with question bank and answer collection |
| texas-holdem | `projects/texas-holdem/` | Static HTML/CSS/JS, PeerJS | Multiplayer Texas Hold'em poker with peer-to-peer networking |
| cards-against-humanity | `projects/cards-against-humanity/` | Static HTML/CSS/JS, PeerJS | P2P Cards Against Humanity party game |
| waze-beep-sound-pack | `projects/waze-beep-sound-pack/` | Static HTML/CSS/JS, Web Audio API, JSZip (CDN) | Beeps-only Waze sound pack generator with WAV/zip export |
| unifi-store | `projects/unifi-store/` | Static HTML/CSS/JS (ES modules) | Parody UniFi Store: real scraped catalog (`catalog.json`), full cart + fake checkout + dopamine dashboard, all in `localStorage` |

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
  - `.github/workflows/deploy.yml` — Runs `tofu plan` (and comments on PRs), then `tofu apply` + deploys each project to its Cloudflare Pages project on push to `main`
  - `.github/workflows/preview.yml` — Preview deploys: assembles all projects under subpaths into a single `slop-preview` Pages project on PRs. No per-project Pages project needed for previews.
  - `.github/workflows/waze-pack.yml` — CI-only, opt-in (not a deploy): renders the `waze-beep-sound-pack` beeps in headless Chromium, builds an MP3 voice pack, and uploads it to Waze via a cloned GPLv3 tool, printing the `acvp` install link. Uses Node/Playwright + ffmpeg + Python (the only place the repo uses these); needs no secrets. This is the lone exception to the "no build step / no package managers" rule, and it only touches the Waze pack, not the served sites.
- **Preview deployments:** PRs automatically get a combined preview deployment to a single `slop-preview` Cloudflare Pages project. All projects are served under subpaths (e.g. `/homepage/`, `/roof-calculator/`). Preview URLs are posted as PR comments. This avoids needing to create per-project Pages infrastructure before previews work.
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
