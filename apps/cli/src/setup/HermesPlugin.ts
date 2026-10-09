/**
 * Memory's plugin for Hermes Agent, `<hermes home>/plugins/singularity`.
 *
 * Hermes's shell hooks can add text to a prompt but not to a tool's result,
 * where warnings go, so memory comes as a plugin: a few lines of Python that
 * run the same hook script as every other agent's hooks, in Claude Code's
 * format.
 *
 * - `pre_llm_call`, Hermes's UserPromptSubmit: the hand-over, added to the
 *   user's message.
 * - `transform_tool_result`: after a shell command or an edit, a known
 *   mistake's warning, appended to the tool's result (as Hermes's own
 *   security-guidance plugin appends its warnings). It starts the script only
 *   in sessions memory handed something over to, checked as hook.ts checks.
 * - `on_session_finalize`, Hermes's SessionEnd (when the CLI, the TUI or the
 *   gateway closes a session): memory stores the changes the session
 *   committed with its checks passing that it hasn't stored yet. Its
 *   transcript is the session in Hermes's database (traces/Hermes.ts), where
 *   the script also finds where it ran.
 *
 * Hermes loads a plugin of the user's only once its name is in
 * `plugins.enabled` in its config.yaml. Setup puts it there with an edit of
 * that list alone: the rest of the file stays byte for byte, and an edit that
 * would read back as anything more is never written.
 */
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { isMap, isScalar, isSeq, type Node, parseDocument, type YAMLMap } from "yaml"
import { writeFileWhole } from "../local/Files.ts"
import { type Launch, type PluginHome, slashes } from "./Agents.ts"

export const PLUGIN_NAME = "singularity"

/** The events the plugin hooks, as status shows them. */
export const PLUGIN_EVENTS = ["pre_llm_call", "transform_tool_result", "on_session_finalize"] as const

/** The line that marks the plugin as setup's, so uninstalling never removes a plugin of the user's own. */
const MARKER = "# Installed by `singularity setup`; `singularity uninstall` removes it."

const MANIFEST = `${MARKER}
name: ${PLUGIN_NAME}
description: "Memory from singularity: hands over what earlier sessions learned in a repository when a task starts there, warns when a mistake made before is about to happen again, and learns from the changes its sessions commit with their checks passing."
author: singularity
provides_hooks:
  - pre_llm_call
  - transform_tool_result
  - on_session_finalize
`

