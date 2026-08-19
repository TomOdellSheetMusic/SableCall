/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepFilterNoiseFilterProcessor } from "deepfilternet3-noise-filter";

import {
  DeepFilterNetProcessor,
  DEEPFILTERNET_PROCESSOR_NAME,
  supportsDeepFilterNetProcessor,
} from "./DeepFilterNetProcessor";

type DeepFilterNoiseFilterProcessorOptions = Record<string, unknown>;

type DeepFilterNoiseFilterProcessorContext = {
  setEnabled?: unknown;
  setSuppressionLevel?: unknown;
  destroy?: unknown;
  init?: unknown;
  restart?: unknown;
  processedTrack?: MediaStreamTrack;
};

type NoiseFilterProcessorMock = ReturnType<typeof vi.fn> & {
  mockSetEnabled: ReturnType<typeof vi.fn>;
  mockSetSuppressionLevel: ReturnType<typeof vi.fn>;
  mockDestroy: ReturnType<typeof vi.fn>;
  mockInit: ReturnType<typeof vi.fn>;
  mockRestart: ReturnType<typeof vi.fn>;
};

vi.mock("deepfilternet3-noise-filter", () => {
  const mockSetEnabled = vi.fn().mockResolvedValue(true);
  const mockSetSuppressionLevel = vi.fn();
  const mockDestroy = vi.fn().mockResolvedValue(undefined);
  const mockInit = vi.fn().mockResolvedValue(undefined);
  const mockRestart = vi.fn().mockResolvedValue(undefined);

  const mockDeepFilterNoiseFilterProcessor = vi
    .fn()
    .mockImplementation(function DeepFilterNoiseFilterProcessor(
      this: DeepFilterNoiseFilterProcessorContext,
      options: DeepFilterNoiseFilterProcessorOptions,
    ): void {
      Object.assign(this, options);
      this.setEnabled = mockSetEnabled;
      this.setSuppressionLevel = mockSetSuppressionLevel;
      this.destroy = mockDestroy;
      this.init = mockInit;
      this.restart = mockRestart;
      this.processedTrack = {} as MediaStreamTrack;
    });

  Object.assign(mockDeepFilterNoiseFilterProcessor, {
    mockSetEnabled,
    mockSetSuppressionLevel,
    mockDestroy,
    mockInit,
    mockRestart,
  });

  return {
    __esModule: true,
    DeepFilterNoiseFilterProcessor: mockDeepFilterNoiseFilterProcessor,
  };
});

const mockDeepFilterNoiseFilterProcessor =
  DeepFilterNoiseFilterProcessor as unknown as NoiseFilterProcessorMock;

const mockTrack = { kind: "audio" } as MediaStreamTrack;

class MockAudioContext {
  public sampleRate = 48000;
  public state: AudioContextState = "running";
  public audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
  };
  public createMediaStreamSource = vi.fn();
  public createMediaStreamDestination = vi.fn();
  public close = vi.fn().mockResolvedValue(undefined);
  public resume = vi.fn().mockResolvedValue(undefined);
}

