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

## Adding a new project

1. Create a directory under `projects/` with your project name
2. Include a `README.md` in your project directory explaining how to build/run it
3. Update this table with your project entry
4. Add the project to `tofu/variables.tf` and `.github/workflows/deploy.yml`
5. The project will be deployed at `<project-name>.slop.zackpollard.pro` once the infrastructure workflow runs
