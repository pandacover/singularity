import { describe, expect, it } from "@effect/vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { learnerConfig, withModelHint } from "../../src/setup/Learner.ts"
import { codexChoices, hermesChoices, hermesModel, probeModel, reasonOf } from "../../src/setup/LearnerModel.ts"
import { modelFor, readLearn, writeLearn } from "../../src/setup/Preferences.ts"
import { lastLearnFailure } from "../../src/setup/Status.ts"
import { FAKE_CODEX, run, tempDir, withEnv } from "../eval/helpers.ts"

const REFUSAL = `codex failed (exit 1): {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}}`

describe("the model memory learns with", () => {
  it("is said without the JSON around an agent's error", () => {
    expect(reasonOf(REFUSAL)).toBe("The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.")
    expect(reasonOf("hermes failed: HTTP 404: Model 'stealth/x' not found.")).toBe("hermes failed: HTTP 404: Model 'stealth/x' not found.")
  })

  it("is named in a failed round's message when the model may be why, for the agents learning with the user's model", () => {
    expect(withModelHint(REFUSAL, "codex")).toContain("singularity setup --learn-model <model>")
    expect(withModelHint("You've hit your usage limit.", "codex")).toBe("You've hit your usage limit.")
    expect(withModelHint("Model 'x' not found", "claude")).toBe("Model 'x' not found")
  })

  it("is kept with the agent it goes with: another agent learns with its own", async () => {
    const root = tempDir()
    await run(writeLearn({ auto: true, every: 3, max_usd_per_day: 1, with: "codex", model: "gpt-5.6-luna" }, root))
    const prefs = await run(readLearn(root))
    expect(prefs).toEqual({ auto: true, every: 3, max_usd_per_day: 1, with: "codex", model: "gpt-5.6-luna" })
    expect(modelFor(prefs, "codex")).toBe("gpt-5.6-luna")
    expect(modelFor(prefs, "hermes")).toBeUndefined()
    expect(learnerConfig({ agent: "codex", command: ["codex"] }, "/w", "gpt-5.6-luna").model).toBe("gpt-5.6-luna")
    // A model with no agent chosen means nothing.
    writeFileSync(join(root, "config.json"), JSON.stringify({ tenant: "local", learn: { auto: true, every: 3, max_usd_per_day: 1, model: "x" } }))
    expect(await run(readLearn(root))).toEqual({ auto: true, every: 3, max_usd_per_day: 1 })
  })

  it("is checked with one call as learning makes them: the plan's refusal says why, another model answers", async () => {
    const root = tempDir()
    const codexHome = join(root, "codex")
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5.6-sol\"\n")
    const answers = join(root, "answers.json")
    writeFileSync(answers, JSON.stringify([{ ok: true }]))
    const cli = { agent: "codex" as const, command: FAKE_CODEX }
    const env = { FAKE_CODEX_ANSWERS: answers, FAKE_CODEX_REFUSE: "gpt-5.6-sol", CODEX_HOME: codexHome }
    const refused = await withEnv(env, () => run(probeModel(cli, undefined, join(root, "learner"))))
    expect(refused).toEqual({ ok: false, reason: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account." })
    expect(await withEnv(env, () => run(probeModel(cli, "gpt-5.6-luna", join(root, "learner"))))).toEqual({ ok: true })
  })

  it("is offered from the models Codex lists for the account, cheapest first, with their prices", async () => {
    const home = tempDir()
    mkdirSync(join(home, ".codex"))
    writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({
      fetched_at: "2026-10-10T00:00:00Z",
      models: [
        { slug: "gpt-5.6-sol", visibility: "list" },
        { slug: "gpt-reserve", visibility: "hide" },
        { slug: "gpt-5.6-luna", visibility: "list" },
        { slug: "gpt-5.6-terra", visibility: "list" }
      ]
    }))
    const choices = await run(codexChoices({ home, env: {} }))
    expect(choices.map((c) => c.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])
    expect(choices[0].note).toBe("$0.20 in / $1.20 out per million tokens at API prices")
    expect(await run(codexChoices({ home: tempDir(), env: {} }))).toEqual([])
  })

  it("is offered from the free models Hermes Agent knows its provider has", async () => {
    const hermes = tempDir()
    writeFileSync(join(hermes, "config.yaml"), "model:\r\n  default: stealth/gone\r\n  provider: nous\r\nplugins:\r\n  enabled: []\r\n")
    writeFileSync(join(hermes, "provider_models_cache.json"), JSON.stringify({
      nous: { fp: "x", at: 1, models: ["anthropic/claude-opus-5.5", "poolside/laguna-s-2.1:free", "stepfun/step-5-preview:free"] },
      openrouter: { fp: "y", at: 1, models: ["other:free"] }
    }))
    const dirs = { home: tempDir(), env: { HERMES_HOME: hermes } }
    expect(await run(hermesModel(dirs))).toEqual({ model: "stealth/gone", provider: "nous" })
    expect((await run(hermesChoices(dirs))).map((c) => c.id)).toEqual(["poolside/laguna-s-2.1:free", "stepfun/step-5-preview:free"])
  })

  it("shows in status when the last background round failed, and not once one went through since", () => {
    const failed = [
      "2026-10-10T09:00:00.000Z app: ✓ Learned 3 workflows",
      "2026-10-10T10:00:00.000Z app: failed: codex failed (exit 1): The 'x' model is not supported"
    ].join("\r\n")
    expect(lastLearnFailure(failed)).toEqual({ subject: "app", reason: "codex failed (exit 1): The 'x' model is not supported" })
    expect(lastLearnFailure(`${failed}\n2026-10-10T11:00:00.000Z app: · the changes showed no workflow to keep yet ($0.40)`)).toBeUndefined()
    expect(lastLearnFailure("")).toBeUndefined()
  })
})