/** The plugin's code, with the node and the hook script it runs (JSON strings are Python strings too). */
export const pluginCode = (launch: Launch): string =>
  String.raw`${MARKER}
"""singularity's memory in Hermes Agent.

When a task starts, hands over what earlier sessions learned in its repository
(pre_llm_call); after a shell command or an edit, warns when a mistake made
there before is about to happen again (transform_tool_result); when a session
closes, stores the changes it committed with their checks passing, for
memory to learn from (on_session_finalize). All run singularity's hook script in
Claude Code's hook format. A hook must never break the session it serves:
errors go to hook-errors.log in singularity's home, and the agent carries on.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any, Optional

NODE = ${JSON.stringify(slashes(launch.node))}
SCRIPT = ${JSON.stringify(slashes(launch.script))}

# Hermes stops waiting for a plugin's hook after plugins.hook_callback_timeout, 30 s unless set.
START_TIMEOUT_S = 25
TOOL_TIMEOUT_S = 15
END_TIMEOUT_S = 25
# Hermes's tools that can trip a known mistake: shell commands and edits.
TOOLS = frozenset({"terminal", "patch", "write_file"})
# Sessions memory had nothing for, by the directory it looked in: a chat's later messages from
# there would find nothing either (a long one, through Hermes's gateway, would start node each time).
_NOTHING: dict[str, str] = {}


def _home() -> str:
    return os.environ.get("SINGULARITY_HOME") or os.path.join(os.path.expanduser("~"), ".singularity")


def _log(event: str, error: BaseException) -> None:
    try:
        os.makedirs(_home(), exist_ok=True)
        at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with open(os.path.join(_home(), "hook-errors.log"), "a", encoding="utf-8") as f:
            f.write(f"{at} hermes {event}: {type(error).__name__}: {error}\n")
    except Exception:
        pass  # Nowhere to report it; stay quiet rather than break the session.


def _has_session(session_id: str) -> bool:
    """Whether memory keeps a file for this session, having handed something over (as hook.ts checks)."""
    try:
        with open(os.path.join(_home(), "config.json"), encoding="utf-8") as f:
            tenant = json.load(f).get("tenant")
    except (OSError, ValueError, AttributeError):
        return False
    if not isinstance(tenant, str):
        return False
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id) + ".json"
    return any(os.path.exists(os.path.join(_home(), "tenants", tenant, kind, "sessions", name)) for kind in ("workflows", "web"))


def _cwd() -> str:
    """The session's working directory, as Hermes's own tools find it."""
    try:
        from agent.runtime_cwd import resolve_agent_cwd
        return str(resolve_agent_cwd())
    except Exception:
        return os.path.abspath(os.environ.get("TERMINAL_CWD") or os.getcwd())


def _in_repo(path: str) -> bool:
    """Whether a directory is in a git repository: memory knows nothing outside one."""
    here = os.path.abspath(path)
    while not os.path.exists(os.path.join(here, ".git")):
        if os.path.dirname(here) == here:
            return False
        here = os.path.dirname(here)
    return True


def _transcript(session_id: str) -> str:
    """The session as singularity names a Hermes transcript: Hermes's database, then the session's id."""
    try:
        from hermes_constants import get_hermes_home
        home = str(get_hermes_home())
    except Exception:
        # This file is <hermes home>/plugins/singularity/__init__.py.
        home = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(home, "state.db") + "#" + session_id


def _hook(event: str, payload: dict, timeout: float) -> Optional[str]:
    """Run the hook script for an event; the text it has for the model, if any."""
    node = NODE if os.path.exists(NODE) else (shutil.which("node") or NODE)
    cwd = payload.get("cwd")
    done = subprocess.run(
        [node, SCRIPT, event], input=json.dumps(payload, default=str), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout, cwd=cwd if isinstance(cwd, str) and os.path.isdir(cwd) else None,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    out = done.stdout.strip()
    text = json.loads(out).get("hookSpecificOutput", {}).get("additionalContext") if out else None
    return text if isinstance(text, str) and text.strip() else None


def _text(message: Any) -> str:
    """A user's message as text: a string, or the text parts of one with attachments."""
    if isinstance(message, list):
        return "\n".join(p["text"] for p in message if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str))
    return message if isinstance(message, str) else ""


def _off() -> bool:
    return os.environ.get("SINGULARITY_HOOKS") == "off"


def on_pre_llm_call(session_id: str = "", user_message: Any = None, **_: Any) -> Optional[dict]:
    """The hand-over, with a task's first message; follow-ups get nothing."""
    try:
        prompt = _text(user_message)
        if _off() or not session_id or not prompt.strip() or _has_session(session_id):
            return None
        cwd = _cwd()
        if _NOTHING.get(session_id) == cwd or not _in_repo(cwd):
            return None
        payload = {"session_id": session_id, "cwd": cwd, "hook_event_name": "UserPromptSubmit", "prompt": prompt}
        text = _hook("user-prompt-submit", payload, START_TIMEOUT_S)
        if text:
            return {"context": text}
        if len(_NOTHING) >= 1000:
            _NOTHING.clear()
        _NOTHING[session_id] = cwd
        return None
    except Exception as error:
        _log("pre_llm_call", error)
        return None


def on_transform_tool_result(tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "", **_: Any) -> Optional[str]:
    """A known mistake's warning, after the tool's result."""
    try:
        if _off() or tool_name not in TOOLS or not isinstance(result, str) or not session_id or not _has_session(session_id):
            return None
        payload = {
            "session_id": session_id, "cwd": _cwd(), "hook_event_name": "PostToolUse",
            "tool_name": tool_name, "tool_input": args if isinstance(args, dict) else {}, "tool_response": result,
        }
        text = _hook("post-tool-use", payload, TOOL_TIMEOUT_S)
        return f"{result}\n\n{text}" if text else None
    except Exception as error:
        _log("transform_tool_result", error)
        return None


def on_session_finalize(session_id: Optional[str] = None, **_: Any) -> None:
    """Stores the changes the closed session committed with their checks passing."""
    try:
        if _off() or not session_id:
            return None
        # No cwd: a gateway's isn't the session's; the script reads the session's own from Hermes's database.
        payload = {"session_id": session_id, "hook_event_name": "SessionEnd", "transcript_path": _transcript(session_id)}
        _hook("session-end", payload, END_TIMEOUT_S)
    except Exception as error:
        _log("on_session_finalize", error)
    return None


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_hook("transform_tool_result", on_transform_tool_result)
    ctx.register_hook("on_session_finalize", on_session_finalize)
`

