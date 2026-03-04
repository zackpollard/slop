# slop

Monorepo for projects hosted at **slop.zackpollard.pro**.

## Structure

```
projects/
└── <project-name>/    # Each project gets its own directory
```

- The **homepage** project serves the main site at `slop.zackpollard.pro`
- Other projects are deployed as subdomains: `<project>.slop.zackpollard.pro`

## Projects

| Project | URL | Description |
|---------|-----|-------------|
| [homepage](projects/homepage) | [slop.zackpollard.pro](https://slop.zackpollard.pro) | Main landing page and project index |
| [roof-calculator](projects/roof-calculator) | [roof-calculator.slop.zackpollard.pro](https://roof-calculator.slop.zackpollard.pro) | Satellite map-based roof measurement tool |
| [dnd-encounter-generator](projects/dnd-encounter-generator) | [dnd-encounter-generator.slop.zackpollard.pro](https://dnd-encounter-generator.slop.zackpollard.pro) | D&D 2024 combat encounter generator |
| [cron](projects/cron) | [cron.slop.zackpollard.pro](https://cron.slop.zackpollard.pro) | Cron expression translator with timeline visualization |
| [subnet](projects/subnet) | [subnet.slop.zackpollard.pro](https://subnet.slop.zackpollard.pro) | IPv4 subnet calculator with binary breakdown |
| [json](projects/json) | [json.slop.zackpollard.pro](https://json.slop.zackpollard.pro) | JSON formatter, tree viewer, and diff tool |

## Adding a new project

1. Create a directory under `projects/` with your project name
2. Include a `README.md` in your project directory explaining how to build/run it
3. Update this table with your project entry
4. Add the project to `tofu/variables.tf` and `.github/workflows/deploy.yml`
5. The project will be deployed at `<project-name>.slop.zackpollard.pro` once the infrastructure workflow runs
