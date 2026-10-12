// Sealed acceptance tests for task t10-ol-delimiter-style (rule MD065).
// Run with the repository root in REPO: REPO=/path/to/markdownlint node --test <this file>
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.env.REPO;
if (!REPO) {
  throw new Error("Set REPO to the absolute path of the repository root.");
}

const RULE = "MD065";
const ALIAS = "ol-delimiter-style";
const DESCRIPTION = "Ordered list delimiter style";
const TAGS = [ "ol" ];
const PARAMETERS = [ "style" ];

// ---------------------------------------------------------------------------
// Helpers (Node built-ins and the repository's own files only)

const repoPath = (...parts) => path.join(REPO, ...parts);
const readText = (...parts) => fs.readFileSync(repoPath(...parts), "utf8");
const importRepo = (relative) => import(pathToFileURL(repoPath(relative)).href);

const { lint } = await importRepo("lib/exports-sync.mjs");
const { applyFixes } = await importRepo("lib/exports.mjs");
const { "default": rules } = await importRepo("lib/rules.mjs");
const { fixableRuleNames } = await importRepo("lib/constants.mjs");

const findRule = () => rules.find((rule) => rule.names[0] === RULE);

const byLineThenRest = (a, b) => (a[0] - b[0]) || JSON.stringify(a).localeCompare(JSON.stringify(b));

function lintErrors(markdown, ruleConfig, key) {
  assert.ok(findRule(), `${RULE} is not registered in lib/rules.mjs`);
  const results = lint({
    "strings": { "doc": markdown },
    "config": { "default": false, [key]: ruleConfig }
  });
  return results.doc;
}

// Lints one string with only this rule enabled (under `key`) and returns the
// errors as [lineNumber, errorDetail, errorRange] triples, sorted.
function check(markdown, ruleConfig = true, key = RULE) {
  return lintErrors(markdown, ruleConfig, key)
    .map((error) => [ error.lineNumber, error.errorDetail, error.errorRange ])
    .sort(byLineThenRest);
}

// Lints one string with only this rule enabled and applies the fixes.
function fix(markdown, ruleConfig = true, key = RULE) {
  return applyFixes(markdown, lintErrors(markdown, ruleConfig, key));
}

const md = (...lines) => lines.join("\n");

const periodExpected = "Expected: period; Actual: parenthesis";
const parenthesisExpected = "Expected: parenthesis; Actual: period";

