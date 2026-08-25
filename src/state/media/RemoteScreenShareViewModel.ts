/*
Copyright 2023, 2024 New Vector Ltd.
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  ParticipantEvent,
  RemoteTrackPublication,
  Track,
  type RemoteParticipant,
} from "livekit-client";
import { observeParticipantEvents } from "@livekit/components-core";
import { combineLatest, distinctUntilChanged, map, of, switchMap } from "rxjs";

import { type Behavior } from "../Behavior";
import {
  type BaseScreenShareInputs,
  type BaseScreenShareViewModel,
  createBaseScreenShare,
} from "./ScreenShareViewModel";
import { type ObservableScope } from "../ObservableScope";
import { createVolumeControls, type VolumeControls } from "../VolumeControls";
import { observeTrackReference$ } from "../observeTrackReference";
import { saveTileVolume, tileVolumes } from "../../settings/settings";

export interface RemoteScreenShareViewModel
  extends BaseScreenShareViewModel, VolumeControls {
  local: false;
  /**
   * Whether this screen share's video should be displayed.
   */
  videoEnabled$: Behavior<boolean>;
  /**
   * Whether this screen share should be considered to have an audio track.
   */
  audioEnabled$: Behavior<boolean>;
}

export interface RemoteScreenShareInputs extends BaseScreenShareInputs {
  participant$: Behavior<RemoteParticipant | null>;
  pretendToBeDisconnected$: Behavior<boolean>;
  rtcBackendIdentity: string;
}

export function createRemoteScreenShare(
  scope: ObservableScope,
  { pretendToBeDisconnected$, ...inputs }: RemoteScreenShareInputs,
): RemoteScreenShareViewModel {
  const base = createBaseScreenShare(scope, inputs);

  // The screen share's video and audio publications.
  const videoPublication$ = base.video$.pipe(map((ref) => ref?.publication));
  const audioPublication$ = inputs.participant$.pipe(
    switchMap((p) =>
      p
        ? observeTrackReference$(p, Track.Source.ScreenShareAudio)
        : of(undefined),
    ),
    map((ref) => ref?.publication),
  );
  combineLatest([base.watching$, videoPublication$, audioPublication$])
    .pipe(
      scope.bind(),
      distinctUntilChanged(
        ([watching, video, audio], [nextWatching, nextVideo, nextAudio]) =>
          watching === nextWatching &&
          video === nextVideo &&
          audio === nextAudio,
      ),
    )
    .subscribe(([watching, video, audio]) => {
      for (const publication of [video, audio]) {
        if (publication instanceof RemoteTrackPublication)
          publication.setSubscribed(watching);
      }
    });

  // Emits whenever any remote track subscribes or unsubscribes.
  const audioTrackEvents$ = inputs.participant$.pipe(
    switchMap((p) =>
      p === null
        ? of(undefined)
        : observeParticipantEvents(
            p,
            ParticipantEvent.TrackSubscribed,
            ParticipantEvent.TrackUnsubscribed,
          ),
    ),
  );

  // Screen share audio gets its own saved volume, separate from the
  // participant's voice volume.
  const savedVolumeKey = `${inputs.rtcBackendIdentity}:screen-share`;
  return {
    ...base,
    ...createVolumeControls(scope, {
      pretendToBeDisconnected$,
      sink$: scope.behavior(
        combineLatest([inputs.participant$, audioTrackEvents$]).pipe(
          map(
            ([p]) =>
              (volume) =>
                // The screen share is NOT routed through the WebAudio audio
                // context (so it is not affected by the volume boosting
                // feature or the earpiece/noise-suppression processing), which
                // means its volume is applied via the HTMLMediaElement. That
                // element clamps volume to 1, so clamp here to avoid an
                // IndexSizeError. This also keeps the screen share's volume
                // and mute completely separate from the participant's mic.
                p?.setVolume(
                  Math.min(1, volume),
                  Track.Source.ScreenShareAudio,
                ),
          ),
        ),
      ),
      initialVolume: tileVolumes.getValue()[savedVolumeKey],
      onVolumeCommitted: (volume) => saveTileVolume(savedVolumeKey, volume),
      // Deliberately no onVolumeChange: the screen share is never routed
      // through the audio context, so it cannot be boosted above 100%, and we
      // must not report its volume under the participant's key (which would
      // couple the two tracks together).
    }),
    local: false,
    videoEnabled$: scope.behavior(
      pretendToBeDisconnected$.pipe(map((disconnected) => !disconnected)),
    ),
    audioEnabled$: scope.behavior(
      inputs.participant$.pipe(
        switchMap((p) =>
          p
            ? observeTrackReference$(p, Track.Source.ScreenShareAudio)
            : of(null),
        ),
        map(Boolean),
      ),
    ),
  };
}
