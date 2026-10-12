// Sealed acceptance tests for t03-md024-ignore-case: MD024 gets a boolean
// parameter `ignore_case` (default false); with it, headings whose text
// differs only in letter case are duplicates, also with `siblings_only`.
// Errors stay as today: on the duplicate's line, its text as the context.
//
// Run: REPO=<absolute repository root> node --test <this file>

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.env.REPO;
assert.ok(REPO && path.isAbsolute(REPO), "Set REPO to the absolute path of the repository root");
const repoPath = (...parts) => path.join(REPO, ...parts);
const importRepo = (relativePath) => import(pathToFileURL(repoPath(relativePath)).href);
const readText = (relativePath) => fs.readFileSync(repoPath(relativePath), "utf8").replace(/\r\n/g, "\n");

const { lint } = await importRepo("lib/exports-sync.mjs");

// MD024 alone on one document: [{ line, context }] per error.
function md024(markdown, ruleConfig = true) {
  const results = lint({
    "strings": { "doc": markdown },
    "config": { "default": false, "MD024": ruleConfig }
  });
  return results.doc.map((error) => ({ "line": error.lineNumber, "context": error.errorContext }));
}

const lines = (...items) => items.join("\n") + "\n";

test("without ignore_case, headings that differ only in case are not duplicates", () => {
  const markdown = lines("# Install", "", "## install", "", "## INSTALL");
  assert.deepEqual(md024(markdown), []);
  assert.deepEqual(md024(markdown, {}), []);
  assert.deepEqual(md024(markdown, { "ignore_case": false }), []);
});

test("without ignore_case, exact duplicates are reported as before", () => {
  const markdown = lines("# Install", "", "## Install");
  assert.deepEqual(md024(markdown), [ { "line": 3, "context": "Install" } ]);
  assert.deepEqual(md024(markdown, { "ignore_case": false }), [ { "line": 3, "context": "Install" } ]);
});

test("ignore_case: headings that differ only in letter case are duplicates", () => {
  assert.deepEqual(
    md024(lines("# Install", "", "## install"), { "ignore_case": true }),
    [ { "line": 3, "context": "install" } ]
  );
  assert.deepEqual(
    md024(lines("# Install", "", "## INSTALL", "", "### InStAlL"), { "ignore_case": true }),
    [ { "line": 3, "context": "INSTALL" }, { "line": 5, "context": "InStAlL" } ]
  );
  assert.deepEqual(
    md024(lines("# Setup", "", "## Usage", "", "## SETUP", "", "## usage", "", "## Other"), { "ignore_case": true }),
    [ { "line": 5, "context": "SETUP" }, { "line": 7, "context": "usage" } ]
  );
});

test("ignore_case: closed ATX and setext headings", () => {
  assert.deepEqual(
    md024(lines("# Install", "", "## INSTALL ##"), { "ignore_case": true }),
    [ { "line": 3, "context": "INSTALL" } ]
  );
  const setext = lines("Getting Started", "===============", "", "GETTING STARTED", "---------------");
  assert.deepEqual(md024(setext, { "ignore_case": true }), [ { "line": 4, "context": "GETTING STARTED" } ]);
  assert.deepEqual(md024(setext), []);
});

test("ignore_case: exact duplicates are still reported, different text is not", () => {
  assert.deepEqual(
    md024(lines("# Usage", "", "## Usage"), { "ignore_case": true }),
    [ { "line": 3, "context": "Usage" } ]
  );
  assert.deepEqual(
    md024(lines("# Install", "", "## Installation", "", "## Installer", "", "## Usage"), { "ignore_case": true }),
    []
  );
});

test("ignore_case with siblings_only: only sibling headings are compared", () => {
  const changelog = lines(
    "# Change log",
    "",
    "## 1.0.0",
    "",
    "### Features",
    "",
    "## 2.0.0",
    "",
    "### features"
  );
  assert.deepEqual(md024(changelog, { "siblings_only": true, "ignore_case": true }), []);
  assert.deepEqual(md024(changelog, { "ignore_case": true }), [ { "line": 9, "context": "features" } ]);
  assert.deepEqual(md024(changelog, { "siblings_only": true }), []);

  const siblings = lines(
    "# Change log",
    "",
    "## Version 1",
    "",
    "### Features",
    "",
    "### FEATURES",
    "",
    "## version 1"
  );
  assert.deepEqual(
    md024(siblings, { "siblings_only": true, "ignore_case": true }),
    [ { "line": 7, "context": "FEATURES" }, { "line": 9, "context": "version 1" } ]
  );
  assert.deepEqual(md024(siblings, { "siblings_only": true }), []);
  assert.deepEqual(md024(siblings, { "siblings_only": true, "ignore_case": false }), []);
});

test("config schema declares ignore_case for MD024 (boolean, default false)", () => {
  const schema = JSON.parse(readText("schema/markdownlint-config-schema.json"));
  const rule = schema.properties.MD024;
  assert.ok(rule && Array.isArray(rule.oneOf), "MD024 is in the schema");
  const variant = rule.oneOf.find((item) => item && item.properties);
  assert.ok(variant, "MD024 has an object variant with properties");
  const parameter = variant.properties.ignore_case;
  assert.ok(parameter, "MD024's object variant declares ignore_case");
  assert.deepEqual([ parameter.type ].flat(), [ "boolean" ]);
  assert.equal(parameter.default, false);
});

// The text of one top-level property in lib/configuration-strict.d.ts, from
// its key to the doc comment of the next property.
function declarationOf(declarations, key) {
  const start = declarations.indexOf(`\n  ${key}?:`);
  assert.notEqual(start, -1, `${key} is declared in lib/configuration-strict.d.ts`);
  const end = declarations.indexOf("\n  /**", start + 1);
  return declarations.slice(start, (end === -1) ? undefined : end);
}

test("lib/configuration-strict.d.ts declares ignore_case for MD024", () => {
  const declarations = readText("lib/configuration-strict.d.ts");
  assert.match(declarationOf(declarations, "MD024"), /\bignore_case\?:/);
});

test("the generated MD024 documentation mentions ignore_case", () => {
  assert.ok(readText("doc/md024.md").includes("`ignore_case`"), "doc/md024.md mentions `ignore_case`");
});