function schemaParameters(key) {
  const schema = JSON.parse(readText("schema", "markdownlint-config-schema.json"));
  let entry = schema.properties && schema.properties[key];
  assert.ok(entry, `schema/markdownlint-config-schema.json has no property "${key}"`);
  if (entry.$ref) {
    entry = entry.$ref.replace(/^#\//, "").split("/").reduce((node, part) => node[part], schema);
  }
  const variants = [ ...(entry.oneOf || []), ...(entry.anyOf || []) ];
  const objectVariant = variants.find((variant) => variant && variant.properties);
  assert.ok(objectVariant, `schema property "${key}" has no object variant with properties`);
  return objectVariant.properties;
}
const typesOf = (property) => [ property.type ].flat().toSorted();

// The part of configuration-strict.d.ts that declares one property.
function declarationOf(declarations, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const match = new RegExp(`^ {2}["']?${escaped}["']?\\??:`, "m").exec(declarations);
  if (!match) {
    return null;
  }
  const rest = declarations.slice(match.index + match[0].length);
  const end = rest.search(/^ {2}\S/m);
  return (end === -1) ? rest : rest.slice(0, end);
}

// The folder the docs are generated from, read from the build-docs script.
function docsSourceFolder() {
  const packageJson = JSON.parse(readText("package.json"));
  const script = packageJson.scripts && packageJson.scripts["build-docs"];
  assert.equal(typeof script, "string", "package.json has no build-docs script");
  const cd = /(?:^|&&|;)\s*cd\s+(["']?)([^"'\s&;]+)\1/.exec(script);
  const file = script.split(/\s+/).map((token) => token.replace(/^["']|["']$/g, "")).find((token) => /\.[cm]?[jt]s$/.test(token));
  assert.ok(file, `cannot find the script that build-docs runs in "${script}"`);
  return path.resolve(REPO, cd ? cd[2] : ".", path.dirname(file));
}

// Tag -> set of rule names, from the README's Tags section.
function readmeTags(readme) {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Tags\s*$/.test(line));
  assert.ok(start >= 0, "README.md has no Tags section");
  const texts = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) {
      break;
    }
    const item = /^[-*+]\s+\*\*`([^`]+)`\*\*(.*)$/.exec(line);
    if (item) {
      current = item[1];
      texts.set(current, item[2]);
    } else if (current && /^\s+\S/.test(line)) {
      texts.set(current, `${texts.get(current)} ${line}`);
    } else {
      current = null;
    }
  }
  return new Map([ ...texts ].map(([ tag, text ]) => [ tag, new Set(text.match(/MD\d{3}/g) || []) ]));
}

// ---------------------------------------------------------------------------
// Metadata

test("MD065 is registered with its names, description and tags", () => {
  const rule = findRule();
  assert.ok(rule, `${RULE} is not registered in lib/rules.mjs`);
  assert.deepEqual([ ...rule.names ], [ RULE, ALIAS ]);
  assert.equal(rule.description, DESCRIPTION);
  assert.deepEqual([ ...rule.tags ].toSorted(), [ ...TAGS ].toSorted());
});

test("MD065 is listed with the fixable rules", () => {
  assert.ok([ ...fixableRuleNames ].includes(RULE), "lib/constants.mjs fixableRuleNames lacks MD065");
});

// ---------------------------------------------------------------------------
// Behavior

const periodFirst = md(
  "1. one",
  "2. two",
  "",
  "1) three",
  "2) four",
  "",
  "- bullet",
  "  1) nested",
  "",
  "> 1) quoted",
  ""
);

test("by default the first ordered list item sets the style (period)", () => {
  const expected = [
    [ 4, periodExpected, [ 2, 1 ] ],
    [ 5, periodExpected, [ 2, 1 ] ],
    [ 8, periodExpected, [ 4, 1 ] ],
    [ 10, periodExpected, [ 4, 1 ] ]
  ];
  assert.deepEqual(check(periodFirst), expected);
  assert.deepEqual(check(periodFirst, {}), expected);
  assert.deepEqual(check(periodFirst, { "style": "consistent" }), expected);
});

test("with consistent, the first ordered list item in the document sets the style (parenthesis)", () => {
  const markdown = md(
    "- bullet",
    "  1) nested, and first",
    "",
    "1. top",
    "10. ten",
    "",
    "1) back",
    ""
  );
  assert.deepEqual(check(markdown, { "style": "consistent" }), [
    [ 4, parenthesisExpected, [ 2, 1 ] ],
    [ 5, parenthesisExpected, [ 3, 1 ] ]
  ]);
  assert.deepEqual(check(md("1) a", "2) b", "3) c", "")), []);
  assert.deepEqual(check(md("1. a", "2. b", "3. c", "")), []);
});

const mixed = md(
  "1) one",
  "2) two",
  "",
  "1. three",
  "",
  "10) ten",
  ""
);

test("style period reports every item delimited by a parenthesis", () => {
  assert.deepEqual(check(mixed, { "style": "period" }), [
    [ 1, periodExpected, [ 2, 1 ] ],
    [ 2, periodExpected, [ 2, 1 ] ],
    [ 6, periodExpected, [ 3, 1 ] ]
  ]);
  assert.deepEqual(check(md("1. a", "2. b", ""), { "style": "period" }), []);
});

test("style parenthesis reports every item delimited by a period", () => {
  assert.deepEqual(check(mixed, { "style": "parenthesis" }), [
    [ 4, parenthesisExpected, [ 2, 1 ] ]
  ]);
  assert.deepEqual(check(periodFirst, { "style": "parenthesis" }), [
    [ 1, parenthesisExpected, [ 2, 1 ] ],
    [ 2, parenthesisExpected, [ 2, 1 ] ]
  ]);
});

test("unordered lists are not checked", () => {
  const markdown = md(
    "- dash",
    "",
    "* asterisk",
    "",
    "+ plus",
    ""
  );
  for (const style of [ "consistent", "period", "parenthesis" ]) {
    assert.deepEqual(check(markdown, { style }), [], `style ${style}`);
  }
});

test("fixes replace the delimiter with the expected one", () => {
  const markdown = md(
    "1) one",
    "2) two",
    "",
    "Text",
    "",
    "- item",
    "  1) nested",
    "",
    "> 3) quoted",
    "",
    "10. ten",
    ""
  );
  assert.equal(fix(markdown, { "style": "period" }), md(
    "1. one",
    "2. two",
    "",
    "Text",
    "",
    "- item",
    "  1. nested",
    "",
    "> 3. quoted",
    "",
    "10. ten",
    ""
  ));
  assert.equal(fix(markdown, { "style": "parenthesis" }), md(
    "1) one",
    "2) two",
    "",
    "Text",
    "",
    "- item",
    "  1) nested",
    "",
    "> 3) quoted",
    "",
    "10) ten",
    ""
  ));
  assert.equal(fix(periodFirst), md(
    "1. one",
    "2. two",
    "",
    "1. three",
    "2. four",
    "",
    "- bullet",
    "  1. nested",
    "",
    "> 1. quoted",
    ""
  ));
});

test("the alias works as a configuration key", () => {
  assert.deepEqual(check(mixed, { "style": "parenthesis" }, ALIAS), [
    [ 4, parenthesisExpected, [ 2, 1 ] ]
  ]);
  assert.deepEqual(check(mixed, true, ALIAS), [
    [ 4, parenthesisExpected, [ 2, 1 ] ]
  ]);
});

// ---------------------------------------------------------------------------
// Configuration schema and generated declarations

test("the config schema declares MD065 and its alias with the style parameter", () => {
  for (const key of [ RULE, ALIAS ]) {
    const parameters = schemaParameters(key);
    const names = Object.keys(parameters).filter((name) => (name !== "enabled") && (name !== "severity"));
    assert.deepEqual(names.toSorted(), [ ...PARAMETERS ].toSorted(), `parameters of "${key}"`);
    const { style } = parameters;
    assert.deepEqual(typesOf(style), [ "string" ], `type of ${key}.style`);
    assert.ok(Array.isArray(style.enum), `${key}.style has no enum`);
    assert.deepEqual([ ...style.enum ].toSorted(), [ "consistent", "parenthesis", "period" ], `values of ${key}.style`);
    assert.equal(style.default, "consistent", `default of ${key}.style`);
  }
});

test("lib/configuration-strict.d.ts declares MD065, its alias and the style parameter", () => {
  const declarations = readText("lib", "configuration-strict.d.ts");
  for (const key of [ RULE, ALIAS ]) {
    const declaration = declarationOf(declarations, key);
    assert.ok(declaration, `configuration-strict.d.ts does not declare "${key}"`);
    for (const parameter of PARAMETERS) {
      assert.match(declaration, new RegExp(`\\b${parameter}\\??:`), `"${key}" declaration lacks ${parameter}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Documentation

test("the rule's documentation source is in the docs source folder", () => {
  const source = path.join(docsSourceFolder(), "md065.md");
  assert.ok(fs.existsSync(source), `missing ${source}`);
  assert.ok(fs.readFileSync(source, "utf8").trim().length > 0, `${source} is empty`);
});

test("doc/md065.md exists and mentions the alias and the parameter", () => {
  const doc = readText("doc", "md065.md");
  assert.ok(doc.includes(ALIAS), "doc/md065.md does not mention the alias");
  for (const parameter of PARAMETERS) {
    assert.ok(doc.includes(`\`${parameter}\``), `doc/md065.md does not mention \`${parameter}\``);
  }
});

test("doc/Rules.md has the rule's section", () => {
  const lines = readText("doc", "Rules.md").split(/\r?\n/).map((line) => line.trimEnd());
  assert.ok(lines.includes(`## \`${RULE}\` - ${DESCRIPTION}`), "doc/Rules.md has no section for MD065");
});

test("README lists the rule in the rules list", () => {
  const lines = readText("README.md").split(/\r?\n/).map((line) => line.trimEnd());
  const expected = `- **[${RULE}](doc/${RULE.toLowerCase()}.md)** *${ALIAS}* - ${DESCRIPTION}`;
  assert.ok(lines.includes(expected), `README.md lacks the line: ${expected}`);
});

test("README's Tags section lists the rule under each of its tags", () => {
  const tags = readmeTags(readText("README.md"));
  for (const tag of TAGS) {
    assert.ok(tags.has(tag), `README.md Tags section has no tag ${tag}`);
    assert.ok(tags.get(tag).has(RULE), `README.md tag ${tag} does not list ${RULE}`);
  }
});
