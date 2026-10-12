// Sealed acceptance tests for t06-rename-doc-src: the `doc-build` folder is
// renamed to `doc-src`, which holds the docs build script and the sources
// (heading, footing and one per rule), `npm run build-docs` runs from it, and
// what referred to `doc-build` (package.json, .npmignore) now refers to
// `doc-src`. (Regenerating the docs is checked by the harness.)
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
const isFile = (...parts) => fs.statSync(repoPath(...parts), { "throwIfNoEntry": false })?.isFile() === true;

// Files under a directory, recursively (none when it doesn't exist).
function filesUnder(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { "recursive": true, "withFileTypes": true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("doc-build is gone", () => {
  assert.deepEqual(filesUnder(repoPath("doc-build")), [], "no files are left in doc-build");
});

test("doc-src holds the heading, the footing and a source for every built-in rule", async() => {
  assert.ok(fs.statSync(repoPath("doc-src"), { "throwIfNoEntry": false })?.isDirectory(), "doc-src is a folder");
  assert.ok(isFile("doc-src", "heading.md"), "doc-src/heading.md");
  assert.ok(isFile("doc-src", "footing.md"), "doc-src/footing.md");
  const { "default": rules } = await importRepo("lib/rules.mjs");
  const missing = rules
    .map((rule) => `${rule.names[0].toLowerCase()}.md`)
    .filter((name) => !isFile("doc-src", name));
  assert.deepEqual(missing, [], "every rule in lib/rules.mjs has a source in doc-src");
});

test("build-docs runs the build script in doc-src", () => {
  const packageJson = JSON.parse(readText("package.json"));
  const script = packageJson.scripts["build-docs"];
  assert.equal(typeof script, "string", "package.json has a build-docs script");
  assert.doesNotMatch(script, /doc-build/);
  assert.match(script, /doc-src/);
  const scriptFiles = [ ...script.matchAll(/(?:^|[\s"'=])(?:\.[\\/])?(doc-src[\\/][^\s"'&|;]+)/g) ].map((match) => match[1]);
  for (const file of scriptFiles) {
    assert.ok(isFile(file), `${file}, named by build-docs, exists`);
  }
  const scripts = filesUnder(repoPath("doc-src")).filter((file) => /\.[cm]?js$/.test(file));
  assert.ok(scripts.length > 0, "doc-src holds the build script");
});

test(".npmignore leaves out doc-src instead of doc-build", () => {
  const entries = readText(".npmignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(!entries.some((line) => line.includes("doc-build")), ".npmignore no longer names doc-build");
  assert.ok(entries.some((line) => line.includes("doc-src")), ".npmignore names doc-src");
});
