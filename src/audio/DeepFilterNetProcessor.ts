/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/lib/logger";

import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";
import deepFilterNetWorkletModuleUrl from "./DeepFilterNetWorkletModule.ts?worker&url";

/**
 * The default noise reduction level (0-1), mapped to the package's 0-100 scale.
 */
const DEFAULT_NOISE_REDUCTION_LEVEL = 0.75;

/**
 * The name used to identify this processor on a LiveKit track.
 */
export const DEEPFILTERNET_PROCESSOR_NAME = "deepfilternet-noise-suppression";

/**
 * The base path where the DeepFilterNet WASM binary and ONNX model are served
 * from. Resolves `import.meta.env.BASE_URL` against the current page location
 * so the assets resolve correctly even when the app is hosted under a subpath
 * (e.g. `/element-call/`). Overridable via the `VITE_NOISE_SUPPRESSION_CDN_URL`
 * env var for custom deployments.
 */
function resolveAssetUrl(): string {
  if (import.meta.env.VITE_NOISE_SUPPRESSION_CDN_URL) {
    return import.meta.env.VITE_NOISE_SUPPRESSION_CDN_URL;
  }

  // BASE_URL is `./` in the embedded build, so resolve it against the current
  // page to get the absolute app root (e.g. https://host/element-call/).
  const baseUrl = new URL(import.meta.env.BASE_URL, window.location.href);
  return `${baseUrl.href}assets/deepfilternet3`;
}

/**
 * Whether the current runtime supports the APIs required by DeepFilterNet.
 */
export function supportsDeepFilterNetProcessor(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof MediaStreamAudioDestinationNode !== "undefined" &&
    typeof MediaStreamAudioSourceNode !== "undefined"
  );
}

/**
 * A LiveKit TrackProcessor that applies DeepFilterNet3-based noise
 * suppression to a local audio track.
 *
 * DeepFilterNet is a deep-learning speech enhancement model that provides
 * significantly better noise suppression than RNNoise, especially for
 * non-stationary noise (keyboard, traffic, etc.). It runs in an AudioWorklet
 * and loads its WASM binary and ONNX model from locally-bundled assets.
 *
 * Unlike the `deepfilternet3-noise-filter` package (which hard-requires a
 * 48kHz AudioContext and fails on Windows/desktop WebViews that run at
 * 44.1kHz), this processor uses a custom worklet that resamples between the
 * AudioContext's native sample rate and the 48kHz the model expects. This
 * makes DeepFilterNet work on any platform, including Windows WebView2.
 */
