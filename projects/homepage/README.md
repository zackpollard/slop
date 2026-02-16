# homepage

The main landing page for [slop.zackpollard.pro](https://slop.zackpollard.pro).

## Overview

A static site that serves as the index and directory for all projects in the slop monorepo.

## Development

This is a plain HTML/CSS site with no build step. To preview locally, serve the files with any static file server:

```bash
# Python
python3 -m http.server 8000

# Node.js (npx)
npx serve .
```

Then open `http://localhost:8000` in your browser.

## Deployment

Deployed automatically to GitHub Pages via the `deploy-homepage` workflow on pushes to `main` that change files in this directory.

The custom domain `slop.zackpollard.pro` is configured via the `CNAME` file. DNS must have a CNAME record pointing `slop.zackpollard.pro` to `zackpollard.github.io`.
