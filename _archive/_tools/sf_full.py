import sys, soundfile as sf
for f in sys.argv[1:]:
    try:
        info = sf.info(f)
        data, sr = sf.read(f, dtype='float32')  # full decode
        ch = data.shape[1] if len(data.shape) > 1 else 1
        print(f, 'FULL-DECODE OK  dur=%.2fs frames=%d ch=%d absmax=%.4f' % (
            info.duration, data.shape[0], ch, float(abs(data).max())))
    except Exception as e:
        print(f, 'FULL-DECODE FAIL:', str(e)[:200])