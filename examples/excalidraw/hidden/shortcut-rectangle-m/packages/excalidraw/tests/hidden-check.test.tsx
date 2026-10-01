// Hidden check for the "shortcut-rectangle-m" task: the rectangle tool's letter shortcut
// moves from "r" to "m". The numeric shortcut stays "2".
import React from "react";

import { KEYS } from "@excalidraw/common";

import { Excalidraw } from "../index";
import { findShapeByKey } from "../components/Tools";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { act, render } from "./test-utils";

import type { AppClassProperties } from "../types";

const TOOL = "rectangle";
const OLD = "r";
const NEW = "m";
const NUM = "2";
const LABEL = "Rectangle";

const app = {
  state: { preferredSelectionTool: { type: "selection" } },
} as AppClassProperties;

describe("hidden: rectangle shortcut r -> m", () => {
  const h = window.h;

  it("defines the new key constant", () => {
    expect((KEYS as Record<string, string>)[NEW.toUpperCase()]).toBe(NEW);
  });

  it("maps the new letter to the tool and the old one to nothing", () => {
    expect(findShapeByKey(NEW, app)).toBe(TOOL);
    expect(findShapeByKey(NEW.toUpperCase(), app)).toBe(TOOL);
    expect(findShapeByKey(NUM, app)).toBe(TOOL);
    expect(findShapeByKey(OLD, app)).not.toBe(TOOL);
  });

  it("switches tools from the keyboard", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    expect(h.state.activeTool.type).toBe("selection");

    Keyboard.keyPress(NEW);
    expect(h.state.activeTool.type).toBe(TOOL);

    act(() => h.app.setActiveTool({ type: "selection" }));
    Keyboard.keyPress(OLD);
    expect(h.state.activeTool.type).not.toBe(TOOL);

    act(() => h.app.setActiveTool({ type: "selection" }));
    Keyboard.keyPress(NUM);
    expect(h.state.activeTool.type).toBe(TOOL);
  });

  it("shows the new letter on the toolbar badge", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    const badge = document
      .querySelector(`[data-testid="toolbar-${TOOL}"]`)
      ?.querySelector(".ToolIcon__keybinding")?.textContent;
    expect(badge).toBe(NEW.toUpperCase());
  });

  it("lists the new letter in the help dialog", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    API.setAppState({ openDialog: { name: "help" } });
    const row = [...document.querySelectorAll(".HelpDialog__shortcut")].find(
      (el) => el.firstElementChild?.textContent === LABEL,
    );
    expect(row).toBeDefined();
    const keys = [...row!.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(keys).toContain(NEW.toUpperCase());
    expect(keys).toContain(NUM);
    expect(keys).not.toContain(OLD.toUpperCase());
  });
});
