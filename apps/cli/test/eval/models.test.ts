import { describe, expect, it } from "@effect/vitest"
import { Effect, Predicate, Schema } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { codexUsd, configuredModel, enabledServers, featureNames, OFF_FEATURES, strictSchema } from "../../src/eval/CodexLlm.ts"
import { answerFormat, hermesResult, jsonIn } from "../../src/eval/HermesLlm.ts"
import { jsonSchemaOf, LlmError } from "../../src/eval/Llm.ts"
import { callModel } from "../../src/eval/ModelCall.ts"
import { CuesAnswer } from "../../src/workflows/CueWriter.ts"
import { InductionAnswer } from "../../src/workflows/Induce.ts"
import { FAKE_CODEX, FAKE_HERMES, run, tempDir, withEnv } from "./helpers.ts"

const Answer = Schema.Struct({ ok: Schema.Boolean, note: Schema.NullOr(Schema.String) })

const json = (file: string) => JSON.parse(readFileSync(file, "utf-8"))

/** Every object in a JSON Schema, nested ones included. */
const objects = (schema: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(schema)) return schema.flatMap(objects)
  if (!Predicate.isObject(schema)) return []
  const node = schema as Record<string, unknown>
  return [...(node.type === "object" ? [node] : []), ...Object.values(node).flatMap(objects)]
}

describe("model calls through Codex", () => {
  it("gives Codex memory's answers as strict outputs take them: closed objects, every key required", () => {
    for (const schema of [InductionAnswer, CuesAnswer]) {
      const strict = objects(strictSchema(jsonSchemaOf(schema)))
      expect(strict.length).toBeGreaterThan(3)
      for (const o of strict) {
        expect(o.additionalProperties).toBe(false)
        expect([...(o.required as Array<string>)].sort()).toEqual(Object.keys(o.properties as object).sort())
      }
    }
  })

  it("counts tokens at the model's API price, and an unknown model at the dearest", () => {
    // gpt-5.4-mini, not gpt-5.4: the first prefix that matches.
    expect(codexUsd("gpt-5.4-mini", 1_000_000, 400_000, 100_000)).toBeCloseTo(0.6 * 0.75 + 0.4 * 0.075 + 0.1 * 4.5)
    expect(codexUsd("GPT-5.6-Sol", 1_000_000, 0, 0)).toBeCloseTo(5)
    expect(codexUsd("some-new-model", 0, 0, 1_000_000)).toBeCloseTo(30)
    expect(codexUsd(undefined, 1_000_000, 0, 0)).toBeCloseTo(5)
  })

  it("reads the model Codex's config would use, its profile's first", () => {
    expect(configuredModel('model = "gpt-5.4"\n')).toBe("gpt-5.4")
    expect(configuredModel('model = "gpt-5.4"\nprofile = "fast"\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n')).toBe("gpt-5.6-luna")
    expect(configuredModel("approval_policy = \"never\"\n")).toBeUndefined()
    expect(configuredModel("not = [toml")).toBeUndefined()
  })

  it("reads which features this Codex has and which MCP servers it would start", () => {
    expect([...featureNames("apps   stable   true\r\nshell_tool  stable  false\nnot a feature\n")]).toEqual(["apps", "shell_tool"])
    expect(enabledServers('[{"name":"docs","enabled":true},{"name":"off","enabled":false},{"name":"we ird","enabled":true}]')).toEqual(["docs"])
    expect(enabledServers("Error: no config")).toEqual([])
  })

  it("makes a plain model call: our instructions, the schema, the prompt on stdin, tools and servers off", async () => {
    const root = tempDir()
    const codexHome = join(root, "codex")
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.4-mini"\n')
    const answers = join(root, "answers.json")
    writeFileSync(answers, JSON.stringify([{ ok: true, note: null }]))
    const result = await withEnv({ FAKE_CODEX_ANSWERS: answers, CODEX_HOME: codexHome }, () =>
      run(callModel({
        cli: { agent: "codex", command: FAKE_CODEX },
        system: "You judge.",
        prompt: "Is it fine?",
        schema: Answer,
        effort: "high",
        cwd: root
      })))
    expect(result.value).toEqual({ ok: true, note: null })
    // 600 new and 400 cached input tokens, 200 output, at gpt-5.4-mini's price.
    expect(result.costUsd).toBeCloseTo((600 * 0.75 + 400 * 0.075 + 200 * 4.5) / 1e6, 10)
    expect(result.usage).toEqual({ input_tokens: 600, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 400 })

    const call = json(`${answers}.call0.json`)
    expect(call.system).toBe("You judge.")
    expect(call.prompt).toBe("Is it fine?")
    expect(call.schema.additionalProperties).toBe(false)
    expect(call.hooks).toBe("off")
    const args: Array<string> = call.args
    expect(args.slice(0, 3)).toEqual(["exec", "--json", "--ephemeral"])
    expect(args.at(-1)).toBe("-")
    for (const flag of ["--skip-git-repo-check", "--output-schema", "--output-last-message"]) expect(args).toContain(flag)
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only")
    // Only the features this Codex has go off; a feature it doesn't know would be an error.
    const off = args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []))
    expect(off).toEqual(OFF_FEATURES.filter((f) => ["hooks", "plugins", "shell_tool"].includes(f)))
    const configs = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []))
    // The server from the user's config goes off; the plugin's never starts with plugins off.
    expect(configs).toContain("mcp_servers.docs.enabled=false")
    expect(configs.some((c) => c.includes("plugin-tools") || c.includes("off-already"))).toBe(false)
    expect(configs).toContain('model_reasoning_effort="high"')
    expect(configs).toContain("project_doc_max_bytes=0")
    expect(args).not.toContain("--model")
  })

  it("fails with Codex's own words when it can't answer", async () => {
    const root = tempDir()
    const answers = join(root, "answers.json")
    writeFileSync(answers, JSON.stringify([{ ok: true, note: null }]))
    const error = await withEnv({ FAKE_CODEX_ANSWERS: answers, FAKE_CODEX_FAIL: "1", CODEX_HOME: join(root, "none") }, () =>
      run(Effect.flip(callModel({ cli: { agent: "codex", command: FAKE_CODEX }, system: "s", prompt: "p", schema: Answer, cwd: root }))))
    expect(error).toBeInstanceOf(LlmError)
    expect(error.message).toContain("You've hit your usage limit.")
  })
})

