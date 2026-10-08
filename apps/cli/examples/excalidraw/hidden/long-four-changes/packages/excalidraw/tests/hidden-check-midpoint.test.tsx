// Hidden check for the "midpoint-snap-n" task: the existing midpointSnapping
// action, which had no shortcut, gets Alt+N, listed in the help dialog.
import React from "react";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { fireEvent, render } from "./test-utils";

const FLAG = "isMidpointSnappingEnabled";
const NEW = "N";
const LABEL = "Snap to midpoints";

const altPress = (letter: string) =>
  fireEvent.keyDown(document, {
    key: letter.toLowerCase(),
    code: `Key${letter}`,
    altKey: true,
  });

describe("hidden: midpointSnapping shortcut Alt+N", () => {
  const h = window.h;

  it("toggles on the new shortcut", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    const flag = () => (h.state as Record<string, any>)[FLAG];
    expect(flag()).toBe(true);

    altPress(NEW);
    expect(flag()).toBe(false);

    altPress(NEW);
    expect(flag()).toBe(true);
  });

  it("doesn't switch tools on the new shortcut", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    const tool = h.state.activeTool.type;
    altPress(NEW);
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
    expect(keys).toEqual(["Alt", NEW]);
  });
});
