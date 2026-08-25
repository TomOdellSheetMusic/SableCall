/*
Copyright 2026 Element Software Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  combineLatest,
  distinctUntilChanged,
  map,
  merge,
  of,
  Subject,
  switchMap,
  withLatestFrom,
} from "rxjs";

import { type Behavior } from "./Behavior";
import { type ObservableScope } from "./ObservableScope";
import { accumulate } from "../utils/observable";

/**
 * The maximum playback volume, as a scalar multiplier of the stream's base
 * volume. Values above 1 boost the volume past 100%.
 */
export const MAX_PLAYBACK_VOLUME = 2;

/**
 * Controls for audio playback volume.
 */
export interface VolumeControls {
  playbackVolume$: Behavior<number>;
  playbackMuted$: Behavior<boolean>;
  togglePlaybackMuted: () => void;
  adjustPlaybackVolume: (value: number) => void;
  commitPlaybackVolume: () => void;
}

interface VolumeControlsInputs {
  pretendToBeDisconnected$: Behavior<boolean>;
  sink$: Behavior<(volume: number) => void>;
  initialVolume?: number;
  onVolumeCommitted?: (volume: number) => void;
  /**
   * Called with the full playback volume (including any boost above 100% and
   * mute) whenever it changes. The audio renderer uses this to apply the
   * volume (and mute) through the WebAudio gain node, since a plain
   * HTMLMediaElement clamps its volume to 1 and throws an IndexSizeError if
   * set above it.
   */
  onVolumeChange?: (volume: number) => void;
}

/**
 * Creates a set of controls for audio playback volume and syncs this with the
 * audio playback module for the duration of the scope.
 */
export function createVolumeControls(
  scope: ObservableScope,
  {
    pretendToBeDisconnected$,
    sink$,
    initialVolume = 1,
    onVolumeCommitted,
    onVolumeChange,
  }: VolumeControlsInputs,
): VolumeControls {
  const clamp = (v: number): number =>
    Math.max(0, Math.min(MAX_PLAYBACK_VOLUME, v));
  const toggleMuted$ = new Subject<"toggle mute">();
  const adjustVolume$ = new Subject<number>();
  const commitVolume$ = new Subject<"commit">();

  const playbackVolume$ = scope.behavior<number>(
    merge(toggleMuted$, adjustVolume$, commitVolume$).pipe(
      accumulate(
        {
          volume: clamp(initialVolume),
          committedVolume: clamp(initialVolume),
        },
        (state, event) => {
          switch (event) {
            case "toggle mute":
              return {
                ...state,
                volume: state.volume === 0 ? state.committedVolume : 0,
              };
            case "commit":
              // Dragging the slider to zero should have the same effect as
              // muting: keep the original committed volume, as if it were never
              // dragged
              return {
                ...state,
                committedVolume:
                  state.volume === 0 ? state.committedVolume : state.volume,
              };
            default:
              // Clamp so nothing above the maximum can slip through (e.g. a
              // stale saved preference).
              return { ...state, volume: clamp(event) };
          }
        },
      ),
      map(({ volume }) => volume),
    ),
  );

  // Notify the caller of newly committed volumes, e.g. so they can be
  // persisted. Committing at zero keeps the previous committed volume (see
  // above), so it is not reported.
  if (onVolumeCommitted !== undefined) {
    commitVolume$
      .pipe(withLatestFrom(playbackVolume$), scope.bind())
      .subscribe(([, volume]) => {
        if (volume > 0) onVolumeCommitted(volume);
      });
  }

  // Sync the requested volume with the audio playback module.
  //
  // The volume passed to the sink (LiveKit's `setVolume`) is clamped to [0, 1].
  // Volumes above 100% are applied separately through the WebAudio gain node
  // (see `onVolumeChange`), because a plain HTMLMediaElement clamps its volume
  // to 1 and throws an IndexSizeError if set above it. Clamping here avoids
  // that crash even if the audio context isn't attached yet.
  combineLatest([
    sink$,
    // The playback volume, taking into account whether we're supposed to
    // pretend that the audio stream is disconnected (since we don't necessarily
    // want that to modify the UI state).
    pretendToBeDisconnected$.pipe(
      switchMap((disconnected) => (disconnected ? of(0) : playbackVolume$)),
    ),
  ])
    .pipe(scope.bind())
    .subscribe(([sink, volume]) => sink(Math.min(1, volume)));

  // Notify the audio renderer of the full playback volume so it can apply the
  // volume (and mute) through the WebAudio gain node. This is the single
  // source of truth for the audible volume, so there is no race between a
  // `setVolume` call and the gain node, and no IndexSizeError.
  if (onVolumeChange !== undefined) {
    playbackVolume$
      .pipe(distinctUntilChanged(), scope.bind())
      .subscribe(onVolumeChange);
  }

  return {
    playbackVolume$,
    playbackMuted$: scope.behavior<boolean>(
      playbackVolume$.pipe(map((volume) => volume === 0)),
    ),
    togglePlaybackMuted: () => toggleMuted$.next("toggle mute"),
    adjustPlaybackVolume: (value: number) => adjustVolume$.next(value),
    commitPlaybackVolume: () => commitVolume$.next("commit"),
  };
}
