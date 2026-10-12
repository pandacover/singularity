// Sealed acceptance tests for task t07-link-url-scheme (rule MD064).
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

const RULE = "MD064";
const ALIAS = "link-url-scheme";
const DESCRIPTION = "Link URL scheme should be allowed";
const TAGS = [ "links", "url" ];
const PARAMETERS = [ "allowed_schemes" ];

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
// errors as [lineNumber, errorContext] pairs, sorted.
function check(markdown, ruleConfig = true, key = RULE) {
  assert.ok(findRule(), `${RULE} is not registered in lib/rules.mjs`);
  const results = lint({
    "strings": { "doc": markdown },
    "config": { "default": false, [key]: ruleConfig }
  });
  return results.doc.map((error) => [ error.lineNumber, error.errorContext ]).sort(byLineThenRest);
}

// The prompt's examples write schemes with their colon (`https:`), so a
// configuration may reasonably list them either way; every allowed scheme is
// passed in both spellings so that both readings are accepted.
const allow = (...schemes) => ({ "allowed_schemes": schemes.flatMap((scheme) => [ scheme, `${scheme}:` ]) });

// For autolinks, accept the destination with or without its angle brackets.
const unbracket = (errors) => errors.map(([ line, context ]) => [ line, String(context).replace(/^<(.*)>$/s, "$1") ]).sort(byLineThenRest);

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

test("MD064 is registered with its names, description and tags", () => {
  const rule = findRule();
  assert.ok(rule, `${RULE} is not registered in lib/rules.mjs`);
  assert.deepEqual([ ...rule.names ], [ RULE, ALIAS ]);
  assert.equal(rule.description, DESCRIPTION);
  assert.deepEqual([ ...rule.tags ].toSorted(), [ ...TAGS ].toSorted());
});

// ---------------------------------------------------------------------------
// Behavior

const inlineLinks = md(
  "[FTP](ftp://example.com/file) and [web](https://example.com)",
  "",
  "![Image](HTTP://example.com/i.png \"Title\")",
  "",
  "Write to [me](mailto:me@example.com).",
  ""
);

test("with the default allowed_schemes nothing is reported", () => {
  const markdown = md(
    inlineLinks,
    "<irc://irc.example.com> and [ref]",
    "",
    "[ref]: gopher://example.com/3",
    ""
  );
  assert.deepEqual(check(markdown), []);
  assert.deepEqual(check(markdown, {}), []);
  assert.deepEqual(check(markdown, { "allowed_schemes": [] }), []);
});

test("inline links and images with a scheme that is not allowed are reported with the destination", () => {
  assert.deepEqual(check(inlineLinks, allow("https")), [
    [ 1, "ftp://example.com/file" ],
    [ 3, "HTTP://example.com/i.png" ],
    [ 5, "mailto:me@example.com" ]
  ]);
  assert.deepEqual(check(inlineLinks, allow("ftp")), [
    [ 1, "https://example.com" ],
    [ 3, "HTTP://example.com/i.png" ],
    [ 5, "mailto:me@example.com" ]
  ]);
  assert.deepEqual(check(inlineLinks, allow("https", "ftp", "http", "mailto")), []);
});

test("link reference definitions are checked where the destination is", () => {
  const markdown = md(
    "[One][one], [two][] and [three]",
    "",
    "[one]: ftp://example.com/one",
    "[two]: https://example.com/two \"Title\"",
    "[three]:",
    "  gopher://example.com/3",
    ""
  );
  assert.deepEqual(check(markdown, allow("https")), [
    [ 3, "ftp://example.com/one" ],
    [ 6, "gopher://example.com/3" ]
  ]);
  assert.deepEqual(check(markdown, allow("ftp", "gopher", "https")), []);
});

test("autolinks are checked", () => {
  const markdown = md(
    "See <ftp://example.com/file> or <https://example.com>.",
    "",
    "<HTTPS://EXAMPLE.COM/UPPER>",
    "",
    "<irc://irc.example.com>",
    ""
  );
  assert.deepEqual(unbracket(check(markdown, allow("https"))), [
    [ 1, "ftp://example.com/file" ],
    [ 5, "irc://irc.example.com" ]
  ]);
  assert.deepEqual(check(markdown, allow("https", "ftp", "irc")), []);
});

