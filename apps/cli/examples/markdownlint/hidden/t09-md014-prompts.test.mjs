// Sealed acceptance tests for t09-md014-prompts: MD014 gets a parameter
// `prompts` (array of strings, default ["$"]). A code block is reported when
// every non-blank line starts, after any indentation, with one of the prompts
// followed by whitespace (lines may use different prompts); each such line
// gets an error whose range covers the prompt and the whitespace after it, and
// whose fix removes them, as MD014 does today for `$`.
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
const { applyFixes } = await importRepo("lib/exports.mjs");

// MD014 alone on one document: [lineNumber, errorRange] per error, and the
// document with all of its fixes applied.
function md014(markdown, ruleConfig = true) {
  const errors = lint({
    "strings": { "doc": markdown },
    "config": { "default": false, "MD014": ruleConfig }
  }).doc;
  return {
    "reported": errors.map((error) => [ error.lineNumber, error.errorRange ]),
    "fixed": applyFixes(markdown, errors)
  };
}

const lines = (...items) => items.join("\n") + "\n";
const unchanged = (markdown) => ({ "reported": [], "fixed": markdown });
const allThree = { "prompts": [ "$", "%", ">" ] };

test("by default only $ is a prompt, as today", () => {
  for (const ruleConfig of [ true, {}, { "prompts": [ "$" ] } ]) {
    assert.deepEqual(md014(lines("```sh", "$ ls", "$   cat foo", "```"), ruleConfig), {
      "reported": [ [ 2, [ 1, 2 ] ], [ 3, [ 1, 4 ] ] ],
      "fixed": lines("```sh", "ls", "cat foo", "```")
    });
    assert.deepEqual(md014(lines("```sh", "$\tls", "```"), ruleConfig), {
      "reported": [ [ 2, [ 1, 2 ] ] ],
      "fixed": lines("```sh", "ls", "```")
    });
    const zsh = lines("```sh", "% ls", "% pwd", "```");
    assert.deepEqual(md014(zsh, ruleConfig), unchanged(zsh));
    const cmd = lines("```sh", "> dir", "```");
    assert.deepEqual(md014(cmd, ruleConfig), unchanged(cmd));
    const output = lines("```sh", "$ ls", "foo bar", "```");
    assert.deepEqual(md014(output, ruleConfig), unchanged(output));
  }
});

test("lines may use different prompts", () => {
  assert.deepEqual(md014(lines("```sh", "$ ls", "% pwd", "> dir", "```"), allThree), {
    "reported": [ [ 2, [ 1, 2 ] ], [ 3, [ 1, 2 ] ], [ 4, [ 1, 2 ] ] ],
    "fixed": lines("```sh", "ls", "pwd", "dir", "```")
  });
  assert.deepEqual(md014(lines("```sh", "%  ls", "", "> dir", "```"), allThree), {
    "reported": [ [ 2, [ 1, 3 ] ], [ 4, [ 1, 2 ] ] ],
    "fixed": lines("```sh", "ls", "", "dir", "```")
  });
});

test("prompts after indentation, in fenced and indented code blocks", () => {
  assert.deepEqual(md014(lines("  ```sh", "    % ls", "  > cat", "  ```"), allThree), {
    "reported": [ [ 2, [ 5, 2 ] ], [ 3, [ 3, 2 ] ] ],
    "fixed": lines("  ```sh", "    ls", "  cat", "  ```")
  });
  assert.deepEqual(md014(lines("Text", "", "    % ls", "      > cat"), allThree), {
    "reported": [ [ 3, [ 5, 2 ] ], [ 4, [ 7, 2 ] ] ],
    "fixed": lines("Text", "", "    ls", "      cat")
  });
});

test("a block is not reported unless every non-blank line starts with a prompt and whitespace", () => {
  const withOutput = lines("```sh", "% ls", "file.txt", "> dir", "```");
  assert.deepEqual(md014(withOutput, allThree), unchanged(withOutput));
  const noSpace = lines("```sh", "% ls", "%pwd", "```");
  assert.deepEqual(md014(noSpace, allThree), unchanged(noSpace));
  const otherPrompt = lines("```sh", "$ ls", "% pwd", "```");
  assert.deepEqual(md014(otherPrompt, { "prompts": [ "$" ] }), unchanged(otherPrompt));
  assert.deepEqual(md014(otherPrompt, { "prompts": [ "%" ] }), unchanged(otherPrompt));
});

test("the configured prompts replace the default", () => {
  const dollar = lines("```sh", "$ ls", "```");
  assert.deepEqual(md014(dollar, { "prompts": [ "%" ] }), unchanged(dollar));
  assert.deepEqual(md014(lines("```sh", "% ls", "```"), { "prompts": [ "%" ] }), {
    "reported": [ [ 2, [ 1, 2 ] ] ],
    "fixed": lines("```sh", "ls", "```")
  });
});

test("prompts of several characters", () => {
  assert.deepEqual(md014(lines("```powershell", "PS> Get-ChildItem", "PS>  dir", "```"), { "prompts": [ "PS>" ] }), {
    "reported": [ [ 2, [ 1, 4 ] ], [ 3, [ 1, 5 ] ] ],
    "fixed": lines("```powershell", "Get-ChildItem", "dir", "```")
  });
});

test("each code block is judged on its own", () => {
  const markdown = lines(
    "```sh",
    "% make",
    "> make install",
    "```",
    "",
    "```sh",
    "% make",
    "make: Nothing to be done.",
    "```"
  );
  assert.deepEqual(md014(markdown, allThree), {
    "reported": [ [ 2, [ 1, 2 ] ], [ 3, [ 1, 2 ] ] ],
    "fixed": lines(
      "```sh",
      "make",
      "make install",
      "```",
      "",
      "```sh",
      "% make",
      "make: Nothing to be done.",
      "```"
    )
  });
});

test("config schema declares prompts for MD014 (array of strings, default [\"$\"])", () => {
  const schema = JSON.parse(readText("schema/markdownlint-config-schema.json"));
  const rule = schema.properties.MD014;
  assert.ok(rule && Array.isArray(rule.oneOf), "MD014 is in the schema");
  const variant = rule.oneOf.find((item) => item && item.properties);
  assert.ok(variant, "MD014 has an object variant with properties");
  const parameter = variant.properties.prompts;
  assert.ok(parameter, "MD014's object variant declares prompts");
  assert.deepEqual([ parameter.type ].flat(), [ "array" ]);
  assert.equal(parameter.items && parameter.items.type, "string");
  assert.deepEqual(parameter.default, [ "$" ]);
});

// The text of one top-level property in lib/configuration-strict.d.ts, from
// its key to the doc comment of the next property.
function declarationOf(declarations, key) {
  const start = declarations.indexOf(`\n  ${key}?:`);
  assert.notEqual(start, -1, `${key} is declared in lib/configuration-strict.d.ts`);
  const end = declarations.indexOf("\n  /**", start + 1);
  return declarations.slice(start, (end === -1) ? undefined : end);
}

test("lib/configuration-strict.d.ts declares prompts for MD014", () => {
  const declarations = readText("lib/configuration-strict.d.ts");
  assert.match(declarationOf(declarations, "MD014"), /\bprompts\?:/);
});

test("the generated MD014 documentation mentions prompts", () => {
  assert.ok(readText("doc/md014.md").includes("`prompts`"), "doc/md014.md mentions `prompts`");
});
