/*
Copyright 2026 Element Software Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type FC, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { Menu, MenuItem } from "@vector-im/compound-web";

import { Slider } from "../Slider";
import { MAX_PLAYBACK_VOLUME } from "../state/VolumeControls";
import { type RemoteScreenShareViewModel } from "../state/media/RemoteScreenShareViewModel";
import { useBehavior } from "../useBehavior";
import styles from "./ScreenShareVolumeButton.module.css";

interface Props {
  vm: RemoteScreenShareViewModel;
}

/**
 * A button that opens a popup with a mute toggle and volume slider for a
 * remote participant's screen share audio. Used in both the spotlight and
 * grid layouts so the screen share's volume is controlled independently of
 * the participant's microphone.
 */
export const ScreenShareVolumeButton: FC<Props> = ({ vm }) => {
  const { t } = useTranslation();

  const audioEnabled = useBehavior(vm.audioEnabled$);
  const playbackMuted = useBehavior(vm.playbackMuted$);
  const playbackVolume = useBehavior(vm.playbackVolume$);

  const [volumeMenuOpen, setVolumeMenuOpen] = useState(false);
  const onMuteButtonClick = useCallback(() => vm.togglePlaybackMuted(), [vm]);
  const onVolumeChange = useCallback(
    (v: number) => vm.adjustPlaybackVolume(v),
    [vm],
  );
  const onVolumeCommit = useCallback(() => vm.commitPlaybackVolume(), [vm]);

  return (
    audioEnabled && (
      <Menu
        open={volumeMenuOpen}
        onOpenChange={setVolumeMenuOpen}
        title={t("video_tile.screen_share_volume")}
        side="top"
        align="end"
        trigger={
          <button
            className={styles.trigger}
            aria-label={t("video_tile.screen_share_volume")}
          >
            {playbackMuted ? (
              <SpeakerSlash size={20} />
            ) : (
              <SpeakerHigh size={20} />
            )}
          </button>
        }
      >
        <MenuItem
          as="div"
          className={styles.volumeMenuItem}
          onSelect={null}
          label={null}
          hideChevron={true}
        >
          <button className={styles.menuMuteButton} onClick={onMuteButtonClick}>
            {playbackMuted ? (
              <SpeakerSlash aria-hidden width={24} height={24} />
            ) : (
              <SpeakerHigh aria-hidden width={24} height={24} />
            )}
          </button>
          <Slider
            className={styles.volumeSlider}
            label={t("video_tile.volume")}
            value={playbackVolume}
            min={0}
            max={1}
            step={0.01}
            onValueChange={onVolumeChange}
            onValueCommit={onVolumeCommit}
          />
        </MenuItem>
      </Menu>
    )
  );
};
