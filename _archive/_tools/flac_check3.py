import sys, mmap

def crc8(data):
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if (c & 0x80) else (c << 1) & 0xFF
    return c

BS = {0:192,1:576,2:1152,3:2304,4:4608,5:8192,8:256,9:512,10:1024,11:2048,12:4096,13:8192,14:16384,15:32768}
BPS = {0:0,1:0,2:16,3:20,4:24,5:32}
CH_BASE = {0:1}

def parse_frame(b):
    if len(b) < 10 or b[0] != 0xFF or (b[1] & 0xFE) != 0xF8:
        return None
    bs_code = b[2] >> 4
    sr_code = b[2] & 0x0F
    ch_code = b[3] >> 4
    ss_code = (b[3] >> 1) & 0x07
    if (b[3] & 0x01) != 0:
        return None
    n = 4
    first = b[n]
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
        elif first & 0x80:
            pass
    n += u
    blk = BS.get(bs_code)
    if bs_code == 6:
        blk = b[n]; n += 1
    elif bs_code == 7:
        blk = (b[n] << 16) | (b[n+1] << 8) | b[n+2]; n += 3
    if sr_code == 12: n += 1
    elif sr_code == 13: n += 2
    elif sr_code == 14: n += 2
    hlen = n + 1
    bps = BPS.get(ss_code)
    if ch_code == 0: ch = 1
    elif ch_code in (1,2,3): ch = 2
    elif ch_code == 4: ch = 2   # left+left
    elif ch_code == 5: ch = 2   # right+right
    elif ch_code in (6,7): ch = 2  # reserved(1,lipside) treat as stereo
    elif ch_code in (8,9,10,11): ch = 5 + (ch_code - 8)
    elif ch_code in (12,13,14): ch = 2
    else: ch = 2
    if ch is None: ch = 2
    if not bps: return (hlen, blk, 0, ch)
    return (hlen, blk, bps, ch)

def run(path):
    f = open(path, 'rb')
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    size = len(mm)
    assert mm[:4] == b'fLaC', 'magic'
    o = 4
    while o < size:
        meta = mm[o:o+4]
        is_last = meta[0] & 0x80 != 0
        blen = int(meta[1])<<16 | int(meta[2])<<8 | int(meta[3])
        if o == 4:
            si = mm[8:8+blen]
            sr = int.from_bytes(si[10:13], 'big') >> 4
            bps = ((int.from_bytes(si[12:15], 'big') >> 4) & 0x1F) + 1
            ch = ((int.from_bytes(si[12:15], 'big') >> 1) & 0x7) + 1
            total = int.from_bytes(si[13:18], 'big') & 0xFFFFFFFFF
            print('  STREAMINFO sr=%d bps=%d ch=%d total=%d dur=%.1fs' % (sr, bps, ch, total, total/sr if total else 0), flush=True)
        o += 4 + blen
        if is_last: break
    body = o
    pos = body
    nFrames = 0
    okHeaders = 0
    while pos < size - 4:
        b = mm[pos:pos+32]
        pf = parse_frame(b)
        if pf:
            hlen, blk, bps, ch = pf
            if hlen <= size - pos:
                if crc8(mm[pos:pos+hlen-1]) == mm[pos+hlen-1]:
                    okHeaders += 1
                    if blk and bps and ch:
                        nFrames += 1
                        pos += hlen + blk * ch * (bps // 8)
                        continue
        pos += 1
    print('  valid-frame-bodies=%d  crc-ok-headers(any)=%d' % (nFrames, okHeaders), flush=True)
    print('  VERDICT:', 'VALID' if nFrames > 5000 else ('VALID-BUT-LOW(%d)' % nFrames if nFrames > 1000 else 'SUSPECT(%d)' % nFrames), flush=True)
    mm.close(); f.close()

for p in sys.argv[1:]:
    print('====', p)
    run(p)