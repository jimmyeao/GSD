#!/usr/bin/env python3
"""
Concatenate multiple mp4 clips into one file, with a short audio+video
crossfade at each clip boundary instead of a hard cut. A straight cut
compounds two artifacts at once: each chunk is generated independently by
MiniMax H3 and doesn't literally continue the previous chunk's exact pose/
camera angle, so the cut itself reads as a jump; and MUTE_LEADING_SECONDS
below (an unrelated per-clip fix) lands a hard silence gap at the very point
of that cut. Together those read as a broken splice rather than an edit — a
crossfade masks both by blending across the join instead of snapping.

Decodes every clip fully into memory (RGB frames + float audio) rather than
streaming frame-by-frame, since a fade needs frames from both sides of a
join before encoding. Clips are a handful of seconds each, so this is a
trivial memory cost next to the GPU time already spent generating them.

Usage: concat_videos.py <output.mp4> <input1.mp4> [<input2.mp4> ...]
A single input is a valid no-op "concat" (used for per-chunk muting only).
"""
import sys
from fractions import Fraction

import av
import numpy as np

# MiniMax H3 has a known start-of-clip artifact — the native audio decoder
# occasionally misfires before locking onto the first dialogue frame,
# producing a burst of junk/gibberish audio in roughly the first 0.3-0.5s of
# every generated clip (reported independently by multiple users on the
# MiniMax-H3 HuggingFace discussion and r/StableDiffusion). Mute (zero the
# samples) rather than cut this window out — cutting would cost real time
# from the timeline; muting keeps every frame and the full timeline intact.
MUTE_LEADING_SECONDS = 0.4

# Crossfade window at each clip boundary, applied to both video and audio.
# Kept short and subtle — long enough to mask the cut, short enough not to
# visibly smear a full second of two different compositions together.
FADE_SECONDS = 0.3

# Ease-in/out applied only at the two outer edges of the whole merged
# timeline (see apply_edge_fades) — shorter than FADE_SECONDS since there's
# no second clip's content to blend with, just silence on one side.
EDGE_FADE_SECONDS = 0.15


def decode_clip(path):
    container = av.open(path)
    v_stream = container.streams.video[0]
    a_stream = container.streams.audio[0] if container.streams.audio else None
    fps = float(v_stream.average_rate) if v_stream.average_rate else 24.0
    sample_rate = a_stream.codec_context.sample_rate if a_stream else None
    layout = a_stream.codec_context.layout.name if a_stream else None

    video_frames = []
    audio_chunks = []
    for frame in container.decode():
        if isinstance(frame, av.VideoFrame):
            video_frames.append(frame.to_ndarray(format="rgb24").astype(np.float32))
        elif isinstance(frame, av.AudioFrame) and a_stream is not None:
            t = float(frame.pts * frame.time_base) if frame.pts is not None else None
            arr = frame.to_ndarray().astype(np.float32)  # (channels, samples), planar
            if t is not None and t < MUTE_LEADING_SECONDS:
                arr[:] = 0
            audio_chunks.append(arr)
    container.close()

    audio = np.concatenate(audio_chunks, axis=1) if audio_chunks else None
    return {
        "video": video_frames,
        "audio": audio,
        "fps": fps,
        "sample_rate": sample_rate,
        "layout": layout,
        "width": v_stream.codec_context.width,
        "height": v_stream.codec_context.height,
    }


def crossfade_video(frames_a, frames_b, fade_n):
    """Blend the tail fade_n frames of A with the head fade_n frames of B."""
    fade_n = min(fade_n, len(frames_a), len(frames_b))
    if fade_n <= 0:
        return frames_a + frames_b
    tail_a = frames_a[-fade_n:]
    head_b = frames_b[:fade_n]
    faded = []
    for i in range(fade_n):
        alpha = (i + 1) / (fade_n + 1)  # ramps 0->1 across the window
        faded.append(tail_a[i] * (1 - alpha) + head_b[i] * alpha)
    return frames_a[:-fade_n] + faded + frames_b[fade_n:]


def apply_edge_fades(audio, sample_rate):
    """Ease in/out at the very start and end of the whole timeline.
    Internal clip boundaries are already smoothed by crossfade_audio, but
    the two outer edges aren't touched by that: the absolute start still
    snaps straight from MUTE_LEADING_SECONDS of hard silence to full volume
    (no previous clip to crossfade against there), and the last clip's tail
    otherwise just stops cold with no fade-out at all.
    """
    mute_n = round(MUTE_LEADING_SECONDS * sample_rate)
    fade_in_n = min(round(EDGE_FADE_SECONDS * sample_rate), max(0, audio.shape[1] - mute_n))
    if fade_in_n > 0:
        ramp = np.linspace(0.0, 1.0, fade_in_n, dtype=np.float32)
        audio[:, mute_n:mute_n + fade_in_n] *= ramp
    fade_out_n = min(round(EDGE_FADE_SECONDS * sample_rate), audio.shape[1])
    if fade_out_n > 0:
        ramp = np.linspace(1.0, 0.0, fade_out_n, dtype=np.float32)
        audio[:, -fade_out_n:] *= ramp
    return audio