// --- plugins.enabled in config.yaml ---

/** An edit of a config file: its new text, or why it was left as it was. */
export type ConfigEdit = { readonly text: string } | { readonly problem: string }

/** Hermes reads its config with PyYAML, which speaks YAML 1.1. */
const parse = (text: string) => parseDocument(text, { version: "1.1" })

const Lists = Schema.NullOr(Schema.Struct({
  plugins: Schema.optional(Schema.NullOr(Schema.Struct({
    enabled: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    disabled: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown)))
  })))
}))

/** The config's lists of enabled and disabled plugins (missing ones empty); undefined when they aren't lists. */
const decodeLists = (js: unknown): { readonly enabled: ReadonlyArray<unknown>; readonly disabled: ReadonlyArray<unknown> } | undefined => {
  const decoded = Schema.decodeUnknownOption(Lists)(js)
  if (Option.isNone(decoded)) return undefined
  const plugins = decoded.value?.plugins
  return { enabled: plugins?.enabled ?? [], disabled: plugins?.disabled ?? [] }
}

/** Whether a config's text enables the plugin: in `plugins.enabled`, not in `plugins.disabled`, which wins. */
export const enablesPlugin = (text: string, name: string = PLUGIN_NAME): boolean => {
  const doc = parse(text.replace(/^\uFEFF/, ""))
  if (doc.errors.length > 0) return false
  const lists = decodeLists(doc.toJS())
  return lists !== undefined && lists.enabled.includes(name) && !lists.disabled.includes(name)
}

/** The config's JSON with the plugin taken out of both lists, empty lists made explicit: what an edit may not change. */
const rest = (js: unknown, name: string): unknown => {
  const root = Predicate.isObject(js) ? (js as Record<string, unknown>) : {}
  const plugins = Predicate.isObject(root.plugins) ? (root.plugins as Record<string, unknown>) : {}
  const without = (list: unknown) => (Array.isArray(list) ? list.filter((x) => x !== name) : [])
  return { ...root, plugins: { ...plugins, enabled: without(plugins.enabled), disabled: without(plugins.disabled) } }
}

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1
/** Just past the end of the line `at` is on (after its newline, if it has one). */
const lineEnd = (text: string, at: number) => {
  const n = text.indexOf("\n", at)
  return n === -1 ? text.length : n + 1
}
const splice = (text: string, from: number, to: number, insert: string) => text.slice(0, from) + insert + text.slice(to)
/** Lines inserted at a line's start; a last line without a newline gets one first. */
const insertLines = (text: string, at: number, lines: string, eol: string) =>
  at > 0 && text[at - 1] !== "\n" ? splice(text, at, at, eol + lines) : splice(text, at, at, lines)

const range = (node: Node | null | undefined) => node?.range ?? undefined

/** The `plugins` section's mapping and where its key is, when there is one. */
const pluginsNode = (text: string): { readonly map?: YAMLMap; readonly key?: Node; readonly problem?: string } => {
  const doc = parse(text)
  if (doc.errors.length > 0) return { problem: "isn't valid YAML" }
  const root = doc.contents
  if (root === null) return {}
  if (!isMap(root) || root.flow === true) return { problem: "isn't a YAML mapping" }
  const pair = root.items.find((p) => isScalar(p.key) && p.key.value === "plugins")
  if (pair === undefined) return {}
  if (!isMap(pair.value)) return { problem: "has a plugins section that isn't a mapping" }
  return { map: pair.value, key: pair.key as Node }
}

