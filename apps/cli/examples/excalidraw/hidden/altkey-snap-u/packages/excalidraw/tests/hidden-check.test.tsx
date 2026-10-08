// Hidden check for the "altkey-snap-u" task: the objectsSnapMode action's shortcut moves
// from Alt+S to Alt+U.
import React from "react";

import { CODES } from "@excalidraw/common";

import { Excalidraw } from "../index";
import { getShortcutFromShortcutName } from "../actions/shortcuts";

import { API } from "./helpers/api";
import { fireEvent, render } from "./test-utils";

const ACTION = "objectsSnapMode";
const FLAG = "objectsSnapModeEnabled";
const OLD = "S";
const NEW = "U";
const LABEL = "Snap to objects";

const altPress = (letter: string) =>
  fireEvent.keyDown(document, {
    key: letter.toLowerCase(),
    code: `Key${letter}`,
    altKey: true,
  });

describe("hidden: objectsSnapMode shortcut Alt+S -> Alt+U", () => {
  const h = window.h;

  it("defines the new key code", () => {
    expect((CODES as Record<string, string>)[NEW]).toBe(`Key${NEW}`);
  });

  it("reports the new shortcut", () => {
    expect(getShortcutFromShortcutName(ACTION)).toBe(`Alt+${NEW}`);
  });

  it("toggles on the new shortcut and ignores the old one", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    const flag = () => (h.state as Record<string, any>)[FLAG];
    expect(flag()).toBe(false);

    altPress(OLD);
    expect(flag()).toBe(false);

    altPress(NEW);
    expect(flag()).toBe(true);

    altPress(NEW);
    expect(flag()).toBe(false);
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
