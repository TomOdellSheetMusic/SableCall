/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { DeepFilterNoiseFilterProcessor } from "deepfilternet3-noise-filter";
import { logger } from "matrix-js-sdk/lib/logger";
import { BehaviorSubject } from "rxjs";

import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";
import type { Behavior } from "../state/Behavior";

/**
 * The sample rate DeepFilterNet is trained for.
 */
const DEEPFILTERNET_SAMPLE_RATE = 48000;

/**
 * The default noise reduction level (0-1), mapped to the package's 0-100 scale.
 */
const DEFAULT_NOISE_REDUCTION_LEVEL = 0.75;

/**
 * The name used to identify this processor on a LiveKit track.
 */
export const DEEPFILTERNET_PROCESSOR_NAME = "deepfilternet-noise-suppression";

const _deepFilterNetError$ = new BehaviorSubject<string | null>(null);
/**
 * The most recent DeepFilterNet setup error message, or null when the last
 * setup attempt succeeded. Used by the settings UI to render an error instead
 * of silently toggling the setting back off.
 */
export const deepFilterNetError$: Behavior<string | null> =
  _deepFilterNetError$;

/**
 * Publishes a DeepFilterNet setup error message (or null to clear it) to
 * `deepFilterNetError$`. Used by the Publisher when processor setup fails.
 */
export function setDeepFilterNetError(error: string | null): void {
  _deepFilterNetError$.next(error);
}

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
 * The underlying `DeepFilterNoiseFilterProcessor` from the
 * `deepfilternet3-noise-filter` package implements the LiveKit
 * `TrackProcessor` interface directly, so this wrapper primarily manages the
 * lifecycle and exposes a stable API for the rest of the app.
 */
export class DeepFilterNetProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  public name = DEEPFILTERNET_PROCESSOR_NAME;
  public processedTrack?: MediaStreamTrack;

  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- The
  // DeepFilterNoiseFilterProcessor type is not resolvable by oxlint's type-aware
  // analysis (it imports from livekit-client), so it is treated as `any`.
  private processor: DeepFilterNoiseFilterProcessor | null = null;
  private level: number;
  private enabled: boolean;

  public constructor(
    level: number = DEFAULT_NOISE_REDUCTION_LEVEL,
    enabled = true,
  ) {
    this.level = level;
    this.enabled = enabled;
  }

  /**
   * Creates (or reuses) the underlying DeepFilterNet processor.
   */
  private ensureProcessor(): DeepFilterNoiseFilterProcessor {
    if (!this.processor) {
      this.processor = new DeepFilterNoiseFilterProcessor({
        sampleRate: DEEPFILTERNET_SAMPLE_RATE,
        noiseReductionLevel: this.clampLevel(this.level) * 100,
        enabled: this.enabled,
        assetConfig: {
          cdnUrl: resolveAssetUrl(),
        },
      });
    }
    return this.processor;
  }

  private clampLevel(level: number): number {
    return Math.max(0, Math.min(1, level));
  }

  public async init(opts: AudioProcessorOptions): Promise<void> {
    const processor = this.ensureProcessor();
    try {
      // Reuse the AudioContext that LiveKit already created for this track
      // instead of letting the package spin up its own (which can fail on
      // desktop WebViews, e.g. when requesting a non-default sample rate).
      if (opts.audioContext) {
        processor.audioContext = opts.audioContext;
      }
      await processor.init({ track: opts.track });
      this.processedTrack = processor.processedTrack;
      // Clear any previous error on a successful setup.
      setDeepFilterNetError(null);
    } catch (e) {
      logger.error("[DeepFilterNetProcessor] init failed", e);
      // Surface the error immediately so the settings UI can render it even
      // if the caller (LiveKit setProcessor) swallows the rejection.
      setDeepFilterNetError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  public async restart(opts: AudioProcessorOptions): Promise<void> {
    const processor = this.ensureProcessor();
    try {
      if (opts.audioContext) {
        processor.audioContext = opts.audioContext;
      }
      await processor.restart({ track: opts.track });
      this.processedTrack = processor.processedTrack;
      setDeepFilterNetError(null);
    } catch (e) {
      logger.error("[DeepFilterNetProcessor] restart failed", e);
      setDeepFilterNetError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  public async destroy(): Promise<void> {
    if (this.processor) {
      try {
        await this.processor.destroy();
      } catch (e) {
        logger.warn("[DeepFilterNetProcessor] destroy failed", e);
      }
      this.processor = null;
    }
    this.processedTrack = undefined;
  }

  /**
   * Sets the noise reduction level (0-1).
   */
  public setSuppressionLevel(level: number): void {
    this.level = this.clampLevel(level);
    this.processor?.setSuppressionLevel(this.level * 100);
  }

  /**
   * Enables or disables noise suppression without tearing down the processor.
   */
  public async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await this.processor?.setEnabled(enabled);
  }
}
