import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const cssPath = path.join(import.meta.dirname, '..', 'dashboard', 'style.css');
const css = fs.readFileSync(cssPath, 'utf8');

const TOKEN_START = '/* ---- Design tokens (dark default + light via prefers-color-scheme) ---- */';
const TOKEN_END = '/* ---- End design tokens ---- */';

function splitTokenBlock(source: string): { tokenBlock: string; rest: string } {
  const startIdx = source.indexOf(TOKEN_START);
  const endIdx = source.indexOf(TOKEN_END);
  assert.ok(startIdx >= 0, 'style.css marks the start of the design token block');
  assert.ok(endIdx > startIdx, 'style.css marks the end of the design token block');
  const tokenBlock = source.slice(startIdx, endIdx + TOKEN_END.length);
  const rest = source.slice(0, startIdx) + source.slice(endIdx + TOKEN_END.length);
  return { tokenBlock, rest };
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function findHexColorsOutsideTokens(source: string): string[] {
  const { rest } = splitTokenBlock(source);
  const uncommented = stripCssComments(rest);
  return uncommented.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
}

function parseTokenMap(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean.slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relLuminance(hexToRgb(hexA));
  const l2 = relLuminance(hexToRgb(hexB));
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

describe('dashboard design tokens in dashboard/style.css', () => {
  it('defines surface, raised surface, border, text, muted text, accent, success, warning, danger, 6-step type scale, 4px spacing scale, radii and shadows on :root', () => {
    const { tokenBlock } = splitTokenBlock(css);
    const requiredTokens = [
      '--surface',
      '--surface-raised',
      '--raised-surface',
      '--border',
      '--text',
      '--text-muted',
      '--muted-text',
      '--accent',
      '--success',
      '--warning',
      '--danger',
      // 6-step type scale
      '--text-xs',
      '--text-sm',
      '--text-md',
      '--text-lg',
      '--text-xl',
      '--text-2xl',
      // 4px spacing scale
      '--space-1',
      '--space-2',
      '--space-3',
      '--space-4',
      '--space-5',
      '--space-6',
      '--space-8',
      '--space-10',
      // radii
      '--radius-xs',
      '--radius-sm',
      '--radius-md',
      '--radius-lg',
      '--radius-xl',
      '--radius-full',
      // shadows
      '--shadow-sm',
      '--shadow-md',
      '--shadow-lg',
    ];
    for (const token of requiredTokens) {
      assert.match(tokenBlock, new RegExp(`${token}\\s*:`), `missing token ${token} in :root token block`);
    }
    assert.match(tokenBlock, /@media\s*\(\s*prefers-color-scheme\s*:\s*light\s*\)/, 'defines light theme tokens via prefers-color-scheme: light');
  });

  it('fails if any hex colour appears outside the design token block', () => {
    const strayHex = findHexColorsOutsideTokens(css);
    assert.deepEqual(
      strayHex,
      [],
      `Found hard-coded hex colour(s) outside the token block in dashboard/style.css: ${strayHex.join(', ')}`
    );

    // Verify the detector catches a new hex colour added outside the token block
    const synthetic = css + '\n.rogue-rule { color: #ff00aa; }\n';
    assert.deepEqual(findHexColorsOutsideTokens(synthetic), ['#ff00aa']);
  });

  it('maintains readable WCAG AA contrast (>= 4.5:1) in both dark and light token palettes', () => {
    const { tokenBlock } = splitTokenBlock(css);
    const lightIdx = tokenBlock.indexOf('@media (prefers-color-scheme: light)');
    assert.ok(lightIdx > 0, 'light media query exists in token block');

    const darkTokens = parseTokenMap(tokenBlock.slice(0, lightIdx));
    const lightTokens = parseTokenMap(tokenBlock.slice(lightIdx));

    for (const [mode, palette] of [
      ['dark', darkTokens],
      ['light', lightTokens],
    ] as const) {
      for (const bgKey of ['--bg', '--surface', '--surface-raised']) {
        for (const fgKey of ['--text', '--text-secondary', '--text-muted', '--accent', '--success', '--warning', '--danger']) {
          const bg = palette[bgKey];
          const fg = palette[fgKey];
          assert.ok(bg && bg.startsWith('#'), `${mode} ${bgKey} is a hex colour`);
          assert.ok(fg && fg.startsWith('#'), `${mode} ${fgKey} is a hex colour`);
          const ratio = contrastRatio(fg, bg);
          assert.ok(
            ratio >= 4.5,
            `${mode} ${fgKey} (${fg}) on ${bgKey} (${bg}) contrast is ${ratio.toFixed(2)}:1 (expected >= 4.5:1)`
          );
        }
      }
    }
  });

  it('orders the 6-step type scale monotonically and keeps the spacing scale on a 4px grid', () => {
    const { tokenBlock } = splitTokenBlock(css);
    const tokens = parseTokenMap(tokenBlock);
    const steps = ['--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-2xl'].map((k) =>
      parseFloat(tokens[k])
    );
    assert.equal(steps.length, 6);
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i] > steps[i - 1], `type scale step ${i} (${steps[i]}px) > step ${i - 1} (${steps[i - 1]}px)`);
    }

    const spaceKeys = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8', '--space-10'];
    for (const k of spaceKeys) {
      const px = parseFloat(tokens[k]);
      assert.ok(px > 0 && px % 4 === 0, `${k} (${tokens[k]}) is a multiple of 4px`);
    }
  });

  it('replaces hard-coded font-size and padding pixel literals outside the token block with var(--...)', () => {
    const { rest } = splitTokenBlock(css);
    const uncommented = stripCssComments(rest);
    const rawFontSizes = uncommented.match(/font-size\s*:\s*[^;]*\d+px/g) || [];
    assert.deepEqual(rawFontSizes, [], `Expected font-size rules to use type scale tokens, found: ${rawFontSizes.join('; ')}`);

    const rawPaddings = (uncommented.match(/padding(?:-(?:top|right|bottom|left))?\s*:\s*[^;{}]+/g) || []).filter(
      (decl) => /\d+px/.test(decl) && !/env\(/.test(decl)
    );
    assert.deepEqual(rawPaddings, [], `Expected padding rules to use spacing scale tokens, found: ${rawPaddings.join('; ')}`);
  });

  it('verifies dark and light theme contrast and the 6-step type scale in dashboard/playtest.js smoke scenario', () => {
    const playtestSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'playtest.js'), 'utf8');
    assert.match(playtestSrc, /verifyThemesAndScale/, 'playtest.js runs verifyThemesAndScale on each tab');
    assert.match(playtestSrc, /data-theme|dataset\.theme/, 'playtest.js toggles dataset.theme between dark and light');
    assert.match(playtestSrc, /--text-2xl/, 'playtest.js checks the 6-step type scale tokens');
    assert.match(playtestSrc, /4\.5/, 'playtest.js enforces the 4.5:1 WCAG AA contrast threshold');
  });
});
