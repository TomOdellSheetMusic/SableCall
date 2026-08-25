/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  getTrackReferenceId,
  type TrackReference,
} from "@livekit/components-core";
import { type Room as LivekitRoom } from "livekit-client";
import { type RemoteAudioTrack, Track } from "livekit-client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useTracks,
  AudioTrack,
  type AudioTrackProps,
} from "@livekit/components-react";
import { logger as rootLogger } from "matrix-js-sdk/lib/logger";

import {
  useEarpieceAudioConfig,
  useMediaDevices,
} from "../MediaDevicesContext";
import { useReactiveState } from "../useReactiveState";
import { useBehavior } from "../useBehavior";
import { useObservableEagerState } from "observable-hooks";
import { useUrlParams } from "../UrlParams";
import { participantVolumes$ } from "../state/participantVolume";
import * as controls from "../controls";

export interface MatrixAudioRendererProps {
  /**
   * The service URL of the LiveKit room.
   */
  url: string;
  livekitRoom: LivekitRoom;
  /**
   * The list of participant identities to render audio for.
   * This list needs to be composed based on the matrixRTC members so that we do not play audio from users
   * that are not expected to be in the rtc session (local user is excluded).
   */
  validIdentities: string[];
  /**
   * If set to `true`, mutes all audio tracks rendered by the component.
   * @remarks
   * If set to `true`, the server will stop sending audio track data to the client.
   */
  muted?: boolean;
}

/**
 * Takes care of handling remote participants’ audio tracks and makes sure that microphones and screen share are audible.
 *
 * It also takes care of the earpiece audio configuration for iOS devices.
 * This is done by using the WebAudio API to create a stereo pan effect that mimics the earpiece audio.
 * @example
 * ```tsx
 * <LiveKitRoom>
 *   <MatrixAudioRenderer />
 * </LiveKitRoom>
 * ```
 * @public
 */
