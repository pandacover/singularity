// Hidden check for the "stats-shortcut-k" task: the stats panel's shortcut
// moves from Alt+/ to Alt+K. (The test the prompt asks for is checked by
// hidden-check-agent-test.mjs and by running excalidraw.test.tsx.)
import React from "react";

import { Excalidraw } from "../index";
import { getShortcutFromShortcutName } from "../actions/shortcuts";

import { API } from "./helpers/api";
import { fireEvent, render } from "./test-utils";

const LABEL = "Canvas & Shape properties";

const altPress = (key: string, code: string) =>
  fireEvent.keyDown(document, { key, code, altKey: true });

describe("hidden: stats shortcut Alt+/ -> Alt+K", () => {
  const h = window.h;

  it("reports the new shortcut", () => {
    expect(getShortcutFromShortcutName("stats")).toBe("Alt+K");
  });

  it("toggles on the new shortcut and ignores the old one", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    expect(h.state.stats.open).toBe(false);

    altPress("/", "Slash");
    expect(h.state.stats.open).toBe(false);

    altPress("k", "KeyK");
    expect(h.state.stats.open).toBe(true);

    altPress("k", "KeyK");
    expect(h.state.stats.open).toBe(false);
  });

  it("doesn't switch tools on the new shortcut", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    const tool = h.state.activeTool.type;
    altPress("k", "KeyK");
    expect(h.state.activeTool.type).toBe(tool);
  });

  it("lists the new shortcut in the help dialog", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    API.setAppState({ openDialog: { name: "help" } });
    const row = [...document.querySelectorAll(".HelpDialog__shortcut")].find(
      (el) => el.firstElementChild?.textContent === LABEL,
    );
    expect(row).toBeDefined();
    const keys = [...row!.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(keys).toEqual(["Alt", "K"]);
  });
});
