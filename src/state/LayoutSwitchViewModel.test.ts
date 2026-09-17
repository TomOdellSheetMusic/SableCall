/*
Copyright 2025 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, test } from "vitest";

import { createLayoutSwitchViewModel } from "./LayoutSwitchViewModel";
import { testScope, withTestScheduler } from "../utils/test";

function testLayoutSwitch({
  windowMode = "n",
  userSelection = "",
  expectedLayout,
}: {
  windowMode?: string;
  userSelection?: string;
  expectedLayout: string;
}): void {
  withTestScheduler(({ behavior, schedule, expectObservable }) => {
    const { layout$, setLayout } = createLayoutSwitchViewModel(
      testScope(),
      behavior(windowMode, { n: "normal", N: "narrow", f: "flat" }),
    );
    schedule(userSelection, {
      g: () => setLayout("grid"),
      s: () => setLayout("spotlight"),
    });
    expectObservable(layout$).toBe(expectedLayout, {
      g: "grid",
      s: "spotlight",
    });
  });
}

describe("default mode", () => {
  test("uses grid layout in normal window", () =>
    testLayoutSwitch({
      windowMode: "    n",
      expectedLayout: "g",
    }));

  test("uses grid layout in flat window", () =>
    testLayoutSwitch({
      windowMode: "    f",
      expectedLayout: "g",
    }));
});

test("allows switching modes manually", () =>
  testLayoutSwitch({
    userSelection: " --sgs",
    expectedLayout: "g-sgs",
  }));

test("allows switching modes manually when in flat window mode", () =>
  testLayoutSwitch({
    // Window becomes flat, then user switches to spotlight and back.
    // Finally the window returns to a normal shape.
    windowMode: "    nf--n",
    userSelection: " --sg",
    expectedLayout: "g-sg",
  }));
