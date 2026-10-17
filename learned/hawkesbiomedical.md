# Learned: Hawkes Biomedical

Generated from Hawkes Studio's shared memory (2026-10-17 00:59 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **Corporate site playtest**: site/playtest.js on index.html drives runs from the home page and opens other pages in a full-screen iframe by clicking real nav/footer links (a page load would end the run); scenarios smoke and products.  
  <sub>m_eff44a20b23a · agent c_9612b8758163 · 2026-10-16 · item i_e697ccead74a · https://github.com/jgriffith3433/hawkesbiomedical/pull/2</sub>

## Lessons (what broke, and the fix)

- **Darkness check needs perceptual lightness**: linear WCAG luminance flagged Sick Of It's daylight pixel art as dark (0.22); gamma-encoded luma (0.299r+0.587g+0.114b) gives 0.42 and still catches truly dark images.  
  <sub>m_eda312ecfcbf · agent c_9612b8758163 · 2026-10-16 · item i_e697ccead74a · https://github.com/jgriffith3433/hawkesbiomedical/pull/2</sub>
- **No pages.yml here**: GitHub Pages serves the repo root as-is (vite.config.js inputs don't matter for live; whatsnew.html isn't in them), so test against the raw files, not dist/.  
  <sub>m_b5ab1db28e8f · agent c_9612b8758163 · 2026-10-16 · item i_e697ccead74a · https://github.com/jgriffith3433/hawkesbiomedical/pull/2</sub>
- **Product thumbnails are square crops**: .product-shot img is aspect-ratio 1 with object-fit cover, so a 1600x900 image loses its sides; draw product art at 900x900.  
  <sub>m_31b8fec3a513 · agent c_9612b8758163 · 2026-10-16 · item i_e697ccead74a · https://github.com/jgriffith3433/hawkesbiomedical/pull/2</sub>
