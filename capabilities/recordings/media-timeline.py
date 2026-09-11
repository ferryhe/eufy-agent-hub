"""Full MP4 decode and observed timeline; no duration inferred from file existence."""
import json
import sys
from pathlib import Path
import av


def inspect(directory):
    directory = Path(directory)
    with av.open(str(directory / 'timed.ts')) as source:
        mux_start = source.start_time / 1000
    streams = {}
    for kind in ['video', 'audio']:
        with av.open(str(directory / 'playback.mp4'), options={'err_detect': 'explode'}) as source:
            matching = [stream for stream in source.streams if stream.type == kind]
            if not matching:
                continue
            stream = matching[0]
            count = 0
            first = last = duration = None
            for frame in source.decode(stream):
                timestamp = float(frame.pts * frame.time_base * 1000)
                if last is not None and timestamp <= last:
                    raise ValueError(f'Non-increasing {kind} output timestamps')
                if first is None:
                    first = timestamp
                last = timestamp
                if kind == 'audio':
                    duration = frame.samples / frame.sample_rate * 1000
                else:
                    duration = float(frame.duration * frame.time_base * 1000) if frame.duration else 0
                count += 1
            streams[kind] = dict(count=count, firstTimestampMs=first, lastTimestampMs=last, lastDurationMs=duration)
    (directory / 'media-timeline.json').write_text(json.dumps(dict(muxStartMs=mux_start, streams=streams), indent=2))


if __name__ == '__main__':
    inspect(sys.argv[1])