/** The text with `name` added to the list at `plugins.<key>`, made where it's missing. */
const addTo = (text: string, key: "enabled" | "disabled", name: string, eol: string): ConfigEdit => {
  const { map, key: pluginsKey, problem } = pluginsNode(text)
  if (problem !== undefined) return { problem }
  if (map === undefined) {
    // No plugins section: a new one at the end.
    return { text: insertLines(text, text.length, `plugins:${eol}  ${key}:${eol}    - ${name}${eol}`, eol) }
  }
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === key)
  const at = range(map)
  if (pair === undefined) {
    if (at === undefined) return { problem: "couldn't be read" }
    if (map.flow === true) {
      const inner = text.slice(at[0] + 1, at[1] - 1).trim()
      return { text: splice(text, at[0], at[1], `{${inner === "" ? "" : `${inner}, `}${key}: [${name}]}`) }
    }
    // Right under `plugins:`, so the comments above its first entry stay with that entry.
    const first = range(map.items[0]?.key as Node | undefined)
    const head = range(pluginsKey)
    if (first === undefined || head === undefined) return { problem: "couldn't be read" }
    const indent = " ".repeat(first[0] - lineStart(text, first[0]))
    return { text: insertLines(text, lineEnd(text, head[1]), `${indent}${key}:${eol}${indent}  - ${name}${eol}`, eol) }
  }
  const list = pair.value
  const where = range(list as Node | undefined)
  if (!isSeq(list) || where === undefined) return { problem: `has plugins.${key} that isn't a list` }
  if (list.flow === true) {
    const inner = text.slice(where[0] + 1, where[1] - 1).trim()
    return { text: splice(text, where[0], where[1], `[${inner === "" ? "" : `${inner}, `}${name}]`) }
  }
  const last = range(list.items.at(-1) as Node | undefined)
  if (last === undefined) return { problem: "couldn't be read" }
  const indent = " ".repeat(where[0] - lineStart(text, where[0]))
  return { text: insertLines(text, lineEnd(text, last[1]), `${indent}- ${name}${eol}`, eol) }
}

/** The text with `name` taken out of the list at `plugins.<key>`; a list left empty becomes `[]`, as Hermes needs a list. */
const takeFrom = (text: string, key: "enabled" | "disabled", name: string, eol: string): ConfigEdit => {
  const { map, problem } = pluginsNode(text)
  if (problem !== undefined) return { problem }
  const pair = map?.items.find((p) => isScalar(p.key) && p.key.value === key)
  const list = pair?.value
  if (pair === undefined || !isSeq(list)) return { text }
  const ours = (item: unknown) => isScalar(item) && item.value === name
  const kept = list.items.filter((item) => !ours(item))
  if (kept.length === list.items.length) return { text }
  const where = range(list as Node)
  const keyAt = range(pair.key as Node | undefined)
  if (where === undefined || keyAt === undefined) return { problem: "couldn't be read" }
  if (list.flow === true) {
    const items = kept.map((item) => {
      const r = range(item as Node)
      return r === undefined ? "" : text.slice(r[0], r[1])
    })
    return { text: splice(text, where[0], where[1], `[${items.join(", ")}]`) }
  }
  if (kept.length === 0) {
    const last = range(list.items.at(-1) as Node)
    if (last === undefined) return { problem: "couldn't be read" }
    return { text: splice(text, keyAt[1], lineEnd(text, last[1]), `: []${eol}`) }
  }
  let out = text
  for (const item of [...list.items].reverse()) {
    if (!ours(item)) continue
    const r = range(item as Node)
    if (r === undefined) return { problem: "couldn't be read" }
    const from = lineStart(out, r[0])
    if (out.slice(from, r[0]).trim() !== "-") return { problem: `has plugins.${key} in a layout setup doesn't edit` }
    out = splice(out, from, lineEnd(out, r[1]), "")
  }
  return { text: out }
}

/**
 * The config with the plugin enabled (and out of `plugins.disabled`, which
 * would win), changed only there; the text as it was when it already is. An
 * edit is kept only if the file then reads back the same apart from that.
 */
export const withPluginEnabled = (source: string, name: string = PLUGIN_NAME): ConfigEdit =>
  editLists(source, name, true)

/** The config without the plugin in `plugins.enabled`, changed only there. */
export const withoutPlugin = (source: string, name: string = PLUGIN_NAME): ConfigEdit =>
  editLists(source, name, false)

const editLists = (source: string, name: string, enable: boolean): ConfigEdit => {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : ""
  const original = source.slice(bom.length)
  const eol = original.includes("\r\n") ? "\r\n" : "\n"
  const before = parse(original)
  if (before.errors.length > 0) return { problem: "isn't valid YAML" }
  const lists = decodeLists(before.toJS())
  if (lists === undefined) return { problem: "has plugins.enabled or plugins.disabled that isn't a list" }
  const steps: ReadonlyArray<(text: string) => ConfigEdit> = enable
    ? [
      ...(lists.disabled.includes(name) ? [(t: string) => takeFrom(t, "disabled", name, eol)] : []),
      ...(lists.enabled.includes(name) ? [] : [(t: string) => addTo(t, "enabled", name, eol)])
    ]
    : lists.enabled.includes(name) ? [(t: string) => takeFrom(t, "enabled", name, eol)] : []
  if (steps.length === 0) return { text: source }
  let text = original
  for (const step of steps) {
    const edit = step(text)
    if ("problem" in edit) return edit
    text = edit.text
  }
  const after = parse(text)
  const now = after.errors.length > 0 ? undefined : decodeLists(after.toJS())
  const right = now !== undefined && (enable
    ? now.enabled.includes(name) && !now.disabled.includes(name)
    : !now.enabled.includes(name) && now.disabled.includes(name) === lists.disabled.includes(name))
  if (!right || !isDeepStrictEqual(rest(after.toJS(), name), rest(before.toJS(), name))) {
    return { problem: "couldn't be changed without touching more than plugins.enabled" }
  }
  return { text: bom + text }
}

