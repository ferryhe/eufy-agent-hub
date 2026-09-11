"""Make labelled offline raw capture metadata from a generated 20fps H264 stream."""
import json
import sys
from pathlib import Path
import av

directory = Path(sys.argv[1])
frames = []
offset = 0
with av.open(str(directory / 'synthetic.h264'), format='h264') as source, (directory / 'frames.bin').open('wb') as output:
    for packet in source.demux(video=0):
        if not packet.size:
            continue
        data = bytes(packet)
        output.write(data)
        frames.append(dict(kind='video', timestamp=1787862600000 + len(frames) * 50,
                           keyFrame=packet.is_keyframe, streamType=1, offset=offset, length=len(data)))
        offset += len(data)
assert len(frames) == 1200
with av.open(str(directory / 'synthetic.aac'), format='aac') as source, (directory / 'frames.bin').open('ab') as output:
    audio_index = 0
    for packet in source.demux(audio=0):
        if not packet.size:
            continue
        timestamp = round(audio_index * 1024 / 48000 * 1000)
        audio_index += 1
        if timestamp >= 60000:
            break
        data = bytes(packet)
        output.write(data)
        frames.append(dict(kind='audio', timestamp=1787862600000 + timestamp, offset=offset, length=len(data)))
        offset += len(data)
frames.sort(key=lambda frame: frame['timestamp'])
capture = dict(begin=1787862600, end=1787862660, reachedEnd=True, bytes=offset,
               ranges=[dict(start_time=1787862600, stop_time=1787862660)],
               segments=[dict(begin=1787862600, end=1787862660, reachedEnd=True, boundaryTimestampMs=1787862660000)],
               frames=frames, diagnostics=[])
(directory / 'frames.json').write_text(json.dumps(capture))
