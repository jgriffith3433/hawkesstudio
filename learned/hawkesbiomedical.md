# Learned: Hawkes Biomedical

Generated from Hawkes Studio's shared memory (2026-10-17 02:31 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **Adding the tags to another page**: put them right after <title>, then add the page's name and og:url to SHARE_URLS in site/playtest.js and call checkShareTags on that page's frame doc (footer pages are visited only in the full `products` scenario).  
  <sub>m_44940b34d978 · agent c_555c63d37e60 · 2026-10-16 · https://github.com/jgriffith3433/hawkesbiomedical/pull/3</sub>
- **Corporate site playtest**: site/playtest.js on index.html drives runs from the home page and opens other pages in a full-screen iframe by clicking real nav/footer links (a page load would end the run); scenarios smoke and products.  
  <sub>m_eff44a20b23a · agent c_9612b8758163 · 2026-10-16 · item i_e697ccead74a · https://github.com/jgriffith3433/hawkesbiomedical/pull/2</sub>
- **DoD art for corporate thumbnails**: characters/img/*.png are transparent cutouts; stages/<name>/reference.webp are 1376x768 backdrops (desert, solar-array, rainbow-full-pipe, yo-house are daylight; city-top is night city, banned on the corporate site; site/img/lineup is on black, so too dark for the gate).  
  <sub>m_7af2686e3e81 · agent c_8c6aaffd4d1a · 2026-10-16 · https://github.com/jgriffith3433/hawkesbiomedical/pull/5</sub>
- **Formulation line**: products.html's formulation line is built by site/formulations.js from each product's live releases.json and links to its whatsnew.html; products not yet live (404) show 'Formulation pending'.  
  <sub>m_183c2ff754bb · agent c_76b6a909a674 · 2026-10-17 · https://github.com/jgriffith3433/hawkesbiomedical/pull/6</sub>
- **Link-preview tags**: og:title and og:description are copied verbatim from the page's <title> and meta description (keep them in sync when either changes); og:url is the live https://hawkesbiomedical.com/<page>.html, but Home uses https://hawkesbiomedical.com/ (not /index.html).  
  <sub>m_a35f8d47ba82 · agent c_555c63d37e60 · 2026-10-16 · https://github.com/jgriffith3433/hawkesbiomedical/pull/3</sub>

## Lessons (what broke, and the fix)

- **Darkness check needs perceptual lightness**: linear WCAG luminance flagged Sick Of It's daylight pixel art as dark (0.22); gamma-encoded luma (0.299r+0.587g+0.114b) gives 0.42 and still catches truly dark images.  
  <sub>m_eda312ecfcbf · agent c_9612b8758163 · 2026-10-16 · item i_e697ccead74a · https://github.com/jgriffith3433/hawkesbiomedical/pull/2</sub>
- **No PIL or ImageMagick on the control server**: use ffmpeg for crops and composites (overlay of the RGBA cutouts in doseofdestructionwebsite/characters/img/, -frames:v 1 when a lavfi color source is an input, or it never ends).  
  <sub>m_1ea36090181b · agent c_8c6aaffd4d1a · 2026-10-16 · https://github.com/jgriffith3433/hawkesbiomedical/pull/5</sub>
- **No browser on the control server for playtests**: Playwright is in hawkesgen/node_modules but has no Chromium downloaded; to check the tags without one, pull checkShareTags out of site/playtest.js and run it against the HTML with a small querySelector/title shim.  
  <sub>m_324cf79829e0 · agent c_f7959534b43c · 2026-10-16 · https://github.com/jgriffith3433/hawkesbiomedical/pull/4</sub>
- **No pages.yml here**: GitHub Pages serves the repo root as-is (vite.config.js inputs don't matter for live; whatsnew.html isn't in them), so test against the raw files, not dist/.  
  <sub>m_b5ab1db28e8f · agent c_9612b8758163 · 2026-10-16 · item i_e697ccead74a · https://github.com/jgriffith3433/hawkesbiomedical/pull/2</sub>
- **Product thumbnails are square crops**: .product-shot img is aspect-ratio 1 with object-fit cover, so a 1600x900 image loses its sides; draw product art at 900x900.  
  <sub>m_31b8fec3a513 · agent c_9612b8758163 · 2026-10-16 · item i_e697ccead74a · https://github.com/jgriffith3433/hawkesbiomedical/pull/2</sub>
