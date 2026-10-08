// Hidden check for the "toggle-rulers" task: a "Rulers" toggle backed by
// appState.rulersEnabled, with an Alt+U shortcut, a canvas context menu item,
// a help dialog entry and a main menu preference.
import React from "react";

import {
  cleanAppStateForExport,
  clearAppStateForDatabase,
  clearAppStateForLocalStorage,
  getDefaultAppState,
} from "../appState";
import { Excalidraw, MainMenu } from "../index";

import { API } from "./helpers/api";
import { UI } from "./helpers/ui";
import { act, fireEvent, GlobalTestState, render } from "./test-utils";

const FIELD = "rulersEnabled";
const LETTER = "U";
const LABEL = "Rulers";
const KEEP = { browser: true, export: true, server: false };
const IN_VIEW_MODE = true;

const flag = () => (window.h.state as unknown as Record<string, unknown>)[FIELD];

const altPress = (letter: string) =>
  fireEvent.keyDown(document, {
    key: letter.toLowerCase(),
    code: `Key${letter}`,
    altKey: true,
  });

const contextMenuLabels = () => {
  fireEvent.contextMenu(GlobalTestState.interactiveCanvas, {
    button: 2,
    clientX: 1,
    clientY: 1,
  });
  const menu = UI.queryContextMenu();
  return [...(menu?.querySelectorAll(".context-menu li") ?? [])].map(
    (li) => li.querySelector(".context-menu-item__label")?.textContent,
  );
};

describe("hidden: Rulers toggle", () => {
  it("adds the state field with its storage rules", () => {
    expect((getDefaultAppState() as unknown as Record<string, unknown>)[FIELD]).toBe(false);
    const state = { [FIELD]: true } as any;
    expect(FIELD in clearAppStateForLocalStorage(state)).toBe(KEEP.browser);
    expect(FIELD in cleanAppStateForExport(state)).toBe(KEEP.export);
    expect(FIELD in clearAppStateForDatabase(state)).toBe(KEEP.server);
  });

  it("toggles with Alt+U", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    expect(flag()).toBe(false);
    altPress(LETTER);
    expect(flag()).toBe(true);
    altPress(LETTER);
    expect(flag()).toBe(false);
  });

  it("toggles from the canvas context menu", async () => {
    await render(<Excalidraw />);
    expect(contextMenuLabels()).toContain(LABEL);
    const item = [
      ...(UI.queryContextMenu()?.querySelectorAll(".context-menu li") ?? []),
    ].find(
      (li) =>
        li.querySelector(".context-menu-item__label")?.textContent === LABEL,
    );
    fireEvent.click(item!.querySelector("button")!);
    expect(flag()).toBe(true);
  });

  it("is in the view mode context menu", async () => {
    await render(<Excalidraw />);
    API.setAppState({ viewModeEnabled: true });
    expect(contextMenuLabels().includes(LABEL)).toBe(IN_VIEW_MODE);
  });

  it("lists the shortcut in the help dialog", async () => {
    await render(<Excalidraw />);
    API.setAppState({ openDialog: { name: "help" } });
    const row = [...document.querySelectorAll(".HelpDialog__shortcut")].find(
      (el) => el.firstElementChild?.textContent === LABEL,
    );
    expect(row).toBeDefined();
    const keys = [...row!.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(keys).toEqual(["Alt", LETTER]);
  });

  it("is a main menu preference", async () => {
    await render(
      <Excalidraw>
        <MainMenu>
          <MainMenu.DefaultItems.Preferences />
        </MainMenu>
      </Excalidraw>,
    );
    fireEvent.click(document.querySelector(".dropdown-menu-button")!);
    const trigger = [...document.querySelectorAll(".dropdown-menu-item")].find(
      (el) => el.textContent?.includes("Preferences"),
    );
    expect(trigger).toBeDefined();
    act(() => {
      fireEvent.click(trigger!);
    });
    const submenu = document.querySelector(
      ".excalidraw-main-menu-preferences-submenu",
    );
    expect(submenu?.textContent).toContain(LABEL);
  });
});