export function LivekitRoomAudioRenderer({
  url,
  livekitRoom,
  validIdentities,
  muted,
}: MatrixAudioRendererProps): ReactNode {
  const logger = rootLogger.getChild("[MatrixAudioRenderer]");
  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: true,
      room: livekitRoom,
    },
  )
    // Only keep audio tracks
    .filter((ref) => ref.publication.kind === Track.Kind.Audio)
    // Never render the local user's own audio back to them: `useTracks` also
    // returns the local participant's published tracks (they satisfy
    // `onlySubscribed`), and playing those back while screen sharing would make
    // people hear themselves echoed in the stream.
    .filter((ref) => !ref.participant.isLocal)
    // Only keep tracks from participants that are in the validIdentities list
    .filter((ref) => {
      const isValid = validIdentities.includes(ref.participant.identity);
      if (!isValid) {
        // TODO make sure to also skip the warn logging for the local identity
        // Log that there is an invalid identity, that means that someone is publishing audio that is not expected to be in the call.
        logger.warn(
          `Audio track ${ref.participant.identity} from ${url} has no matching matrix call member`,
          `current members: ${validIdentities.join()}`,
          `track will not get rendered`,
        );
        return false;
      }
      return true;
    });

  // This component is also (in addition to the "only play audio for connected members" logic above)
  // responsible for mimicking earpiece audio on iPhones.
  // The Safari audio devices enumeration does not expose an earpiece audio device.
  // We alternatively use the audioContext pan node to only use one of the stereo channels.

  // This component does get additionally complicated because of a Safari bug.
  // (see: https://bugs.webkit.org/show_bug.cgi?id=251532
  // and the related issues: https://bugs.webkit.org/show_bug.cgi?id=237878
  // and https://bugs.webkit.org/show_bug.cgi?id=231105)
  //
  // AudioContext gets stopped if the webview gets moved into the background.
  // Once the phone is in standby audio playback will stop.
  // So we can only use the pan trick only works is the phone is not in standby.
  // If earpiece mode is not used we do not use audioContext to allow standby playback.
  // shouldUseAudioContext is set to false if stereoPan === 0 to allow standby bluetooth playback.

  const { pan: stereoPan, volume: volumeFactor } = useEarpieceAudioConfig();

  // The full playback volume of each remote audio source, keyed by the same
  // keys used for the saved tile volumes:
  //  - the participant's identity for their microphone
  //  - "<identity>:screen-share" for their screen share audio
  // This lets the mic and screen share be controlled (and muted) completely
  // independently. Note that screen shares never report a volume here: they
  // are deliberately kept out of the volume boosting feature.
  const volumes = useBehavior(participantVolumes$);

  // Look up the full playback volume for a given track. The mic uses the
  // participant's identity, while the screen share uses a distinct
  // "<identity>:screen-share" key.
  const volumeForKey = (trackRef: TrackReference): number => {
    const source = trackRef.publication.source;
    const identity = trackRef.participant.identity;
    const key =
      source === Track.Source.ScreenShareAudio
        ? `${identity}:screen-share`
        : identity;
    return volumes.get(key) ?? 1;
  };

  // Whether a given track should be routed through the WebAudio audio context.
  // Only the participant's microphone is routed through the context because:
  //   1. It needs the gain node to boost volume above 100%.
  //   2. It needs the earpiece pan for iOS.
  // Screen share audio is deliberately NOT routed through the context so it is
  // not affected by the volume boosting feature (or the earpiece/processing
  // settings applied to the context), and so its volume and mute stay
  // completely separate from the participant's mic.
  const shouldUseAudioContext = (trackRef: TrackReference): boolean => {
    const source = trackRef.publication.source;
    if (source === Track.Source.ScreenShareAudio) return false;
    // Only boosted microphones need the context: the gain node is the only
    // way to amplify past the HTMLMediaElement's volume cap of 1.
    return volumeForKey(trackRef) > 1 || stereoPan !== 0;
  };

  // The selected output device (e.g. NVIDIA Broadcast). When audio is routed
  // through the WebAudio context for a boosted participant it would otherwise
  // play out of the context's default device, bypassing the user's chosen
  // output device and any processing applied there (e.g. noise suppression).
  const audioOutputId = useObservableEagerState(
    useMediaDevices().audioOutput.selected$,
  )?.id;
  const { controlledAudioDevices } = useUrlParams();

  // initialize the potentially used audio context.
  const [audioContext, setAudioContext] = useState<AudioContext | undefined>(
    undefined,
  );
  useEffect(() => {
    const ctx = new AudioContext();
    setAudioContext(ctx);
    return (): void => {
      void ctx.close();
    };
  }, []);
  // The AudioContext starts suspended until a user gesture; it must be running
  // for volumes above 100% (applied via the WebAudio gain node) to amplify.
  useEffect(() => {
    if (audioContext === undefined) return;
    const resume = (): void => {
      if (audioContext.state === "suspended") void audioContext.resume();
    };
    resume();
    // Browsers require a user gesture to resume an AudioContext, so retry on
    // any interaction.
    document.addEventListener("pointerdown", resume);
    document.addEventListener("keydown", resume);
    document.addEventListener("touchstart", resume);
    return (): void => {
      document.removeEventListener("pointerdown", resume);
      document.removeEventListener("keydown", resume);
      document.removeEventListener("touchstart", resume);
    };
  }, [audioContext]);
  // Route the audio context to the selected output device so boosted audio
  // doesn't bypass it (e.g. NVIDIA Broadcast noise suppression). Mirrors the
  // sink handling in useAudioContext.tsx.
  useEffect(() => {
    if (
      audioContext &&
      "setSinkId" in audioContext &&
      !controlledAudioDevices
    ) {
      // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/setSinkId
      // @ts-expect-error - setSinkId doesn't exist yet in types, maybe because it's not supported everywhere.
      audioContext.setSinkId(audioOutputId).catch((ex) => {
        logger.warn("Unable to change sink for audio context", ex);
      });
    }
  }, [audioContext, audioOutputId, controlledAudioDevices, logger]);

  return (
    // We add all audio elements into one <div> for the browser developer tool experience/tidyness.
    <div style={{ display: "none" }}>
      {tracks.map((trackRef) => (
        <AudioTrackWithAudioNodes
          key={getTrackReferenceId(trackRef)}
          trackRef={trackRef}
          muted={muted}
          audioContext={
            shouldUseAudioContext(trackRef) ? audioContext : undefined
          }
          audioOutputId={audioOutputId}
          stereoPan={stereoPan}
          volumeFactor={volumeFactor}
          trackVolume={volumeForKey(trackRef)}
        />
      ))}
    </div>
  );
}

interface StereoPanAudioTrackProps {
  muted?: boolean;
  audioContext?: AudioContext;
  /**
   * The currently selected audio output device. Used to re-apply the default
   * sink to screen share tracks whenever it changes.
   */
  audioOutputId: string | undefined;
  /**
   * The stereo pan to apply (earpiece configuration for iOS).
   */
  stereoPan: number;
  /**
   * The base volume factor to apply (earpiece configuration for iOS).
   */
  volumeFactor: number;
  /**
   * The full playback volume of this track, including any boost above 100%.
   * Screen share tracks always receive 1 (they never boost).
   */
  trackVolume: number;
}

