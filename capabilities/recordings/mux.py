"""Preserve HomeBase packet timestamps in MPEG-TS before MP4 conversion. Requires PyAV."""
import json
import sys
import io
from contextlib import ExitStack
from fractions import Fraction
from pathlib import Path
import av


def mux(directory):
    directory = Path(directory)
    info = json.loads((directory / 'frames.json').read_text())
    if not info['reachedEnd']:
        raise ValueError('Capture did not reach the requested end time')
    frames = info['frames']
    video_frames = [f for f in frames if f['kind'] == 'video']
    codec = 'hevc' if video_frames[0]['streamType'] == 2 else 'h264'
    base = info['begin'] * 1000
    destination = directory / 'timed.ts'
    with ExitStack() as stack:
        data = stack.enter_context((directory / 'frames.bin').open('rb'))
        output = stack.enter_context(av.open(str(destination), 'w', format='mpegts'))
        streams = {}
        for kind, fmt in [('video', codec), ('audio', 'aac')]:
            first = next((f for f in frames if f['kind'] == kind), None)
            if first is None:
                continue
            data.seek(first['offset'])
            source = stack.enter_context(av.open(io.BytesIO(data.read(first['length'])), format=fmt))
            streams[kind] = output.add_stream_from_template(source.streams[0])
        for stream in streams.values():
            stream.time_base = Fraction(1, 1000)
        for frame in sorted(frames, key=lambda f: f['timestamp']):
            data.seek(frame['offset'])
            packet = av.Packet(data.read(frame['length']))
            packet.stream = streams[frame['kind']]
            packet.time_base = Fraction(1, 1000)
            packet.pts = packet.dts = frame['timestamp'] - base
            if frame['kind'] == 'video':
                packet.is_keyframe = frame['keyFrame']
            output.mux(packet)
    print(destination.resolve())


if __name__ == '__main__':
    mux(sys.argv[1])