// --- the plugin's files ---

export interface PluginState {
  /** The plugin's folder holds setup's plugin (any version). */
  readonly ours: boolean
  /** It holds a plugin of the user's own with the name. */
  readonly foreign: boolean
  /** Hermes's config enables a plugin with the name. */
  readonly enabled: boolean
}

const MANIFEST_FILE = "plugin.yaml"
const CODE_FILE = "__init__.py"

const readText = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(Effect.orElseSucceed((): string | undefined => undefined))

/** What memory has in Hermes: its plugin, and whether Hermes loads it. */
export const pluginState = Effect.fn("pluginState")(function*(home: PluginHome) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = [yield* readText(fs, path.join(home.dir, MANIFEST_FILE)), yield* readText(fs, path.join(home.dir, CODE_FILE))]
    .filter((t): t is string => t !== undefined)
  const config = yield* readText(fs, home.config)
  return {
    ours: files.length > 0 && files.every((t) => t.includes(MARKER)),
    foreign: files.some((t) => !t.includes(MARKER)),
    enabled: config !== undefined && enablesPlugin(config)
  } satisfies PluginState
})

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  file: Schema.String,
  message: Schema.String
}) {}

/** Change the config file's text, keeping a copy of the user's file the first time; nothing when nothing changes. */
const editConfig = Effect.fn("editConfig")(function*(file: string, edit: (text: string) => ConfigEdit) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
  const text = exists ? yield* fs.readFileString(file).pipe(Effect.mapError((e) => new PluginError({ file, message: e.message }))) : ""
  const result = edit(text)
  if ("problem" in result) return yield* new PluginError({ file, message: result.problem })
  if (result.text === text) return false
  const backup = `${file}.before-singularity`
  if (exists && !(yield* fs.exists(backup))) yield* fs.copyFile(file, backup)
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* writeFileWhole(fs, file, result.text)
  return true
})

/**
 * Write the plugin and have Hermes load it. A plugin of the user's own with
 * the name is left alone. The config is changed once the plugin's files are
 * in place; when it can't be, Hermes's own command can still enable them.
 */
export const installPlugin = Effect.fn("installPlugin")(function*(home: PluginHome, launch: Launch) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if ((yield* pluginState(home)).foreign) {
    return yield* new PluginError({ file: home.dir, message: "holds a plugin of yours named singularity, so it was left alone" })
  }
  yield* fs.makeDirectory(home.dir, { recursive: true })
  yield* writeFileWhole(fs, path.join(home.dir, MANIFEST_FILE), MANIFEST)
  yield* writeFileWhole(fs, path.join(home.dir, CODE_FILE), pluginCode(launch))
  yield* editConfig(home.config, (text) => withPluginEnabled(text)).pipe(
    Effect.mapError((e) =>
      e._tag === "PluginError"
        ? new PluginError({ file: e.file, message: `${e.message}, so it was left alone: \`hermes plugins enable ${PLUGIN_NAME}\` turns memory on` })
        : e
    )
  )
})

/**
 * Take the plugin out of Hermes: the folder, then the config's entry, so
 * memory stops even if the config can't be changed; whether it was there.
 */
export const removePlugin = Effect.fn("removePlugin")(function*(home: PluginHome) {
  const fs = yield* FileSystem.FileSystem
  const state = yield* pluginState(home)
  if (state.foreign) return false
  if (state.ours) yield* fs.remove(home.dir, { recursive: true })
  // A name left in the list names nothing, which Hermes skips.
  const unlisted = state.enabled ? yield* editConfig(home.config, (text) => withoutPlugin(text)).pipe(Effect.orElseSucceed(() => false)) : false
  return unlisted || state.ours
})
