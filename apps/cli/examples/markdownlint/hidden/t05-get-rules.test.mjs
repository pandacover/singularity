// Sealed acceptance tests for t05-get-rules: the main `markdownlint` entry
// point exports getRules(), which returns a new array on every call, one plain
// object { names, description, tags, information, fixable } per built-in rule
// in rule order; changing the results affects neither markdownlint nor later
// calls. It is declared in the type declarations and documented in the
// README's API section.
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

const packageJson = JSON.parse(readText("package.json"));
const mainExport = packageJson.exports["."];
const mainEntry = (typeof mainExport === "string") ? mainExport : (mainExport.import || mainExport.default);
const markdownlint = await importRepo(mainEntry);
const { "default": rules } = await importRepo("lib/rules.mjs");
const { fixableRuleNames } = await importRepo("lib/constants.mjs");
const { lint } = await importRepo("lib/exports-sync.mjs");

const keys = [ "description", "fixable", "information", "names", "tags" ];

// What getRules() should return, from the rules themselves.
const expectedRules = () => rules.map((rule) => ({
  "names": [ ...rule.names ],
  "description": rule.description,
  "tags": [ ...rule.tags ],
  "information": String(rule.information),
  "fixable": fixableRuleNames.includes(rule.names[0])
}));

// A plain copy of one result, to compare with expectedRules().
const copyOf = (item) => ({
  "names": Array.isArray(item.names) ? [ ...item.names ] : item.names,
  "description": item.description,
  "tags": Array.isArray(item.tags) ? [ ...item.tags ] : item.tags,
  "information": item.information,
  "fixable": item.fixable
});

const getRules = () => markdownlint.getRules();

// Tries to change a result. Frozen results refuse with a TypeError (strict
// mode), which the prompt allows: what matters is that nothing else changes.
function attempt(change) {
  try {
    change();
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
  }
}

test("getRules is exported from the main entry point, next to getVersion", () => {
  assert.equal(typeof markdownlint.getRules, "function");
  assert.equal(typeof markdownlint.getVersion, "function");
});

test("one plain object per built-in rule, in rule order", () => {
  const result = getRules();
  assert.ok(Array.isArray(result), "getRules() returns an array");
  assert.equal(result.length, rules.length);
  for (const [ index, item ] of result.entries()) {
    const prototype = Object.getPrototypeOf(item);
    assert.ok((prototype === Object.prototype) || (prototype === null), `item ${index} is a plain object`);
    // The prompt lists these five; an extra key is let through rather than failed.
    for (const key of keys) {
      assert.ok(Object.hasOwn(item, key), `item ${index} has ${key}`);
    }
    assert.ok(Array.isArray(item.names) && item.names.every((name) => typeof name === "string"), `item ${index}: names is an array of strings`);
    assert.ok(Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string"), `item ${index}: tags is an array of strings`);
    assert.equal(typeof item.description, "string", `item ${index}: description is a string`);
    assert.equal(typeof item.information, "string", `item ${index}: information is a string`);
    assert.equal(typeof item.fixable, "boolean", `item ${index}: fixable is a boolean`);
  }
  assert.deepEqual(result.map(copyOf), expectedRules());
});

test("information is each rule's documentation URL and fixable follows the fixable rules", () => {
  const byName = new Map(getRules().map((item) => [ item.names[0], item ]));
  for (const rule of rules) {
    const item = byName.get(rule.names[0]);
    assert.ok(item, `${rule.names[0]} is returned`);
    assert.equal(item.information, rule.information.href);
    assert.equal(item.fixable, fixableRuleNames.includes(rule.names[0]), `${rule.names[0]} fixable`);
  }
  assert.ok(getRules().some((item) => item.fixable), "some rules are fixable");
  assert.ok(getRules().some((item) => !item.fixable), "some rules are not fixable");
});

test("every call returns a new array", () => {
  const first = getRules();
  const second = getRules();
  assert.notEqual(first, second);
  assert.deepEqual(first.map(copyOf), second.map(copyOf));
});

test("changing the results affects neither later calls nor markdownlint", () => {
  const markdown = "# Title\n\n## Title\n\nText with trailing spaces   \n";
  const config = { "default": false, "no-duplicate-heading": true, "whitespace": true };
  const lintNow = () => lint({ "strings": { "doc": markdown }, config }).doc;
  const ruleState = () => rules.map((rule) => JSON.stringify([ rule.names, rule.description, rule.tags, String(rule.information) ]));

  const expected = expectedRules();
  const stateBefore = ruleState();
  const lintBefore = lintNow();
  assert.ok(lintBefore.some((error) => error.ruleNames.includes("MD024")), "the alias enables MD024");
  assert.ok(lintBefore.some((error) => error.ruleNames.includes("MD009")), "the tag enables MD009");

  const result = getRules();
  for (const item of result) {
    attempt(() => item.names.push("extra-name"));
    attempt(() => {
      item.names[0] = "changed-name";
    });
    attempt(() => item.tags.splice(0, item.tags.length, "changed-tag"));
    attempt(() => {
      item.description = "changed description";
    });
    attempt(() => {
      item.information = "https://example.com/changed";
    });
    attempt(() => {
      item.fixable = !item.fixable;
    });
  }
  attempt(() => result.reverse());
  attempt(() => result.push({ "names": [ "added" ], "description": "added", "tags": [], "information": "", "fixable": false }));

  assert.deepEqual(getRules().map(copyOf), expected, "a later call returns the original data");
  assert.deepEqual(ruleState(), stateBefore, "the built-in rules are unchanged");
  assert.deepEqual(lintNow(), lintBefore, "linting gives the same results");
});

test("the type declarations of the main entry point declare getRules", () => {
  assert.match(readText("lib/exports.d.mts"), /\bgetRules\b/);
});

test("the README's API section documents getRules", () => {
  const readme = readText("README.md");
  const start = readme.search(/^## API[ \t]*$/m);
  assert.notEqual(start, -1, "README has an API section");
  const rest = readme.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = (next === -1) ? rest : rest.slice(0, next);
  assert.match(section, /\bgetRules\b/);
});