describe("model calls through Hermes Agent", () => {
  it("finds the JSON in an answer, fenced or with words around it", () => {
    expect(jsonIn('{"ok":true}')).toBe('{"ok":true}')
    expect(jsonIn('Here it is:\n```json\n{"ok": true}\n```\nDone.')).toBe('{"ok": true}')
    expect(jsonIn('Sure. {"a": {"b": 1}} Hope that helps')).toBe('{"a": {"b": 1}}')
    expect(answerFormat({ type: "object" })).toContain('{"type":"object"}')
    expect(hermesResult('{"type":"text","text":"x"}\nnoise\n{"type":"result","session_id":"s1","exit_code":0,"text":"x"}\n')?.session_id).toBe("s1")
    expect(hermesResult("Error: no provider\n")).toBeUndefined()
  })

  it("asks for the schema's JSON with no tools, reads Hermes's cost, and asks once more when the answer doesn't hold", async () => {
    const root = tempDir()
    const hermesHome = join(root, "hermes")
    mkdirSync(hermesHome)
    const answers = join(root, "answers.json")
    writeFileSync(answers, JSON.stringify(["I think it's fine!", "```json\n{\"ok\": false, \"note\": \"one thing\"}\n```"]))
    const result = await withEnv({ FAKE_HERMES_ANSWERS: answers, HERMES_HOME: hermesHome }, () =>
      run(callModel({
        cli: { agent: "hermes", command: FAKE_HERMES },
        system: "You judge.",
        prompt: "Is it fine?",
        schema: Answer,
        effort: "high",
        cwd: root
      })))
    expect(result.value).toEqual({ ok: false, note: "one thing" })
    // Two sessions, $0.02 each as Hermes reckoned them.
    expect(result.costUsd).toBeCloseTo(0.04)
    expect(result.usage.input_tokens).toBe(1000)

    const first = json(`${answers}.call0.json`)
    expect(first.system).toBe("You judge.")
    expect(first.prompt).toMatch(/^Is it fine\?\n\n## Your answer\n\n/)
    expect(first.prompt).toContain('"additionalProperties"')
    const args: Array<string> = first.args
    expect(args.slice(0, 4)).toEqual(["chat", "-Q", "--query-file", "-"])
    expect(args[args.indexOf("--toolsets") + 1]).toBe("bot_room")
    expect(args[args.indexOf("--source") + 1]).toBe("tool")
    expect(args[args.indexOf("--reasoning") + 1]).toBe("high")
    expect(args).toContain("--ignore-rules")
    expect(args).not.toContain("--model")
    const second = json(`${answers}.call1.json`)
    expect(second.prompt).toContain("## Your answer before")
    expect(second.prompt).toContain("I think it's fine!")
  })
})
