/*
Copyright 2026 Element Software Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BehaviorSubject } from "rxjs";

/**
 * The current playback volume of each remote audio source, keyed by the same
 * keys used for the saved tile volumes:
 *  - the participant's identity for their microphone
 *  - "<identity>:screen-share" for their screen share audio
 *
 * Module-level so the audio renderer can apply the volume (and mute) through
 * the WebAudio gain node without threading state through the view model tree.
 * Keeping the mic and screen share under separate keys means their volumes and
 * mutes are completely independent.
 *
 * Screen shares never report a volume here: they are deliberately kept out of
 * the volume boosting feature (their audio is not routed through the WebAudio
 * context, and their volume clamps at 100% inside the view model).
 */
export const participantVolumes$ = new BehaviorSubject<Map<string, number>>(
  new Map(),
);

/**
 * Record the current playback volume for a given audio source key.
 */
export function setParticipantVolume(key: string, volume: number): void {
  if (participantVolumes$.value.get(key) === volume) return;
  const next = new Map(participantVolumes$.value);
  next.set(key, volume);
  participantVolumes$.next(next);
}
