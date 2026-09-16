/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect, useState } from "react";
import { type RemoteAudioTrack, Track } from "livekit-client";
import { distinctUntilChanged, skip } from "rxjs";
import { logger } from "matrix-js-sdk/lib/logger";
import type { TrackReference } from "@livekit/components-core";

import {
  deepFilterNetNoiseSuppressionIncoming,
  deepFilterNetNoiseSuppressionLevel,
  rnnoiseNoiseSuppressionIncoming,
  rnnoiseNoiseSuppressionPreset,
} from "../settings/settings";
import { DeepFilterNetProcessor } from "../audio/DeepFilterNetProcessor";
import { RNNoiseProcessor } from "../audio/RNNoiseProcessor";
import type { AudioProcessorOptions, TrackProcessor } from "livekit-client";

/**
 * LiveKit's `Track` base class implements processor management, but its type
 * definitions only surface `setProcessor`/`getProcessor`/`stopProcessor` on
 * `LocalTrack`. At runtime they work on remote tracks too, so we model just
 * the parts we touch here.
 */
interface RemoteTrackProcessorSurface {
  setProcessor(
    processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>,
  ): Promise<void>;
  getProcessor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> | undefined;
  stopProcessor(): Promise<void>;
}

type ProcessableRemoteAudioTrack = RemoteAudioTrack &
  RemoteTrackProcessorSurface;

const asProcessable = (
  track: RemoteAudioTrack,
): ProcessableRemoteAudioTrack => track as ProcessableRemoteAudioTrack;

/**
 * Applies the user's chosen noise suppression (RNNoise or DeepFilterNet) to a
 * remote member's microphone audio, when the corresponding "apply to incoming
 * member audio" setting is enabled.
 *
 * This deliberately only ever touches microphone tracks. Reactions are played
 * through a separate WebAudio sound-effect path, and screen share audio uses a
 * distinct `ScreenShareAudio` source, so neither is ever processed here.
 */
export function useRemoteNoiseSuppression(
  track: RemoteAudioTrack | undefined,
  isMicrophone: boolean,
  processingContext: AudioContext | undefined,
): { active: boolean; version: number } {
  const [version, setVersion] = useState(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!track) {
      setActive(false);
      return;
    }
    let cancelled = false;

    const reapply = (): void => {
      void applyProcessor(track, processingContext)
        .then(({ changed, active: newActive }) => {
          if (cancelled) return;
          // The underlying media stream only changes when the processor itself
          // is swapped (attached/removed/replaced). The renderer remounts its
          // audio element so routed WebAudio picks up the new stream.
          const needsRemount = changed || newActive !== active;
          setActive(newActive);
          if (needsRemount) setVersion((v) => v + 1);
        })
        .catch(() => {
          // applyProcessor already logs; nothing more to do.
        });
    };

    if (isMicrophone && processingContext) {
      const processableTrack = asProcessable(track);
      const subs = [
        rnnoiseNoiseSuppressionIncoming.value$
          .pipe(distinctUntilChanged(), skip(1))
          .subscribe(reapply),
        rnnoiseNoiseSuppressionPreset.value$
          .pipe(distinctUntilChanged(), skip(1))
          .subscribe(reapply),
        deepFilterNetNoiseSuppressionIncoming.value$
          .pipe(distinctUntilChanged(), skip(1))
          .subscribe(reapply),
        deepFilterNetNoiseSuppressionLevel.value$
          .pipe(distinctUntilChanged(), skip(1))
          .subscribe(reapply),
      ];

      // Kick off the initial application when the track/context appears.
      reapply();

      return () => {
        cancelled = true;
        for (const s of subs) s.unsubscribe();
        // The track may already be gone. stopProcessor returns a promise in
        // real usage, but be defensive about it.
        const stop = processableTrack.stopProcessor() as unknown;
        if (stop instanceof Promise) {
          void stop.catch(() => {
            // Nothing to do; the track may already be torn down.
          });
        }
      };
    }

    return () => {
      cancelled = true;
    };
    // Re-run only when the track or processing context changes. The setting
    // streams are subscribed to above and handled incrementally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMicrophone, track, processingContext]);

  return { active, version };
}

/**
 * Decides which (if any) processor to attach for the current incoming-audio
 * noise suppression settings, and keeps the remote track's WebAudio processing
 * in sync.
 *
 * @returns `changed` — whether the active processor was swapped — and
 *   `active`, whether incoming noise suppression is currently enabled.
 */
async function applyProcessor(
  track: RemoteAudioTrack,
  processingContext?: AudioContext,
): Promise<{ changed: boolean; active: boolean }> {
  const processableTrack = asProcessable(track);
  const useDf = deepFilterNetNoiseSuppressionIncoming.getValue();
  // DeepFilterNet takes precedence over RNNoise, mirroring the local
  // microphone behaviour.
  const useRnnoise = !useDf && rnnoiseNoiseSuppressionIncoming.getValue();
  const isActive = useDf || useRnnoise;

  const current = processableTrack.getProcessor();
  const desiredKind = useDf
    ? "deepfilternet"
    : useRnnoise
      ? "rnnoise"
      : "none";
  const currentKind =
    current === undefined
      ? "none"
      : current instanceof DeepFilterNetProcessor
        ? "deepfilternet"
        : current instanceof RNNoiseProcessor
          ? "rnnoise"
          : "other";

  // Keep an already-active processor's parameters in sync without churn.
  if (currentKind === desiredKind && current) {
    if (
      desiredKind === "deepfilternet" &&
      current instanceof DeepFilterNetProcessor
    ) {
      current.setSuppressionLevel(deepFilterNetNoiseSuppressionLevel.getValue());
    } else if (
      desiredKind === "rnnoise" &&
      current instanceof RNNoiseProcessor
    ) {
      current.setPreset(rnnoiseNoiseSuppressionPreset.getValue());
    }
    return { changed: false, active: isActive };
  }

  if (!processingContext) {
    // Nothing to attach against yet; drop any stale processor.
    if (current) {
      try {
        await processableTrack.stopProcessor();
      } catch {
        // Ignore.
      }
      return { changed: true, active: false };
    }
    return { changed: false, active: false };
  }

  try {
    if (current) await processableTrack.stopProcessor();
    if (desiredKind === "none") return { changed: true, active: false };

    // LiveKit passes the track's `audioContext` to the processor on init, so
    // point the track at the processing context before attaching it.
    track.setAudioContext(processingContext);

    if (desiredKind === "deepfilternet") {
      await processableTrack.setProcessor(
        new DeepFilterNetProcessor(
          deepFilterNetNoiseSuppressionLevel.getValue(),
          true,
        ),
      );
    } else {
      await processableTrack.setProcessor(
        new RNNoiseProcessor(rnnoiseNoiseSuppressionPreset.getValue(), true),
      );
    }
  } catch (e) {
    logger.error(
      "Failed to apply noise suppression to incoming member audio",
      e,
    );
    return { changed: false, active: isActive };
  }

  return { changed: true, active: true };
}

/**
 * Whether a track reference represents a remote member's microphone. Noise
 * suppression must only ever be applied to member microphones — never to
 * reactions or screen share streams.
 */
export function isMicrophoneSource(ref: TrackReference | undefined): boolean {
  return ref?.publication.source === Track.Source.Microphone;
}