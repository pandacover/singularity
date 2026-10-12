// Sealed acceptance tests for t11-circular-extends: readConfig from
// markdownlint/sync, markdownlint/async and markdownlint/promise fails cleanly
// when an `extends` chain comes back to a file already in it: sync throws, async
// calls back with an error, promise rejects, with a message that contains
// "circular" and the path of the file reached a second time. Chains without a
// cycle still work.
//
// Each readConfig call runs in a child process that is killed after a timeout,
// so a hang or a runaway loop fails the test instead of blocking it.
//
// Run: REPO=<absolute repository root> node --test <this file>

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.REPO;
assert.ok(REPO && path.isAbsolute(REPO), "Set REPO to the absolute path of the repository root");

const childTimeoutMs = 20000;
const variants = [ "sync", "async", "promise" ];
const modules = {
  "sync": "lib/exports-sync.mjs",
  "async": "lib/exports-async.mjs",
  "promise": "lib/exports-promise.mjs"
};

// Child process: reads groups of configuration files one group after another,
// the files of a group at the same time, and prints what each read gave.
const childScript = `
import path from "node:path";
import { pathToFileURL } from "node:url";
const [ repo, modulePath, variant, groupsJson ] = process.argv.slice(2);
const { readConfig } = await import(pathToFileURL(path.join(repo, modulePath)).href);
const failure = (error) => ({
  "ok": false,
  "isError": error instanceof Error,
  "message": String((error && (error.message !== undefined)) ? error.message : error)
});
const readOnce = (file) => new Promise((resolve) => {
  if (variant === "sync") {
    try {
      resolve({ "ok": true, "config": readConfig(file) });
    } catch (error) {
      resolve(failure(error));
    }
  } else if (variant === "async") {
    readConfig(file, (error, config) => resolve(error ? failure(error) : { "ok": true, config }));
  } else {
    readConfig(file).then((config) => resolve({ "ok": true, config }), (error) => resolve(failure(error)));
  }
});
const results = [];
for (const group of JSON.parse(groupsJson)) {
  results.push(...await Promise.all(group.map(readOnce)));
}
process.stdout.write("\\nRESULT " + JSON.stringify(results) + "\\n");
process.exit(0);
`;

let directory = "";
let childFile = "";
const fixture = (...parts) => path.join(directory, ...parts);

const configFiles = {
  // Two files that extend each other: first.json is reached a second time.
  "first.json": { "extends": "second.json", "MD001": false },
  "second.json": { "extends": "./first.json", "MD003": false },
  // A file that extends itself.
  "self.json": { "extends": "self.json", "MD004": false },
  // A chain that runs into a cycle which doesn't include its start:
  // loop-a.json is reached a second time.
  "start.json": { "extends": "loop-a.json", "MD005": false },
  "loop-a.json": { "extends": "loop-b.json", "MD007": false },
  "loop-b.json": { "extends": "loop-a.json", "MD009": false },
  // A chain without a cycle.
  "base.json": { "default": true, "MD013": { "line_length": 100 }, "MD033": { "allowed_elements": [ "br" ] } },
  "middle.json": { "extends": "./base.json", "MD013": false, "MD041": false },
  "top.json": { "extends": "middle.json", "MD033": false, "MD001": false },
  // Files of the same name in different folders, no cycle.
  ".markdownlint.json": { "MD013": { "line_length": 120 }, "MD024": { "siblings_only": true } },
  "nested/.markdownlint.json": { "extends": "../.markdownlint.json", "MD013": false }
};
const topConfig = { "default": true, "MD013": false, "MD033": false, "MD041": false, "MD001": false };
const nestedConfig = { "MD013": false, "MD024": { "siblings_only": true } };

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "markdownlint-t11-"));
  for (const [ name, content ] of Object.entries(configFiles)) {
    fs.mkdirSync(path.dirname(fixture(name)), { "recursive": true });
    fs.writeFileSync(fixture(name), JSON.stringify(content, null, 2));
  }
  childFile = fixture("read-config-child.mjs");
  fs.writeFileSync(childFile, childScript);
});

after(() => {
  if (directory) {
    fs.rmSync(directory, { "recursive": true, "force": true });
  }
});

// Runs the child for one variant; resolves to its results, or to
// { timedOut: true } when it had to be killed.
function readConfigs(variant, groups) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const child = spawn(
      process.execPath,
      [ childFile, REPO, modules[variant], variant, JSON.stringify(groups.map((group) => group.map((name) => fixture(name)))) ],
      { "env": env, "stdio": [ "ignore", "pipe", "pipe" ], "windowsHide": true }
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, childTimeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ "timedOut": true });
        return;
      }
      const line = stdout.split(/\r?\n/).findLast((item) => item.startsWith("RESULT "));
      if (!line) {
        reject(new Error(`readConfig (${variant}) did not finish cleanly:\n${stderr.slice(-2000)}`));
        return;
      }
      resolve({ "timedOut": false, "results": JSON.parse(line.slice("RESULT ".length)) });
    });
  });
}

const failureKind = {
  "sync": "throw",
  "async": "call back with an error",
  "promise": "reject"
};

function assertCircular(variant, result, basename) {
  assert.ok(result && result.ok === false, `readConfig (${variant}) should ${failureKind[variant]} for a circular extends chain; got ${JSON.stringify(result)}`);
  assert.equal(result.isError, true, `readConfig (${variant}) fails with an Error`);
  assert.match(result.message, /circular/i, `the message says circular: ${JSON.stringify(result.message)}`);
  assert.ok(result.message.includes(basename), `the message ${JSON.stringify(result.message)} names ${basename}`);
}

function assertFinished(variant, run) {
  assert.equal(run.timedOut, false, `readConfig (${variant}) did not finish within ${childTimeoutMs / 1000} s`);
}

describe("readConfig and circular extends", { "concurrency": 4 }, () => {
  for (const variant of variants) {
    test(`${variant}: two files that extend each other`, async() => {
      const run = await readConfigs(variant, [ [ "first.json" ] ]);
      assertFinished(variant, run);
      assertCircular(variant, run.results[0], "first.json");
    });

    test(`${variant}: a file that extends itself`, async() => {
      const run = await readConfigs(variant, [ [ "self.json" ] ]);
      assertFinished(variant, run);
      assertCircular(variant, run.results[0], "self.json");
    });

    test(`${variant}: a chain that runs into a cycle names the file reached twice`, async() => {
      const run = await readConfigs(variant, [ [ "start.json" ] ]);
      assertFinished(variant, run);
      assertCircular(variant, run.results[0], "loop-a.json");
    });

    test(`${variant}: chains without a cycle still work, read at once and again`, async() => {
      const run = await readConfigs(variant, [ [ "top.json", "top.json" ], [ "top.json" ], [ "nested/.markdownlint.json" ] ]);
      assertFinished(variant, run);
      assert.deepEqual(run.results, [
        { "ok": true, "config": topConfig },
        { "ok": true, "config": topConfig },
        { "ok": true, "config": topConfig },
        { "ok": true, "config": nestedConfig }
      ]);
    });

    test(`${variant}: a chain without a cycle works after a circular one failed`, async() => {
      const run = await readConfigs(variant, [ [ "first.json" ], [ "top.json" ] ]);
      assertFinished(variant, run);
      assertCircular(variant, run.results[0], "first.json");
      assert.deepEqual(run.results[1], { "ok": true, "config": topConfig });
    });
  }
});