export class DeepFilterNetProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  public name = DEEPFILTERNET_PROCESSOR_NAME;
  public processedTrack?: MediaStreamTrack;

  private sourceNode?: MediaStreamAudioSourceNode;
  private workletNode?: AudioWorkletNode;
  private destinationNode?: MediaStreamAudioDestinationNode;
  private audioContext?: AudioContext;
  private wasmModule?: WebAssembly.Module;
  private modelBytes?: ArrayBuffer;
  private destroyed = false;
  private level: number;
  private enabled: boolean;

  public constructor(
    level: number = DEFAULT_NOISE_REDUCTION_LEVEL,
    enabled = true,
  ) {
    this.level = level;
    this.enabled = enabled;
  }

  private clampLevel(level: number): number {
    return Math.max(0, Math.min(1, level));
  }

  /**
   * Fetches and compiles the DeepFilterNet WASM binary and ONNX model from the
   * bundled assets. Cached so it only happens once per processor.
   */
  private async ensureAssets(): Promise<void> {
    if (this.wasmModule && this.modelBytes) return;

    const baseUrl = resolveAssetUrl();
    const [wasmResponse, modelResponse] = await Promise.all([
      fetch(`${baseUrl}/v3/pkg/df_bg.wasm`),
      fetch(`${baseUrl}/v3/models/DeepFilterNet3_onnx.tar.gz`),
    ]);

    if (!wasmResponse.ok) {
      throw new Error(
        `Failed to fetch DeepFilterNet WASM: ${wasmResponse.status} ${wasmResponse.statusText}`,
      );
    }
    if (!modelResponse.ok) {
      throw new Error(
        `Failed to fetch DeepFilterNet model: ${modelResponse.status} ${modelResponse.statusText}`,
      );
    }

    const [wasmBytes, modelBytes] = await Promise.all([
      wasmResponse.arrayBuffer(),
      modelResponse.arrayBuffer(),
    ]);

    this.wasmModule = await WebAssembly.compile(wasmBytes);
    this.modelBytes = modelBytes;
  }

  /**
   * Creates (or reuses) an AudioContext at the platform's native sample rate.
   * The worklet resamples to 48kHz internally, so we do not force 48kHz here
   * (which Windows WebView2 often cannot provide).
   */
  private async ensureAudioContext(): Promise<AudioContext> {
    if (this.audioContext) return this.audioContext;

    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      throw new Error(
        "DeepFilterNet requires an AudioContext, which this platform does not support.",
      );
    }

    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (e) {
        logger.warn(
          "[DeepFilterNetProcessor] failed to resume AudioContext",
          e,
        );
      }
    }

    this.audioContext = context;
    return context;
  }

  private async ensureWorkletRegistered(
    audioContext: AudioContext,
  ): Promise<void> {
    await audioContext.audioWorklet.addModule(deepFilterNetWorkletModuleUrl);
  }

  public async init(opts: AudioProcessorOptions): Promise<void> {
    if (this.workletNode !== undefined) {
      await this.destroy();
    }
    this.destroyed = false;

    try {
      await this.ensureAssets();
      const audioContext = await this.ensureAudioContext();
      await this.ensureWorkletRegistered(audioContext);

      if (this.destroyed) return;

      const sourceNode = audioContext.createMediaStreamSource(
        new MediaStream([opts.track]),
      );
      const workletNode = new AudioWorkletNode(
        audioContext,
        "deepfilternet-processor",
        {
          channelCount: 1,
          channelCountMode: "explicit",
          processorOptions: {
            wasmModule: this.wasmModule,
            modelBytes: this.modelBytes,
            suppressionLevel: this.clampLevel(this.level) * 100,
          },
        },
      );
      const destinationNode = audioContext.createMediaStreamDestination();

      sourceNode.connect(workletNode);
      workletNode.connect(destinationNode);

      this.sourceNode = sourceNode;
      this.workletNode = workletNode;
      this.destinationNode = destinationNode;
      this.processedTrack = destinationNode.stream.getAudioTracks()[0];

      workletNode.port.postMessage({
        type: "setSuppressionLevel",
        value: this.clampLevel(this.level) * 100,
      });
      workletNode.port.postMessage({
        type: "setBypass",
        value: !this.enabled,
      });
    } catch (e) {
      logger.error("[DeepFilterNetProcessor] init failed", e);
      throw e;
    }
  }

  public async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) {
      await Promise.resolve();
      return;
    }
    this.destroyed = true;

    this.workletNode?.port.postMessage({ type: "destroy" });

    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.destinationNode?.disconnect();

    try {
      this.processedTrack?.stop();
    } catch (e) {
      logger.warn(
        "[DeepFilterNetProcessor] failed to stop processed track during destroy",
        e,
      );
    }

    this.sourceNode = undefined;
    this.workletNode = undefined;
    this.destinationNode = undefined;
    this.processedTrack = undefined;
    await Promise.resolve();
  }

  /**
   * Sets the noise reduction level (0-1).
   */
  public setSuppressionLevel(level: number): void {
    this.level = this.clampLevel(level);
    this.workletNode?.port.postMessage({
      type: "setSuppressionLevel",
      value: this.level * 100,
    });
  }

  /**
   * Enables or disables noise suppression without tearing down the processor.
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.workletNode?.port.postMessage({
      type: "setBypass",
      value: !enabled,
    });
  }
}
