import sys, re
sys.stdout.reconfigure(encoding='utf-8')

path = r"G:\Users\nakano\Desktop\[W10-64bit] ガリバー・プロステージ ver 6.2.0(クラサバ版)Full新規インスト用\setup.inx"
with open(path, "rb") as f:
    data = f.read()

dec = bytes((((((b ^ 0xf1) >> 2) | ((b ^ 0xf1) << 6)) & 0xff) - (i % 71)) & 0xff for i, b in enumerate(data))
out_path = r"C:\Users\nakano\.gemini\antigravity\brain\67c25ccc-3e29-4bbd-b832-e8ec35f8f333\scratch\setup_decrypted.inx"
with open(out_path, "wb") as f:
    f.write(dec)

print(f"Decrypted {len(dec)} bytes. Null count: {dec.count(0)}")
print("First 128 bytes:", dec[:128])

print("\n=== Custom Strings / Paths / Commands in setup.inx ===")
for m in re.finditer(b'[\x20-\x7e\x81-\x9f\xe0-\xfc]{4,}', dec):
    raw_s = m.group(0)
    try:
        s = raw_s.decode('cp932')
        if any(w in s.lower() for w in [
            'asakawa', 'prostage', 'gllvr', 'kensetsu', 'sirius', 'psql', 'oracle',
            'gac', 'assembly', 'bat', 'dsn', 'package', 'check', 'callinstall',
            'vcredist', 'odbc', 'shortcut', 'desktop', 'menu', 'web', 'bin',
            'ガリバー', 'プロステージ', 'ネクスト', 'next', 'クライアント', 'サーバ', 'データベース',
            'regist', 'tools.ini', 'rmtools.ini', 'ask', 'packagechecktmp'
        ]):
            print(f"[0x{m.start():05x}] {s}")
    except:
        pass

print("\n=== UTF-16LE Strings in setup.inx ===")
for m in re.finditer(b'(?:[\x20-\x7e]\x00){4,}', dec):
    s = m.group(0).decode('utf-16le', errors='ignore')
    if any(w in s.lower() for w in [
        'asakawa', 'prostage', 'gllvr', 'kensetsu', 'sirius', 'psql', 'oracle',
        'gac', 'assembly', 'bat', 'dsn', 'package', 'check', 'callinstall',
        'vcredist', 'odbc', 'shortcut', 'desktop', 'menu', 'web', 'bin',
        'regist', 'tools', 'ask', 'ini', 'exe', 'dll'
    ]):
        print(f"[0x{m.start():05x}] {s}")
