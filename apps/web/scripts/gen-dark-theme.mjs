// Generates app/theme-dark.css from app/globals.css.
//
// The stylesheet writes its colours as literals, so the dark theme is derived from it rather
// than kept by hand: every declaration that carries a colour is re-emitted under
// :root[data-theme='dark'] with the colour mapped by the role of its property.
//   - Text (color, fill): dark text turns light; saturated text keeps its hue, lifted until it
//     reads on a dark ground. Text that is already light stays.
//   - Surfaces (background, border, stroke, shadow): light surfaces turn into dark slate in the
//     same order of lightness; saturated fills (buttons, statuses, brand) and surfaces that are
//     already dark (sidebar, TV board) stay.
//   - Faint overlays (alpha below 0.25) stay: they read on either ground.
// The output sits inside @media screen, so printing keeps the light layout.
// Run: node scripts/gen-dark-theme.mjs  (the web build and dev scripts run it first).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'app/globals.css'), 'utf8');
const DARK = ":root[data-theme='dark']";
const SKIPPED_AT_RULES = /^@(keyframes|-webkit-keyframes|font-face|page|import|charset)\b/;
const TEXT_PROPERTIES = /^(color|fill|caret-color|-webkit-text-fill-color|text-decoration-color)$/;
const SURFACE_PROPERTIES =
  /^(background|background-color|background-image|border|border-(top|right|bottom|left|block|inline)(-color)?|border-color|outline|outline-color|box-shadow|stroke|column-rule|column-rule-color)$/;
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(white|black)\b/gi;

// ---------- Parsing: rules and block at-rules, comments and strings respected ----------
function parse(text) {
  const nodes = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      text = text.slice(0, i) + text.slice(end + 2);
      continue;
    }
    if (char === '"' || char === "'") {
      i = text.indexOf(char, i + 1) + 1;
      continue;
    }
    if (char === ';') {
      start = i + 1; // statement at-rule such as @import
    } else if (char === '{') {
      const prelude = text.slice(start, i).trim();
      const end = matching(text, i);
      const body = text.slice(i + 1, end);
      if (prelude.startsWith('@')) nodes.push({ type: 'at', prelude, children: parse(body) });
      else nodes.push({ type: 'rule', prelude, body });
      i = end + 1;
      start = i;
      continue;
    }
    i += 1;
  }
  return nodes;
}

function matching(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' || char === "'") i = text.indexOf(char, i + 1);
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return i;
  }
  throw new Error(`chave sem par na posição ${open}`);
}

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// ---------- Colour ----------
function parseColor(token) {
  const lower = token.toLowerCase();
  if (lower === 'white') return [255, 255, 255, 1];
  if (lower === 'black') return [0, 0, 0, 1];
  if (lower.startsWith('#')) {
    let hex = lower.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)).concat(alpha);
  }
  const parts = lower
    .replace(/^rgba?\(/, '')
    .replace(/\)$/, '')
    .split(/[\s,/]+/)
    .filter(Boolean);
  if (parts.length < 3 || parts.some((part) => part.startsWith('var'))) return null;
  const channel = (value) => (value.endsWith('%') ? (parseFloat(value) * 255) / 100 : +value);
  const alpha =
    parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : +parts[3];
  return [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
}

function toHsl([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function toRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function format([r, g, b], alpha) {
  if (alpha < 1) return `rgba(${r}, ${g}, ${b}, ${+alpha.toFixed(3)})`;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
// Neutral greys lean to the platform's slate teal so the dark ground matches the sidebar.
const SLATE_HUE = 195;

function mapText(rgba) {
  const [h, s, l] = toHsl(rgba);
  if (l >= 0.6) return null;
  // Near-black ink (navy, deep slate) is body text whatever its tint: it becomes light ink.
  if (s > 0.35 && l > 0.22)
    return format(toRgb(h, s * 0.85, clamp(1 - l * 0.6, 0.6, 0.7)), rgba[3]);
  return format(toRgb(SLATE_HUE, Math.min(s, 0.15), clamp(0.97 - l * 0.75, 0.5, 0.95)), rgba[3]);
}

function mapSurface(rgba) {
  const [h, s, l] = toHsl(rgba);
  if (l <= 0.45 || (s > 0.45 && l < 0.7)) return null;
  const tinted = s > 0.3;
  return format(
    toRgb(tinted ? h : SLATE_HUE, tinted ? s * 0.5 : 0.22, clamp(0.09 + (1 - l) * 0.78, 0.09, 0.4)),
    rgba[3],
  );
}

function mapValue(value, mapper) {
  let changed = false;
  const mapped = value.replace(COLOR, (token) => {
    const rgba = parseColor(token);
    if (!rgba || rgba[3] < 0.25) return token;
    const next = mapper(rgba);
    if (!next) return token;
    changed = true;
    return next;
  });
  return changed ? mapped : null;
}

// ---------- Emitting ----------
function darkSelector(selector) {
  if (selector.startsWith(':root')) return DARK + selector.slice(5);
  if (/^html\b/.test(selector)) return DARK + selector.slice(4);
  return `${DARK} ${selector}`;
}

function emit(nodes, indent) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'at') {
      if (SKIPPED_AT_RULES.test(node.prelude) || /^@media\s+print\b/.test(node.prelude)) continue;
      const inner = emit(node.children, indent + '  ');
      if (inner.length) out.push(`${indent}${node.prelude} {`, ...inner, `${indent}}`);
      continue;
    }
    // Every colour declaration of a rule is re-emitted, changed or not. Each dark rule gains the
    // same extra specificity, so re-emitting only the changed ones would let a generic rule
    // (button { background: white } turned dark) beat a specific one it used to lose to
    // (.primary-button { background: teal }, or a link-button's transparent ground).
    const declarations = [];
    for (const declaration of splitTopLevel(node.body, ';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      const mapper = TEXT_PROPERTIES.test(property)
        ? mapText
        : SURFACE_PROPERTIES.test(property)
          ? mapSurface
          : null;
      if (!mapper) continue;
      declarations.push(`${indent}  ${property}: ${mapValue(value, mapper) ?? value};`);
    }
    if (!declarations.length) continue;
    const selectors = splitTopLevel(node.prelude, ',').map(darkSelector);
    out.push(`${indent}${selectors.join(`,\n${indent}`)} {`, ...declarations, `${indent}}`);
  }
  return out;
}

const body = emit(parse(source), '  ');
writeFileSync(
  join(root, 'app/theme-dark.css'),
  [
    '/* Generated by scripts/gen-dark-theme.mjs from globals.css. Do not edit by hand:',
    '   change globals.css or the generator, then run it again. */',
    '@media screen {',
    ...body,
    '}',
    '',
  ].join('\n'),
);
console.log(`theme-dark.css: ${body.filter((line) => line.endsWith('{')).length} blocos`);
