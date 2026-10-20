import sys, struct

with open(r"G:\Users\nakano\Desktop\[W10-64bit] ガリバー・プロステージ ver 6.2.0(クラサバ版)Full新規インスト用\ISSetup.dll", "rb") as f:
    dll = f.read()

def dump(start, end, label):
    print(f"=== {label} (0x{start:06x}..0x{end:06x}) ===")
    chunk = dll[start:end]
    for i in range(0, len(chunk), 16):
        print(f"{start+i:06x}: {chunk[i:i+16].hex(' ')}")

dump(0x09f5e0, 0x09f690, "Helpers before 0x09f68e")
dump(0x08abe0, 0x08ac30, "decrypt_byte at 0x08abf9")
dump(0x041f80, 0x042060, "setup.inx loader at 0x041fd1")

# Also find all CALLs to 0x09f68e (relative E8 xx xx xx xx where target is 0x09f68e)
for i in range(0x400, 0xca000):
    if dll[i] == 0xe8:
        rel = struct.unpack_from("<i", dll, i+1)[0]
        if i + 5 + rel == 0x09f68e:
            print(f"CALL to 0x09f68e at raw 0x{i:06x}")
            dump(i-32, i+32, f"Caller at 0x{i:06x}")
