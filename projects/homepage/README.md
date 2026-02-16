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

Serve the contents of this directory as a static site at the root domain `slop.zackpollard.pro`.
