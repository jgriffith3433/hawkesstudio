---
name: static-sites-howto
description: How to change the static Hawkes sites - the corporate site (hawkesbiomedicalnew, its brand rules), I Can Be (icanbeaiwebsite, day.config.js), Imagine Live TV (imaginelivetvwebsite, The Final Spark branches and the blog). Use for tasks on those three.
---
# The static sites how-to

All three are served by GitHub Pages from main as committed (no build on GitHub). Read each repo's `AGENTS.md`.

## The corporate site (`hawkesbiomedicalnew`, hawkesbiomedical.com)

- Static HTML + Vite for dev (port 5174). Pages: index, company, products, leadership, contact, 404.
- **Brand rules:** public cast only (Pierce Hawkes, Director Hale, Voss, Lang; no first names). Category ownership,
  never a cure. Never B3, the vat, the creature or gameplay. Products are "medical products", never games. The footer
  says the company is fictional. Images: daylight low-poly, never the night city.
- Adding a product: a row in `products.html`, then its `AGENTS.md` / `README.md` lists and the projects map.

## I Can Be (`icanbeaiwebsite`, icanbe.ai)

- Vite + Babylon.js 7 from a CDN (port 8092). A real-time day in a developer's life; the character is "AI". The day is
  `day.config.js` (spots, steps with `go`/`at`/`drive`/`pose`, lines). Its version stamp is `deploy.prebuild`
  (`bump-version.bat`), committed to beta by `studio beta icanbe`.
- Its direction is undecided: build what J asks; don't invent a direction.

## Imagine Live TV (`imaginelivetvwebsite`, imaginelivetv.com)

- Vite static site (port 8090): The Final Spark, a choose-your-path video story with one folder per branch (each choice
  is a page with a video), plus a blog. The tree is `TheFinalSpark/Decision tree.txt`; planning notes in
  `TheFinalSpark/`. Videos are generated through Hawkes Gen.
- Playtests: `js/` has the contract helper copy.
