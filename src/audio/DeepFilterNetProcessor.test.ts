/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeepFilterNetProcessor,
  DEEPFILTERNET_PROCESSOR_NAME,
  supportsDeepFilterNetProcessor,
} from "./DeepFilterNetProcessor";

const { WORKLET_MODULE_URL } = vi.hoisted(() => ({
  WORKLET_MODULE_URL:
    "/src/audio/DeepFilterNetWorkletModule.ts?worker_file&type=module",
}));

vi.mock("./DeepFilterNetWorkletModule.ts?url", () => ({
  default: WORKLET_MODULE_URL,
}));

const mockTrack = { kind: "audio" } as MediaStreamTrack;

class MockAudioContext {
  public sampleRate = 44100;
  public state: AudioContextState = "running";
  public audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
  };
  public createMediaStreamSource = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  public createMediaStreamDestination = vi.fn().mockReturnValue({
    stream: { getAudioTracks: () => [{ stop: vi.fn() }] },
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  public close = vi.fn().mockResolvedValue(undefined);
  public resume = vi.fn().mockResolvedValue(undefined);
}

class MockAudioWorkletNode {
  public port = {
    postMessage: vi.fn(),
  };
  public connect = vi.fn();
  public disconnect = vi.fn();
}

describe("DeepFilterNetProcessor", () => {
  beforeEach((): void => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
    vi.stubGlobal("WebAssembly", {
      compile: vi.fn().mockResolvedValue({}),
    });
    vi.stubGlobal(
      "MediaStreamAudioDestinationNode",
      class MediaStreamAudioDestinationNode {},
    );
    vi.stubGlobal(
      "MediaStreamAudioSourceNode",
      class MediaStreamAudioSourceNode {},
    );
    vi.stubGlobal("MediaStream", class MediaStream {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      }),
    );
  });

  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it("has the expected processor name", (): void => {
    const processor = new DeepFilterNetProcessor();
    expect(processor.name).toBe(DEEPFILTERNET_PROCESSOR_NAME);
  });

  it("fetches and compiles the DeepFilterNet assets on init", async (): Promise<void> => {
    const processor = new DeepFilterNetProcessor(0.5, false);

    await processor.init({ track: mockTrack } as never);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v3/pkg/df_bg.wasm"),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v3/models/DeepFilterNet3_onnx.tar.gz"),
    );
    expect(WebAssembly.compile).toHaveBeenCalled();
    expect(processor.processedTrack).toBeDefined();
  });

  it("creates an AudioContext at the native sample rate (no 48kHz requirement)", async (): Promise<void> => {
    const MockAudioContextSpy = vi.fn(MockAudioContext);
    vi.stubGlobal("AudioContext", MockAudioContextSpy);

    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);

    expect(MockAudioContextSpy).toHaveBeenCalledWith();
  });

  it("registers the worklet module on the AudioContext", async (): Promise<void> => {
    const MockAudioContextSpy = vi.fn(MockAudioContext);
    vi.stubGlobal("AudioContext", MockAudioContextSpy);

    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);

    const context = MockAudioContextSpy.mock.results[0].value as MockAudioContext;
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith(
      WORKLET_MODULE_URL,
    );
  });

  it("throws when the WASM fetch fails", async (): Promise<void> => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    );

    const processor = new DeepFilterNetProcessor();
    await expect(processor.init({ track: mockTrack } as never)).rejects.toThrow(
      /Failed to fetch DeepFilterNet WASM/,
    );
  });

  it("throws when the model fetch fails", async (): Promise<void> => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    vi.stubGlobal("fetch", fetchMock);

    const processor = new DeepFilterNetProcessor();
    await expect(processor.init({ track: mockTrack } as never)).rejects.toThrow(
      /Failed to fetch DeepFilterNet model/,
    );
  });

  it("does not initialize twice", async (): Promise<void> => {
    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);
    await processor.init({ track: mockTrack } as never);

    expect(WebAssembly.compile).toHaveBeenCalledTimes(1);
  });

  it("destroys the processor and resets internal state", async (): Promise<void> => {
    const processor = new DeepFilterNetProcessor();
    await processor.init({ track: mockTrack } as never);

    await processor.destroy();

    expect(processor.processedTrack).toBeUndefined();
  });

  it("reports support based on required APIs", (): void => {
    expect(supportsDeepFilterNetProcessor()).toBe(true);
  });
});