describe("DeepFilterNetProcessor", () => {
  beforeEach((): void => {
    mockDeepFilterNoiseFilterProcessor.mockSetEnabled.mockClear();
    mockDeepFilterNoiseFilterProcessor.mockSetSuppressionLevel.mockClear();
    mockDeepFilterNoiseFilterProcessor.mockDestroy.mockClear();
    mockDeepFilterNoiseFilterProcessor.mockInit.mockClear();
    mockDeepFilterNoiseFilterProcessor.mockRestart.mockClear();
    mockDeepFilterNoiseFilterProcessor.mockClear();

    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("WebAssembly", {});
    vi.stubGlobal(
      "MediaStreamAudioDestinationNode",
      class MediaStreamAudioDestinationNode {},
    );
    vi.stubGlobal(
      "MediaStreamAudioSourceNode",
      class MediaStreamAudioSourceNode {},
    );
  });

  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it("has the expected processor name", (): void => {
    const processor = new DeepFilterNetProcessor();
    expect(processor.name).toBe(DEEPFILTERNET_PROCESSOR_NAME);
  });

  it("initializes the underlying processor with the expected configuration", async (): Promise<void> => {
    const processor = new DeepFilterNetProcessor(0.5, false);

    await processor.init({ track: mockTrack } as never);

    expect(mockDeepFilterNoiseFilterProcessor).toHaveBeenCalledTimes(1);
    expect(mockDeepFilterNoiseFilterProcessor).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleRate: 48000,
        noiseReductionLevel: 50,
        enabled: false,
        assetConfig: expect.objectContaining({
          cdnUrl: expect.any(String),
        }),
      }),
    );
    expect(mockDeepFilterNoiseFilterProcessor.mockInit).toHaveBeenCalledTimes(1);
    expect(processor.processedTrack).toBeDefined();
  });

  it("creates a dedicated 48kHz AudioContext for DeepFilterNet", async (): Promise<void> => {
    const MockAudioContextSpy = vi.fn(MockAudioContext);
    vi.stubGlobal("AudioContext", MockAudioContextSpy);

    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);

    expect(MockAudioContextSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: 48000 }),
    );
  });

  it("throws when the platform cannot create a 48kHz AudioContext", async (): Promise<void> => {
    vi.stubGlobal(
      "AudioContext",
      class {
        public constructor() {
          throw new Error("not supported");
        }
      },
    );

    const processor = new DeepFilterNetProcessor();
    await expect(processor.init({ track: mockTrack } as never)).rejects.toThrow(
      /48000Hz AudioContext/,
    );
  });

  it("throws when the AudioContext sample rate is not 48kHz", async (): Promise<void> => {
    vi.stubGlobal(
      "AudioContext",
      class {
        public sampleRate = 44100;
        public state: AudioContextState = "running";
        public close = vi.fn().mockResolvedValue(undefined);
      },
    );

    const processor = new DeepFilterNetProcessor();
    await expect(processor.init({ track: mockTrack } as never)).rejects.toThrow(
      /48000Hz AudioContext/,
    );
  });

  it("does not initialize the underlying processor twice", async (): Promise<void> => {
    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);
    await processor.init({ track: mockTrack } as never);

    expect(mockDeepFilterNoiseFilterProcessor).toHaveBeenCalledTimes(1);
  });

  it("forwards suppression level changes and clamps out-of-range values", async (): Promise<void> => {
    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);

    processor.setSuppressionLevel(1.5);
    processor.setSuppressionLevel(-0.2);

    expect(
      mockDeepFilterNoiseFilterProcessor.mockSetSuppressionLevel,
    ).toHaveBeenNthCalledWith(1, 100);
    expect(
      mockDeepFilterNoiseFilterProcessor.mockSetSuppressionLevel,
    ).toHaveBeenNthCalledWith(2, 0);
  });

  it("forwards enabled state changes to the underlying processor", async (): Promise<void> => {
    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);

    await processor.setEnabled(false);
    await processor.setEnabled(true);

    expect(mockDeepFilterNoiseFilterProcessor.mockSetEnabled).toHaveBeenNthCalledWith(
      1,
      false,
    );
    expect(mockDeepFilterNoiseFilterProcessor.mockSetEnabled).toHaveBeenNthCalledWith(
      2,
      true,
    );
  });

  it("destroys the processor and resets internal state", async (): Promise<void> => {
    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);

    await processor.destroy();

    expect(mockDeepFilterNoiseFilterProcessor.mockDestroy).toHaveBeenCalledTimes(
      1,
    );
    expect(processor.processedTrack).toBeUndefined();
  });

  it("reports support based on required APIs", (): void => {
    expect(supportsDeepFilterNetProcessor()).toBe(true);
  });
});
