// Hidden check for the "appstate-minimap" task: a new appState field `minimapEnabled`.
import React from "react";

import {
  cleanAppStateForExport,
  clearAppStateForDatabase,
  clearAppStateForLocalStorage,
  getDefaultAppState,
} from "../appState";
import { restoreAppState } from "../data/restore";
import { Excalidraw } from "../index";

import { render } from "./test-utils";

const FIELD = "minimapEnabled";
const DEFAULT: unknown = false;
const OTHER: unknown = true;
const KEEP = { browser: true, export: false, server: false };

const get = (state: object | null | undefined) =>
  (state as Record<string, unknown> | null | undefined)?.[FIELD];

describe("hidden: appState.minimapEnabled", () => {
  const h = window.h;

  it("has a default", () => {
    expect(get(getDefaultAppState())).toEqual(DEFAULT);
  });

  it("is stored only where it should be", () => {
    const state = { [FIELD]: OTHER } as any;
    expect(FIELD in clearAppStateForLocalStorage(state)).toBe(KEEP.browser);
    expect(FIELD in cleanAppStateForExport(state)).toBe(KEEP.export);
    expect(FIELD in clearAppStateForDatabase(state)).toBe(KEEP.server);
  });

  it("restores supplied values and falls back to the default", () => {
    expect(get(restoreAppState({ [FIELD]: OTHER } as any, null))).toEqual(OTHER);
    expect(get(restoreAppState({}, null))).toEqual(DEFAULT);
  });

  it("is part of the editor's state", async () => {
    await render(<Excalidraw />);
    expect(get(h.state)).toEqual(DEFAULT);
  });
});
