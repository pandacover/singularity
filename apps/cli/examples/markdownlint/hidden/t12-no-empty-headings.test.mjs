// Sealed acceptance tests for task t12-no-empty-headings (rule MD066).
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

const RULE = "MD066";
const ALIAS = "no-empty-headings";
const DESCRIPTION = "Headings should not be empty";
const TAGS = [ "headings" ];

// ---------------------------------------------------------------------------
// Helpers (Node built-ins and the repository's own files only)

const repoPath = (...parts) => path.join(REPO, ...parts);
const readText = (...parts) => fs.readFileSync(repoPath(...parts), "utf8");
const importRepo = (relative) => import(pathToFileURL(repoPath(relative)).href);

const { lint } = await importRepo("lib/exports-sync.mjs");
const { "default": rules } = await importRepo("lib/rules.mjs");

const findRule = () => rules.find((rule) => rule.names[0] === RULE);

// Lints one string with only this rule enabled (under `key`) and returns the
// line numbers of the errors, sorted.
function check(markdown, ruleConfig = true, key = RULE) {
  assert.ok(findRule(), `${RULE} is not registered in lib/rules.mjs`);
  const results = lint({
    "strings": { "doc": markdown },
    "config": { "default": false, [key]: ruleConfig }
  });
  return results.doc.map((error) => error.lineNumber).sort((a, b) => a - b);
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

test("MD066 is registered with its names, description and tags", () => {
  const rule = findRule();
  assert.ok(rule, `${RULE} is not registered in lib/rules.mjs`);
  assert.deepEqual([ ...rule.names ], [ RULE, ALIAS ]);
  assert.equal(rule.description, DESCRIPTION);
  assert.deepEqual([ ...rule.tags ].toSorted(), [ ...TAGS ].toSorted());
});

// ---------------------------------------------------------------------------
// Behavior

const emptyHeadings = md(
  "# Title",
  "",
  "#",
  "",
  "## ",
  "",
  "# #",
  "",
  "### ###",
  "",
  "######",
  "",
  "Text",
  ""
);

test("ATX headings without text are reported on their line", () => {
  assert.deepEqual(check(emptyHeadings), [ 3, 5, 7, 9, 11 ]);
});

test("headings with text are not reported", () => {
  const markdown = md(
    "# Heading",
    "",
    "## Closed heading ##",
    "",
    "### `code`",
    "",
    "#### *emphasis*",
    "",
    "Setext heading",
    "==============",
    "",
    "Another setext heading",
    "----------------------",
    ""
  );
  assert.deepEqual(check(markdown), []);
});

test("text that is not an ATX heading is not reported", () => {
  const markdown = md(
    "# Title",
    "",
    "#hashtag",
    "",
    "\\#",
    "",
    "#######",
    "",
    "```markdown",
    "#",
    "```",
    "",
    "    ##",
    ""
  );
  assert.deepEqual(check(markdown), []);
});

test("empty headings inside block quotes and lists are reported", () => {
  const markdown = md(
    "> #",
    "",
    "- ##",
    "",
    "1. ### ###",
    ""
  );
  assert.deepEqual(check(markdown), [ 1, 3, 5 ]);
});

test("the alias works as a configuration key", () => {
  assert.deepEqual(check(emptyHeadings, true, ALIAS), [ 3, 5, 7, 9, 11 ]);
  assert.deepEqual(check(emptyHeadings, false, ALIAS), []);
});

// ---------------------------------------------------------------------------
// Configuration schema and generated declarations

test("the config schema declares MD066 and its alias, with no parameters", () => {
  for (const key of [ RULE, ALIAS ]) {
    const parameters = schemaParameters(key);
    const names = Object.keys(parameters).filter((name) => (name !== "enabled") && (name !== "severity"));
    assert.deepEqual(names, [], `parameters of "${key}"`);
  }
});

test("lib/configuration-strict.d.ts declares MD066 and its alias", () => {
  const declarations = readText("lib", "configuration-strict.d.ts");
  for (const key of [ RULE, ALIAS ]) {
    assert.ok(declarationOf(declarations, key), `configuration-strict.d.ts does not declare "${key}"`);
  }
});

// ---------------------------------------------------------------------------
// Documentation

test("the rule's documentation source is in the docs source folder", () => {
  const source = path.join(docsSourceFolder(), "md066.md");
  assert.ok(fs.existsSync(source), `missing ${source}`);
  assert.ok(fs.readFileSync(source, "utf8").trim().length > 0, `${source} is empty`);
});

test("doc/md066.md exists and mentions the alias", () => {
  const doc = readText("doc", "md066.md");
  assert.ok(doc.includes(ALIAS), "doc/md066.md does not mention the alias");
});

test("doc/Rules.md has the rule's section", () => {
  const lines = readText("doc", "Rules.md").split(/\r?\n/).map((line) => line.trimEnd());
  assert.ok(lines.includes(`## \`${RULE}\` - ${DESCRIPTION}`), "doc/Rules.md has no section for MD066");
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
