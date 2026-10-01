// Hidden check for the "appstate-export-padding" task: a new appState field `exportPadding`.
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

const FIELD = "exportPadding";
const DEFAULT: unknown = 10;
const OTHER: unknown = 24;
const KEEP = { browser: true, export: true, server: false };

const get = (state: object | null | undefined) =>
  (state as Record<string, unknown> | null | undefined)?.[FIELD];

describe("hidden: appState.exportPadding", () => {
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

  it("rejects invalid imported values", () => {
    for (const bad of [-1, "20", null, Number.NaN]) {
      expect(get(restoreAppState({ [FIELD]: bad } as any, null))).toEqual(
        DEFAULT,
      );
    }
    expect(get(restoreAppState({ [FIELD]: 0 } as any, null))).toEqual(0);
  });

  it("is part of the editor's state", async () => {
    await render(<Excalidraw />);
    expect(get(h.state)).toEqual(DEFAULT);
  });
});
