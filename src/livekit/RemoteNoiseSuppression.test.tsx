/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { RemoteAudioTrack } from "livekit-client";

import {
  useRemoteNoiseSuppression,
  isMicrophoneSource,
} from "./RemoteNoiseSuppression";
import {
  deepFilterNetNoiseSuppressionIncoming,
  deepFilterNetNoiseSuppressionLevel,
  rnnoiseNoiseSuppressionIncoming,
  rnnoiseNoiseSuppressionPreset,
} from "../settings/settings";

vi.mock("./test", () => ({}));

type FakeTrack = {
  setProcessor: ReturnType<typeof vi.fn>;
  stopProcessor: ReturnType<typeof vi.fn>;
  getProcessor: () => { name: string } | undefined;
  setAudioContext: ReturnType<typeof vi.fn>;
};

// A minimal fake track mirroring the RemoteAudioTrack surface the hook uses.
function createTrack(): RemoteAudioTrack & FakeTrack {
  // Simulates the processor currently attached to the track, so `getProcessor`
  // reflects what `setProcessor`/`stopProcessor` were asked to do. This lets
  // the tests assert which engine the hook actually chose.
  const applyMock: { name?: string } = {};
  const track: FakeTrack = {
    setProcessor: vi.fn((p: { name: string }) => {
      applyMock.name = p.name;
    }),
    stopProcessor: vi.fn(() => {
      applyMock.name = undefined;
    }),
    getProcessor: (): { name: string } | undefined =>
      applyMock.name === undefined ? undefined : { name: applyMock.name },
    setAudioContext: vi.fn(),
  };
  return track as unknown as RemoteAudioTrack & FakeTrack;
}

const audioContext = {} as AudioContext;

describe("useRemoteNoiseSuppression", () => {
  beforeEach(() => {
    localStorage.clear();
    rnnoiseNoiseSuppressionIncoming.setValue(false);
    rnnoiseNoiseSuppressionPreset.setValue("conservative");
    deepFilterNetNoiseSuppressionIncoming.setValue(false);
    deepFilterNetNoiseSuppressionLevel.setValue(0.35);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("attaches no processor when both incoming settings are off", async () => {
    const track = createTrack();
    renderHook(() =>
      useRemoteNoiseSuppression(track, true, audioContext),
    );
    // Let the initial async application run.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(track.setProcessor).not.toHaveBeenCalled();
    expect(track.stopProcessor).not.toHaveBeenCalled();
  });

  it("attaches an RNNoise processor when RNNoise incoming is enabled", async () => {
    const track = createTrack();
    rnnoiseNoiseSuppressionIncoming.setValue(true);

    const { result } = renderHook(() =>
      useRemoteNoiseSuppression(track, true, audioContext),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(track.setProcessor).toHaveBeenCalledOnce();
    expect(track.getProcessor()).toEqual({ name: "rnnoise-noise-suppression" });
    expect(track.setAudioContext).toHaveBeenCalledWith(audioContext);
    expect(result.current.active).toBe(true);
  });

  it("DeepFilterNet takes precedence over RNNoise", async () => {
    const track = createTrack();
    rnnoiseNoiseSuppressionIncoming.setValue(true);
    deepFilterNetNoiseSuppressionIncoming.setValue(true);

    renderHook(() => useRemoteNoiseSuppression(track, true, audioContext));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(track.getProcessor()?.name).toBe(
      "deepfilternet-noise-suppression",
    );
    expect(track.setProcessor).toHaveBeenCalledOnce();
  });

  it("removes the processor when the incoming setting is toggled off", async () => {
    const track = createTrack();
    rnnoiseNoiseSuppressionIncoming.setValue(true);

    renderHook(() => useRemoteNoiseSuppression(track, true, audioContext));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(track.getProcessor()?.name).toBe("rnnoise-noise-suppression");

    act(() => {
      rnnoiseNoiseSuppressionIncoming.setValue(false);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(track.getProcessor()).toBeUndefined();
    expect(track.stopProcessor).toHaveBeenCalled();
  });

  it("never processes a non-microphone track (e.g. screen share audio)", async () => {
    const track = createTrack();
    rnnoiseNoiseSuppressionIncoming.setValue(true);
    deepFilterNetNoiseSuppressionIncoming.setValue(true);

    renderHook(() => useRemoteNoiseSuppression(track, false, audioContext));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(track.setProcessor).not.toHaveBeenCalled();
    expect(track.stopProcessor).not.toHaveBeenCalled();
  });

  it("isMicrophoneSource only accepts the microphone source", () => {
    expect(
      isMicrophoneSource({
        publication: { source: "microphone" },
      } as never),
    ).toBe(true);
    expect(
      isMicrophoneSource({
        publication: { source: "screen_share_audio" },
      } as never),
    ).toBe(false);
  });
});