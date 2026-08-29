import sys, soundfile as sf
for f in sys.argv[1:]:
    try:
        info = sf.info(f)
        print(f, '->', info.samplerate, 'Hz', info.channels, 'ch', 'dur=%.2fs' % info.duration, 'frames=', info.frames)
        # fully decode first 2 seconds to prove playable
        data, sr = sf.read(f, frames=int(2 * info.samplerate), dtype='float32')
        print(f, '  decoded ok: %d samples,%d ch  absmax=%.4f' % (data.shape[0], data.shape[1] if len(data.shape) > 1 else 1, float(abs(data).max())))
    except Exception as e:
        print(f, 'ERROR:', str(e)[:160])