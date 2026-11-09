// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Clutter from 'gi://Clutter';

/**
 * @param {object} monitor the monitor's geometry
 * @param {Clutter.Actor} source mpv's window actor
 * @param {object} video the video's width and height
 * @returns {Clutter.Actor} a layer that covers the monitor with the video,
 *   the way the shell's "zoom" places a picture
 */
export function createCover(monitor, source, video) {
    // mpv stretches the video to its window, so use the video's shape
    const scale = Math.max(monitor.width / video.width,
        monitor.height / video.height);
    const width = video.width * scale;
    const height = video.height * scale;
    const layer = new Clutter.Actor({
        width: monitor.width,
        height: monitor.height,
        clip_to_allocation: true,
    });
    layer.add_child(new Clutter.Clone({
        source,
        width,
        height,
        x: Math.round((monitor.width - width) / 2),
        y: Math.round((monitor.height - height) / 2),
    }));
    return layer;
}
