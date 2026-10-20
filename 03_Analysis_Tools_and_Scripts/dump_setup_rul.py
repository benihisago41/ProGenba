import sys, struct
sys.stdout.reconfigure(encoding='utf-8')

with open(r"C:\Users\nakano\.gemini\antigravity\brain\67c25ccc-3e29-4bbd-b832-e8ec35f8f333\scratch\setup_decrypted.inx", "rb") as f:
    dec = f.read()

# In InstallScript INX bytecode, string literals are preceded by opcode 0x06 (or 0x21 <H len>)
# Let's scan 0x07e00..0x09750 for length-prefixed strings or print hex+cp932!
chunk = dec[0x07e00:0x09750]
i = 0
while i < len(chunk) - 3:
    # Check if uint16 at i is a valid cp932 string length (1..200) followed by printable cp932
    ln = struct.unpack_from("<H", chunk, i)[0]
    if 1 <= ln <= 200 and i + 2 + ln <= len(chunk):
        s_bytes = chunk[i+2:i+2+ln]
        if all(b >= 0x20 or b in (0x09, 0x0a, 0x0d) for b in s_bytes):
            try:
                s = s_bytes.decode('cp932')
                # verify no weird control chars
                if all(ord(c) >= 0x20 or c in '\r\n\t' for c in s):
                    print(f"[0x{0x07e00+i:05x}] (len={ln:3d}): {repr(s)}")
                    i += 2 + ln
                    continue
            except:
                pass
    i += 1