/**
 * This wraps `livekit.AudioTrack` to allow adding audio nodes to a track.
 * It main purpose is to remount the AudioTrack component when switching from
 * audioContext to normal audio playback.
 * As of now the AudioTrack component does not support adding audio nodes while being mounted.
 * @param props The component props
 * @param props.trackRef The track reference
 * @param props.muted If the track should be muted
 * @param props.audioContext The audio context to use
 * @param props.audioOutputId The selected audio output device (used to keep
 *   screen shares on the default device)
 * @param props.stereoPan The stereo pan to apply
 * @param props.volumeFactor The base volume factor to apply
 * @param props.trackVolume The full playback volume of the track
 * @returns
 */
function AudioTrackWithAudioNodes({
  trackRef,
  muted,
  audioContext,
  audioOutputId,
  stereoPan,
  volumeFactor,
  trackVolume,
  ...props
}: StereoPanAudioTrackProps &
  AudioTrackProps &
  React.RefAttributes<HTMLAudioElement>): ReactNode {
  // This is used to unmount/remount the AudioTrack component.
  // Mounting needs to happen after the audioContext is set.
  // (adding the audio context when already mounted did not work outside strict mode)
  const mediaStream = trackRef?.publication.track?.mediaStream;
  const [trackReady, setTrackReady] = useReactiveState(
    () => false,
    // We want the track to reset when the audio context becomes available,
    // and when the underlying media stream changes (e.g. on encryption
    // renegotiation, where the WebAudio source node would otherwise stay
    // bound to the old stream).
    [audioContext, mediaStream],
  );

  // Each track gets its own gain + pan node so that a boosted participant's
  // microphone is amplified independently of every other track (a shared gain
  // node would couple their volumes together).
  const audioNodes = useMemo(() => {
    if (!audioContext) return undefined;
    return {
      gain: audioContext.createGain(),
      pan: audioContext.createStereoPanner(),
    };
  }, [audioContext]);

  // Apply the earpiece configuration (volume factor + stereo pan) to this
  // track's own nodes, along with any boost above 100%: the view model's sink
  // clamps the element volume to 1 (a plain HTMLMediaElement throws an
  // IndexSizeError above it), so the gain node is the only place where a
  // volume above 1 can be applied. The per-user mute and volume below 100%
  // are owned by the view model's sink (RemoteParticipant.setVolume), which
  // LiveKit applies to its own per-track gain node; multiplying the earpiece
  // volume factor here preserves the previous behavior.
  useEffect(() => {
    if (!audioNodes) return;
    audioNodes.pan.pan.value = stereoPan;
    audioNodes.gain.gain.value = volumeFactor * Math.max(1, trackVolume);
  }, [audioNodes, stereoPan, volumeFactor, trackVolume]);

  useEffect(() => {
    if (!trackRef) return;
    const track = trackRef.publication.track as RemoteAudioTrack | undefined;
    // The published track may not exist yet while LiveKit is (re)subscribing
    // to it, or it may be swapped out while a stream is being re-published.
    // During that window `track` is `undefined`, and calling `setAudioContext`
    // on it would crash the whole call (React ErrorBoundary). Wait for the
    // track to appear instead (its `publication.track` change re-triggers this
    // effect) so we never read a member of `undefined`.
    if (track === undefined || trackReady) return;
    const useContext = audioContext && audioNodes;
    track.setAudioContext(useContext ? audioContext : undefined);
    track.setWebAudioPlugins(
      useContext ? [audioNodes.gain, audioNodes.pan] : [],
    );
    setTrackReady(true);
    controls.setPlaybackStarted();
  }, [
    audioContext,
    audioNodes,
    setTrackReady,
    trackReady,
    trackRef,
    trackRef?.publication.track,
  ]);

  // Keep the screen share on the default output device. LiveKit's Room applies
  // the selected audio output (which may carry processing such as noise
  // suppression) to every remote track via setSinkId, and re-applies it
  // whenever the user switches devices. Since the screen share must never be
  // processed, undo it on mount and whenever the output device changes.
  useEffect(() => {
    if (trackRef?.publication.source !== Track.Source.ScreenShareAudio) return;
    const track = trackRef?.publication.track as RemoteAudioTrack | undefined;
    if (track === undefined) return;
    track.setSinkId("").catch((ex) => {
      rootLogger
        .getChild("[MatrixAudioRenderer]")
        .warn("Unable to reset sink for screen share audio", ex);
    });
  }, [audioOutputId, trackRef]);

  return (
    trackReady && <AudioTrack trackRef={trackRef} muted={muted} {...props} />
  );
}
