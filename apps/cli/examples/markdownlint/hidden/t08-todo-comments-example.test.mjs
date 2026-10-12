// Sealed acceptance tests for t08-todo-comments-example: an example custom
// rule `todo-comments` in test/rules/todo-comments.cjs (description "Rule that
// reports TODO and FIXME notes", tag `test`) reports every line containing
// TODO or FIXME as an uppercase whole word, once per line, with the error range
// on the first of those words. test/rules/rules.cjs exports it as todoComments
// and in `all`. It is an example, not a built-in rule.
//
// Run: REPO=<absolute repository root> node --test <this file>

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const REPO = process.env.REPO;
assert.ok(REPO && path.isAbsolute(REPO), "Set REPO to the absolute path of the repository root");
const repoPath = (...parts) => path.join(REPO, ...parts);
const importRepo = (relativePath) => import(pathToFileURL(repoPath(relativePath)).href);
const readText = (relativePath) => fs.readFileSync(repoPath(relativePath), "utf8").replace(/\r\n/g, "\n");
const require = createRequire(repoPath("package.json"));

const { lint } = await importRepo("lib/exports-sync.mjs");
const ruleFile = repoPath("test", "rules", "todo-comments.cjs");
const description = "Rule that reports TODO and FIXME notes";
const isTodoRule = (rule) => Boolean(rule) && Array.isArray(rule.names) && rule.names.includes("todo-comments");

// Only needed if the rule asks for the markdown-it parser (the repository's
// own dev dependency, as in its custom rule tests).
let markdownItFactory;
try {
  const markdownIt = require("markdown-it");
  markdownItFactory = () => markdownIt({ "html": true });
} catch {
  markdownItFactory = undefined;
}

const examples = () => require(repoPath("test", "rules", "rules.cjs"));

// The rule alone on one document: [lineNumber, errorRange] per error.
function todoComments(markdown) {
  const options = {
    "strings": { "doc": markdown },
    "config": { "default": false, "todo-comments": true },
    "customRules": [ examples().todoComments ]
  };
  if (markdownItFactory) {
    options.markdownItFactory = markdownItFactory;
  }
  return lint(options).doc.map((error) => [ error.lineNumber, error.errorRange ]);
}

const lines = (...items) => items.join("\n") + "\n";

test("test/rules/todo-comments.cjs defines the rule", () => {
  assert.ok(fs.existsSync(ruleFile), "test/rules/todo-comments.cjs exists");
  const rule = [ require(ruleFile) ].flat().find(isTodoRule);
  assert.ok(rule, "the file exports a rule named todo-comments");
  assert.equal(rule.description, description);
  assert.deepEqual(rule.tags, [ "test" ]);
});

test("test/rules/rules.cjs exports it by name as todoComments and in all", () => {
  const { todoComments: rule, all } = examples();
  assert.ok(isTodoRule(rule), "rules.cjs exports todoComments, named todo-comments");
  assert.equal(rule.description, description);
  assert.deepEqual(rule.tags, [ "test" ]);
  assert.ok(Array.isArray(all), "rules.cjs exports all");
  assert.ok(all.some((item) => (item === rule) || isTodoRule(item)), "all includes todo-comments");
});

test("reports each line with TODO or FIXME as an uppercase whole word, once, on the first one", () => {
  const markdown = lines(
    "# Heading TODO",
    "",
    "Text with todo and Todo and fixme.",
    "TODO: first FIXME second TODO",
    "Fix FIXME then TODO",
    "TODOs XTODO FIXMEs PREFIXME TODOFIXME",
    "A note (FIXME) here.",
    "TODOs first, then TODO.",
    "Check *TODO* and **FIXME** later",
    "",
    "- list item FIXME",
    "",
    "> quote TODO"
  );
  assert.deepEqual(todoComments(markdown), [
    [ 1, [ 11, 4 ] ],
    [ 4, [ 1, 4 ] ],
    [ 5, [ 5, 5 ] ],
    [ 7, [ 9, 5 ] ],
    [ 8, [ 19, 4 ] ],
    [ 9, [ 8, 4 ] ],
    [ 11, [ 13, 5 ] ],
    [ 13, [ 9, 4 ] ]
  ]);
});

test("reports lines of a paragraph separately", () => {
  const markdown = lines(
    "First line of a paragraph,",
    "second line: FIXME and TODO,",
    "third line, nothing to do,",
    "fourth line TODO"
  );
  assert.deepEqual(todoComments(markdown), [
    [ 2, [ 14, 5 ] ],
    [ 4, [ 13, 4 ] ]
  ]);
});

test("reports nothing without uppercase whole-word TODO or FIXME", () => {
  assert.deepEqual(todoComments(lines("# Notes", "", "Nothing to do here.", "", "todo: fixme later, TODOS and FIXMES")), []);
  assert.deepEqual(todoComments(""), []);
});

test("todo-comments is not a built-in rule", async() => {
  const { "default": rules } = await importRepo("lib/rules.mjs");
  assert.ok(!rules.some(isTodoRule), "lib/rules.mjs has no todo-comments rule");
  const schema = JSON.parse(readText("schema/markdownlint-config-schema.json"));
  assert.equal(Object.hasOwn(schema.properties, "todo-comments"), false, "the config schema has no todo-comments property");
});
