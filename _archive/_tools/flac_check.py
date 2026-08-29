import sys

def crc8(data):
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if (c & 0x80) else (c << 1) & 0xFF
    return c

def frame_header_len(b, pos):
    """b is bytes from frame origin; return total header length (incl crc8) or None."""
    if len(b) < 7:
        return None
    if b[0] != 0xFF or (b[1] & 0xFE) != 0xF8:
        return None
    bs_code = b[2] >> 4
    sr_code = b[2] & 0x0F
    n = 4  # after byte3 (channel/samplesize), value bytes at b[4..]
    first = b[n]
    # utf8 length of frame/sample number
    u = 1
    if first & 0x80:
        if first & 0xC0 == 0xC0:
            u += 1
            if first & 0xE0 == 0xE0:
                u += 1
                if first & 0xF0 == 0xF0:
                    u += 1
                    if first & 0xF8 == 0xF8:
                        u += 1
                        if first & 0xFC == 0xFC:
                            u += 1
    n += u
    if bs_code == 6:
        n += 1
    elif bs_code == 7:
        n += 3
    if sr_code == 12:
        n += 1
    elif sr_code == 13:
        n += 2
    elif sr_code == 14:
        n += 2
    n += 1  # crc
    return n

def run(path):
    with open(path, 'rb') as f:
        head = f.read(4)
        if head != b'fLaC':
            print('  BAD magic', head); return
        mdata_ok = True
        for m in range(100):
            meta = f.read(4)
            if len(meta) < 4: break
            is_last = meta[0] & 0x80 != 0
            blen = int.from_bytes(meta[1:4], 'big')
            if m == 0:
                si = f.read(blen)
                sr = int.from_bytes(si[10:13], 'big') >> 4
                bps = ((int.from_bytes(si[12:15], 'big') >> 4) & 0x1F) + 1
                ch = ((int.from_bytes(si[12:15], 'big') >> 1) & 0x7) + 1
                total = int.from_bytes(si[13:18], 'big') & 0xFFFFFFF
                print('  STREAMINFO sr=%dHz bps=%d ch=%d totalSamples=%d dur=%.1fs' % (sr, bps, ch, total, total / sr if sr and total else 0))
            else:
                f.seek(blen, 1)
            if is_last: break
        data_start = f.tell()
        f.seek(0, 2)
        fsize = f.tell()
        f.seek(data_start)

        ok = 0
        bad = 0
        skipped = 0
        pos = data_start
        LIMIT = 200000
        while ok + bad < LIMIT and pos < fsize - 20:
            f.seek(pos)
            buf = f.read(64)
            h = frame_header_len(buf, pos)
            if h and h <= len(buf):
                crc = crc8(bytes(buf[:h-1]))
                if crc == buf[h-1]:
                    ok += 1
                    pos += h
                    # estimated frame body = blocksize * channels * (bps/8)
                    # skip body to reach next header quickly but stay robust via scanning
                    continue
                else:
                    bad += 1
            pos += 1
        print('  frame walk scanned: header-ok=%d header-bad=%d (then advance-by-1 scan)' % (ok, bad))
        print('  VERDICT:', 'VALID FLAC' if ok > 5000 and bad <= 5 else ('VALID-ISH(%d frames)' % ok if ok > 100 else 'SUSPECT'))

for p in sys.argv[1:]:
    print('====', p)
    try:
        run(p)
    except Exception as e:
        print('  ERROR', repr(e))