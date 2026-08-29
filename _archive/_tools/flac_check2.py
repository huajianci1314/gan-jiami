import sys

def crc8(data):
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if (c & 0x80) else (c << 1) & 0xFF
    return c

def parse_frame(pos_bytes):
    """bytes at frame origin -> (header_len, blocksize, bps, ch) or None"""
    b = pos_bytes
    if len(b) < 10 or b[0] != 0xFF or (b[1] & 0xFE) != 0xF8:
        return None
    bs_code = b[2] >> 4
    sr_code = b[2] & 0x0F
    ch_code = b[3] >> 4
    ss_code = (b[3] >> 1) & 0x07
    reserved = b[3] & 0x01
    if reserved != 0:
        return None
    n = 4
    first = b[n]
    u = 1
    if first & 0xF8 == 0xF8: u += 5
    elif first & 0xF0 == 0xF0: u += 4
    elif first & 0xE0 == 0xE0: u += 3
    elif first & 0xC0 == 0xC0: u += 2
    elif first & 0x80 == 0x80: return None
    n += u
    # optional blocksize
    blk = None
    if bs_code == 6:
        blk = b[n]; n += 1
    elif bs_code == 7:
        blk = int.from_bytes(bytes(b[n:n+3]) + b'\x00', 'big')  # placeholder wrong
        blk = (b[n] << 16) | (b[n+1] << 8) | b[n+2]; n += 3
    elif bs_code == 0: blk = 192
    elif bs_code == 1: blk = 576
    elif bs_code == 2: blk = 1152
    elif bs_code == 3: blk = 2304
    elif bs_code == 4: blk = 4608
    elif bs_code == 5: blk = 8192
    elif bs_code == 8: blk = 256
    elif bs_code == 9: blk = 512
    elif bs_code == 10: blk = 1024
    elif bs_code == 11: blk = 2048
    elif bs_code == 12: blk = 4096
    elif bs_code == 13: blk = 8192
    elif bs_code == 14: blk = 16384
    elif bs_code == 15: blk = 32768
    # sr code 14 = 8-bit kbps x1000, handled as extra bytes
    if sr_code == 12: n += 1
    elif sr_code == 13: n += 2
    elif sr_code == 14: n += 2
    hlen = n + 1
    if bps_code_maps.get(ss_code) is None:
        pass
    bps = {0:0,1:0,2:16,3:20,4:24,5:32}.get(ss_code, None)
    ch = 1
    if ch_code == 0: ch = 1
    elif ch_code in (1,2,3): ch = 2
    elif ch_code in (4,5,6,7): ch = 1 if False else 2
    else:
        # ch_code 8..11: 5+ch channels with left/right side; 12..14: independent
        if ch_code == 8: ch = 5
        elif ch_code == 9: ch = 6
        elif ch_code == 10: ch = 7
        elif ch_code == 11: ch = 8
        elif ch_code in (12,13,14): ch = 2  # independent stereo
        else: ch = 0
    return (hlen, blk, bps, ch)

bps_code_maps = {0:0,1:0,2:16,3:20,4:24,5:32}

def run(path):
    src = open(path, 'rb').read()
    assert src[:4] == b'fLaC'
    o = 4
    while o < len(src):
        meta = src[o:o+4]
        if len(meta) < 4: break
        is_last = meta[0] & 0x80 != 0
        blen = int.from_bytes(meta[1:4], 'big')
        if o == 4:
            si = src[len(src)-2000000:len(src)]  # dummy to skip
        if o == 4:
            si = src[8:8+blen]
            sr = int.from_bytes(si[10:13], 'big') >> 4
            bps = ((int.from_bytes(si[12:15], 'big') >> 4) & 0x1F) + 1
            ch = ((int.from_bytes(si[12:15], 'big') >> 1) & 0x7) + 1
            total = int.from_bytes(si[13:18], 'big') & 0xFFFFFFFFF
            print('  STREAMINFO sr=%d bps=%d ch=%d total=%d dur=%.1f' % (sr, bps, ch, total, total/sr if total else 0))
        o += 4 + blen
        if is_last: break
    body = src[o:]
    pos = 0
    ok = 0
    bad = 0
    nFrames = 0
    while pos < len(body) - 4:
        pf = parse_frame(body[pos:])
        if pf:
            hlen, blk, bps, ch = pf
            if hlen <= len(body) - pos:
                crc = crc8(body[pos:pos+hlen-1])
                if crc == body[pos+hlen-1]:
                    ok += 1
                    # skip body if block size known and bps known
                    if blk and bps and ch:
                        nFrames += 1
                        pos += hlen + blk * ch * (bps // 8)
                        continue
            bad += 1
        pos += 1
    print('  frames(CRC ok, body-skipped)=%d  other headers tempted ok=%d bad=%d' % (nFrames, ok, bad))
    print('  VERDICT:', 'VALID' if nFrames > 5000 else ('VALID-BUT-LOW(%d)' % nFrames if nFrames>1000 else 'SUSPECT(%d)' % nFrames))

for p in sys.argv[1:]:
    print('====', p)
    run(p)