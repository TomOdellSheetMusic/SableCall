/*
Copyright 2026 Element Software Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it } from "vitest";

import {
  participantVolumes$,
  setParticipantVolume,
} from "./participantVolume";

describe("participantVolume", () => {
  beforeEach(() => {
    participantVolumes$.next(new Map());
  });

  it("tracks the volume of each audio source", () => {
    setParticipantVolume("@alice:example.org:AAAA", 1);
    expect(participantVolumes$.value).toEqual(
      new Map([["@alice:example.org:AAAA", 1]]),
    );

    setParticipantVolume("@bob:example.org:BBBB", 1.5);
    expect(participantVolumes$.value).toEqual(
      new Map([
        ["@alice:example.org:AAAA", 1],
        ["@bob:example.org:BBBB", 1.5],
      ]),
    );

    // Screen shares are tracked under their own key, so they can be
    // controlled (and muted) independently of the mic.
    setParticipantVolume("@alice:example.org:AAAA:screen-share", 0);
    expect(participantVolumes$.value.get("@alice:example.org:AAAA")).toBe(1);
    expect(
      participantVolumes$.value.get("@alice:example.org:AAAA:screen-share"),
    ).toBe(0);
  });

  it("emits when a volume changes", () => {
    const values: Map<string, number>[] = [];
    const sub = participantVolumes$.subscribe((v) => values.push(v));
    setParticipantVolume("@alice:example.org:AAAA", 1);
    expect(values.length).toBe(2);
    // Setting the same value again does not emit.
    setParticipantVolume("@alice:example.org:AAAA", 1);
    expect(values.length).toBe(2);
    sub.unsubscribe();
  });
});