def crossfade_audio(audio_a, audio_b, fade_n):
    fade_n = min(fade_n, audio_a.shape[1], audio_b.shape[1])
    if fade_n <= 0:
        return np.concatenate([audio_a, audio_b], axis=1)
    tail_a = audio_a[:, -fade_n:]
    head_b = audio_b[:, :fade_n]
    ramp = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
    blended = tail_a * (1 - ramp) + head_b * ramp
    return np.concatenate([audio_a[:, :-fade_n], blended, audio_b[:, fade_n:]], axis=1)


def main():
    args = sys.argv[1:]
    # --no-edge-fade: used for the per-chunk leading-mute pre-pass (a
    # single-input "concat" run before the real multi-clip merge — see
    # handleChainedVideoAgent in server.js). Without this flag, that pass
    # would fade its own start/end before the final merge crossfades it
    # against its neighbors, double-attenuating every internal boundary.
    apply_edges = "--no-edge-fade" not in args
    args = [a for a in args if a != "--no-edge-fade"]

    if len(args) < 2:
        print("Usage: concat_videos.py [--no-edge-fade] <output.mp4> <input1.mp4> <input2.mp4> [...]", file=sys.stderr)
        sys.exit(1)

    out_path = args[0]
    in_paths = args[1:]

    clips = [decode_clip(p) for p in in_paths]
    fps = clips[0]["fps"]
    width, height = clips[0]["width"], clips[0]["height"]
    sample_rate = clips[0]["sample_rate"]
    layout = clips[0]["layout"]
    fade_video_n = max(0, round(FADE_SECONDS * fps))
    fade_audio_n = max(0, round(FADE_SECONDS * sample_rate)) if sample_rate else 0

    all_video = clips[0]["video"]
    all_audio = clips[0]["audio"]
    for clip in clips[1:]:
        all_video = crossfade_video(all_video, clip["video"], fade_video_n)
        if all_audio is not None and clip["audio"] is not None:
            all_audio = crossfade_audio(all_audio, clip["audio"], fade_audio_n)

    if apply_edges and all_audio is not None and sample_rate:
        all_audio = apply_edge_fades(all_audio, sample_rate)

    output = av.open(out_path, mode="w")
    out_v = output.add_stream("libx264", rate=round(fps))
    out_v.width = width
    out_v.height = height
    out_v.pix_fmt = "yuv420p"
    out_v.time_base = Fraction(1, 90000)  # standard fine-grained time_base, not set by default

    out_a = output.add_stream("aac", rate=sample_rate) if all_audio is not None else None
    if out_a:
        out_a.layout = layout
        out_a.time_base = Fraction(1, sample_rate)

    fps_frac = Fraction(round(fps), 1)
    for i, frame_arr in enumerate(all_video):
        frame = av.VideoFrame.from_ndarray(np.clip(frame_arr, 0, 255).astype(np.uint8), format="rgb24")
        t = Fraction(i, 1) / fps_frac
        frame.pts = int(t / out_v.time_base)
        frame.time_base = out_v.time_base
        for packet in out_v.encode(frame):
            output.mux(packet)

    if out_a is not None and all_audio is not None:
        samples_per_frame = 1024
        total_samples = all_audio.shape[1]
        for start in range(0, total_samples, samples_per_frame):
            chunk = np.ascontiguousarray(all_audio[:, start:start + samples_per_frame])
            audio_frame = av.AudioFrame.from_ndarray(chunk, format="fltp", layout=layout)
            audio_frame.sample_rate = sample_rate
            t = Fraction(start, sample_rate)
            audio_frame.pts = int(t / out_a.time_base)
            audio_frame.time_base = out_a.time_base
            for packet in out_a.encode(audio_frame):
                output.mux(packet)

    for packet in out_v.encode():
        output.mux(packet)
    if out_a is not None:
        for packet in out_a.encode():
            output.mux(packet)

    output.close()
    total_s = len(all_video) / fps
    print(f"Merged {len(in_paths)} clips with {FADE_SECONDS}s crossfades -> {out_path} (total ~{total_s:.2f}s)")


if __name__ == "__main__":
    main()
