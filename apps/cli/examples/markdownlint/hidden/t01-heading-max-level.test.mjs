// Sealed acceptance tests for task t01-heading-max-level (rule MD061).
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

const RULE = "MD061";
const ALIAS = "heading-max-level";
const DESCRIPTION = "Heading level should not exceed the maximum";
const TAGS = [ "headings" ];
const PARAMETERS = [ "maximum" ];

// ---------------------------------------------------------------------------
// Helpers (Node built-ins and the repository's own files only)

const repoPath = (...parts) => path.join(REPO, ...parts);
const readText = (...parts) => fs.readFileSync(repoPath(...parts), "utf8");
const importRepo = (relative) => import(pathToFileURL(repoPath(relative)).href);

const { lint } = await importRepo("lib/exports-sync.mjs");
const { "default": rules } = await importRepo("lib/rules.mjs");

const findRule = () => rules.find((rule) => rule.names[0] === RULE);

const byLineThenRest = (a, b) => (a[0] - b[0]) || JSON.stringify(a).localeCompare(JSON.stringify(b));

// Lints one string with only this rule enabled (under `key`) and returns the
// errors as [lineNumber, errorDetail] pairs, sorted.
function check(markdown, ruleConfig = true, key = RULE) {
  assert.ok(findRule(), `${RULE} is not registered in lib/rules.mjs`);
  const results = lint({
    "strings": { "doc": markdown },
    "config": { "default": false, [key]: ruleConfig }
  });
  return results.doc.map((error) => [ error.lineNumber, error.errorDetail ]).sort(byLineThenRest);
}

const md = (...lines) => lines.join("\n");

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
const minimumOf = (property) => property.minimum ??
  ((property.exclusiveMinimum === undefined) ? undefined : Math.floor(property.exclusiveMinimum) + 1);
const maximumOf = (property) => property.maximum ??
  ((property.exclusiveMaximum === undefined) ? undefined : Math.ceil(property.exclusiveMaximum) - 1);

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

test("MD061 is registered with its names, description and tags", () => {
  const rule = findRule();
  assert.ok(rule, `${RULE} is not registered in lib/rules.mjs`);
  assert.deepEqual([ ...rule.names ], [ RULE, ALIAS ]);
  assert.equal(rule.description, DESCRIPTION);
  assert.deepEqual([ ...rule.tags ].toSorted(), [ ...TAGS ].toSorted());
});

// ---------------------------------------------------------------------------
// Behavior

const allLevels = md(
  "# One",
  "",
  "## Two",
  "",
  "### Three",
  "",
  "#### Four",
  "",
  "##### Five",
  "",
  "###### Six",
  "",
  "Setext two",
  "----------",
  ""
);

test("with the default maximum nothing is reported", () => {
  assert.deepEqual(check(allLevels), []);
  assert.deepEqual(check(allLevels, {}), []);
  assert.deepEqual(check(allLevels, { "maximum": 6 }), []);
});

test("ATX headings deeper than maximum are reported on their line with the detail", () => {
  const markdown = md(
    "# One",
    "",
    "## Two",
    "",
    "### Three",
    "",
    "#### Four",
    "",
    "##### Five #####",
    "",
    "###### Six",
    "",
    "### Three again",
    ""
  );
  assert.deepEqual(check(markdown, { "maximum": 3 }), [
    [ 7, "Expected: h3; Actual: h4" ],
    [ 9, "Expected: h3; Actual: h5" ],
    [ 11, "Expected: h3; Actual: h6" ]
  ]);
  assert.deepEqual(check(markdown, { "maximum": 5 }), [
    [ 11, "Expected: h5; Actual: h6" ]
  ]);
  assert.deepEqual(check(markdown, { "maximum": 1 }), [
    [ 3, "Expected: h1; Actual: h2" ],
    [ 5, "Expected: h1; Actual: h3" ],
    [ 7, "Expected: h1; Actual: h4" ],
    [ 9, "Expected: h1; Actual: h5" ],
    [ 11, "Expected: h1; Actual: h6" ],
    [ 13, "Expected: h1; Actual: h3" ]
  ]);
});

test("setext headings deeper than maximum are reported on their first line", () => {
  const markdown = md(
    "Title",
    "=====",
    "",
    "Section",
    "-------",
    "",
    "A heading on",
    "two lines",
    "---------",
    ""
  );
  assert.deepEqual(check(markdown, { "maximum": 1 }), [
    [ 4, "Expected: h1; Actual: h2" ],
    [ 7, "Expected: h1; Actual: h2" ]
  ]);
  assert.deepEqual(check(markdown, { "maximum": 2 }), []);
});

test("headings inside block quotes and lists are checked too", () => {
  const markdown = md(
    "# Title",
    "",
    "> #### Quoted heading",
    "",
    "- ##### Heading in a list item",
    ""
  );
  assert.deepEqual(check(markdown, { "maximum": 3 }), [
    [ 3, "Expected: h3; Actual: h4" ],
    [ 5, "Expected: h3; Actual: h5" ]
  ]);
});

test("text that is not a heading is not reported", () => {
  const markdown = md(
    "# Title",
    "",
    "```markdown",
    "#### Not a heading",
    "```",
    "",
    "    ##### Not a heading either",
    "",
    "#hashtag is a paragraph",
    ""
  );
  assert.deepEqual(check(markdown, { "maximum": 1 }), []);
});

test("the alias works as a configuration key", () => {
  assert.deepEqual(check(allLevels, { "maximum": 4 }, ALIAS), [
    [ 9, "Expected: h4; Actual: h5" ],
    [ 11, "Expected: h4; Actual: h6" ]
  ]);
  assert.deepEqual(check(allLevels, true, ALIAS), []);
});

// ---------------------------------------------------------------------------
// Configuration schema and generated declarations

test("the config schema declares MD061 and its alias with the maximum parameter", () => {
  for (const key of [ RULE, ALIAS ]) {
    const parameters = schemaParameters(key);
    const names = Object.keys(parameters).filter((name) => (name !== "enabled") && (name !== "severity"));
    assert.deepEqual(names.toSorted(), [ ...PARAMETERS ].toSorted(), `parameters of "${key}"`);
    const maximum = parameters.maximum;
    assert.deepEqual(typesOf(maximum), [ "integer" ], `type of ${key}.maximum`);
    assert.equal(maximum.default, 6, `default of ${key}.maximum`);
    assert.equal(minimumOf(maximum), 1, `minimum of ${key}.maximum`);
    assert.equal(maximumOf(maximum), 6, `maximum of ${key}.maximum`);
  }
});

test("lib/configuration-strict.d.ts declares MD061, its alias and the maximum parameter", () => {
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
  const source = path.join(docsSourceFolder(), "md061.md");
  assert.ok(fs.existsSync(source), `missing ${source}`);
  assert.ok(fs.readFileSync(source, "utf8").trim().length > 0, `${source} is empty`);
});

test("doc/md061.md exists and mentions the alias and the parameter", () => {
  const doc = readText("doc", "md061.md");
  assert.ok(doc.includes(ALIAS), "doc/md061.md does not mention the alias");
  for (const parameter of PARAMETERS) {
    assert.ok(doc.includes(`\`${parameter}\``), `doc/md061.md does not mention \`${parameter}\``);
  }
});

test("doc/Rules.md has the rule's section", () => {
  const lines = readText("doc", "Rules.md").split(/\r?\n/).map((line) => line.trimEnd());
  assert.ok(lines.includes(`## \`${RULE}\` - ${DESCRIPTION}`), "doc/Rules.md has no section for MD061");
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
