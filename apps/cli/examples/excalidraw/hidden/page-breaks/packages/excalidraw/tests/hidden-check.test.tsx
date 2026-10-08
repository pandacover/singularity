// Hidden check for the "page-breaks" task: a "Show page breaks" setting backed
// by appState.pageBreaksEnabled, offered only in the main menu's Preferences,
// with no context menu item.
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

const FIELD = "pageBreaksEnabled";
const LABEL = "Show page breaks";
const KEEP = { browser: true, export: false, server: false };

const flag = () => (window.h.state as unknown as Record<string, unknown>)[FIELD];

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

const openPreferences = () => {
  fireEvent.click(document.querySelector(".dropdown-menu-button")!);
  const trigger = [...document.querySelectorAll(".dropdown-menu-item")].find(
    (el) => el.textContent?.includes("Preferences"),
  );
  expect(trigger).toBeDefined();
  act(() => {
    fireEvent.click(trigger!);
  });
  return document.querySelector(".excalidraw-main-menu-preferences-submenu");
};

describe("hidden: Show page breaks setting", () => {
  it("adds the state field with its storage rules", () => {
    expect((getDefaultAppState() as unknown as Record<string, unknown>)[FIELD]).toBe(false);
    const state = { [FIELD]: true } as any;
    expect(FIELD in clearAppStateForLocalStorage(state)).toBe(KEEP.browser);
    expect(FIELD in cleanAppStateForExport(state)).toBe(KEEP.export);
    expect(FIELD in clearAppStateForDatabase(state)).toBe(KEEP.server);
  });

  it("toggles from Preferences in the main menu", async () => {
    await render(
      <Excalidraw>
        <MainMenu>
          <MainMenu.DefaultItems.Preferences />
        </MainMenu>
      </Excalidraw>,
    );
    expect(flag()).toBe(false);
    const submenu = openPreferences();
    expect(submenu?.textContent).toContain(LABEL);
    const item = [
      ...(submenu?.querySelectorAll(".dropdown-menu-item") ?? []),
    ].find((el) => el.textContent?.includes(LABEL));
    expect(item).toBeDefined();
    act(() => {
      fireEvent.click(item!);
    });
    expect(flag()).toBe(true);
  });

  it("is not in the canvas context menu", async () => {
    await render(<Excalidraw />);
    expect(contextMenuLabels()).not.toContain(LABEL);
  });

  it("is not in the view mode context menu", async () => {
    await render(<Excalidraw />);
    API.setAppState({ viewModeEnabled: true });
    expect(contextMenuLabels()).not.toContain(LABEL);
  });
});