test("bare URLs in text are not checked", () => {
  const markdown = md(
    "Visit https://example.com, ftp://example.com/file or www.example.com today.",
    ""
  );
  assert.deepEqual(check(markdown, allow("mailto")), []);
});

test("destinations without a scheme are never reported", () => {
  const markdown = md(
    "[a](./docs/file.md) [b](#fragment) [c](/absolute/path)",
    "",
    "[d](relative.md) ![e](images/pic.png) [f](//example.com/x)",
    "",
    "[g](1abc:def) [h](a_b:c)",
    "",
    "[ref]: ../up.md",
    ""
  );
  assert.deepEqual(check(markdown, allow("https")), []);
});

test("schemes may contain letters, digits, plus, hyphen and period", () => {
  const markdown = md(
    "[svn](svn+ssh://host/repo) and [app](x-my.app2:open)",
    ""
  );
  assert.deepEqual(check(markdown, allow("https")), [
    [ 1, "svn+ssh://host/repo" ],
    [ 1, "x-my.app2:open" ]
  ]);
  assert.deepEqual(check(markdown, allow("svn+ssh", "x-my.app2")), []);
});

test("schemes are compared ignoring case", () => {
  const markdown = md(
    "[a](HTTPS://example.com/a) and [b](Mailto:me@example.com)",
    "",
    "[d]: HTTPS://example.com/d",
    ""
  );
  assert.deepEqual(check(markdown, allow("https", "MAILTO")), []);
  assert.deepEqual(check(markdown, allow("mailto")), [
    [ 1, "HTTPS://example.com/a" ],
    [ 3, "HTTPS://example.com/d" ]
  ]);
});

test("errors are reported on the line where the destination is", () => {
  const markdown = md(
    "[Link text that",
    "wraps](ftp://example.com/a)",
    "",
    "[Another link](",
    "gopher://example.com/b)",
    ""
  );
  assert.deepEqual(check(markdown, allow("https")), [
    [ 2, "ftp://example.com/a" ],
    [ 5, "gopher://example.com/b" ]
  ]);
});

test("the alias works as a configuration key", () => {
  assert.deepEqual(check(inlineLinks, allow("https"), ALIAS), [
    [ 1, "ftp://example.com/file" ],
    [ 3, "HTTP://example.com/i.png" ],
    [ 5, "mailto:me@example.com" ]
  ]);
  assert.deepEqual(check(inlineLinks, true, ALIAS), []);
});

// ---------------------------------------------------------------------------
// Configuration schema and generated declarations

test("the config schema declares MD064 and its alias with the allowed_schemes parameter", () => {
  for (const key of [ RULE, ALIAS ]) {
    const parameters = schemaParameters(key);
    const names = Object.keys(parameters).filter((name) => (name !== "enabled") && (name !== "severity"));
    assert.deepEqual(names.toSorted(), [ ...PARAMETERS ].toSorted(), `parameters of "${key}"`);
    const allowedSchemes = parameters.allowed_schemes;
    assert.deepEqual(typesOf(allowedSchemes), [ "array" ], `type of ${key}.allowed_schemes`);
    assert.ok(allowedSchemes.items, `${key}.allowed_schemes has no items`);
    assert.deepEqual(typesOf(allowedSchemes.items), [ "string" ], `item type of ${key}.allowed_schemes`);
    assert.deepEqual(allowedSchemes.default, [], `default of ${key}.allowed_schemes`);
  }
});

test("lib/configuration-strict.d.ts declares MD064, its alias and the allowed_schemes parameter", () => {
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
  const source = path.join(docsSourceFolder(), "md064.md");
  assert.ok(fs.existsSync(source), `missing ${source}`);
  assert.ok(fs.readFileSync(source, "utf8").trim().length > 0, `${source} is empty`);
});

test("doc/md064.md exists and mentions the alias and the parameter", () => {
  const doc = readText("doc", "md064.md");
  assert.ok(doc.includes(ALIAS), "doc/md064.md does not mention the alias");
  for (const parameter of PARAMETERS) {
    assert.ok(doc.includes(`\`${parameter}\``), `doc/md064.md does not mention \`${parameter}\``);
  }
});

test("doc/Rules.md has the rule's section", () => {
  const lines = readText("doc", "Rules.md").split(/\r?\n/).map((line) => line.trimEnd());
  assert.ok(lines.includes(`## \`${RULE}\` - ${DESCRIPTION}`), "doc/Rules.md has no section for MD064");
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
