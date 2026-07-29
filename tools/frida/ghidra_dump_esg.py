# Ghidra (Jython) — extract the Dofus 3 wire id map from GameAssembly.dylib.
#
# Prereq: load GameAssembly.dylib in Ghidra, then run Il2CppDumper's ghidra.py
#         (ships next to your dump.cs) to apply symbol names + types.
# Then:   Window > Script Manager > run this script.
#
# It decompiles esg..cctor (the static ctor that fills
# Dictionary<int,MessageParser> dqft) and scrapes the
#   dqft.Add(<id>, <ObfType>.get_Parser())
# pairs. Output: id -> obfuscated message type. Cross-reference with the
# runtime/descriptor names (agent.ts) or Mapping.v2*.json to get real names.
#
# Also dumps the raw decompiled C to /tmp/esg_cctor.c as a reliable fallback
# if the regex misses (obfuscated symbol shapes vary by Il2CppDumper version).
import re
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

RVA = 0x1AF2A50  # esg..cctor  (RVA == VA in the dump; adjust if Ghidra rebased)

def find_func():
    fm = currentProgram.getFunctionManager()
    # 1) by symbol name applied by ghidra.py
    st = currentProgram.getSymbolTable()
    for sym in st.getAllSymbols(True):
        n = sym.getName()
        if "esg" in n and ("cctor" in n or ".cctor" in n):
            f = fm.getFunctionAt(sym.getAddress())
            if f:
                return f
    # 2) by address = image_base + RVA
    base = currentProgram.getImageBase()
    addr = base.add(RVA)
    f = fm.getFunctionContaining(addr)
    return f

def main():
    f = find_func()
    if f is None:
        print("esg..cctor not found. Run Il2CppDumper's ghidra.py first, "
              "or check the RVA / image base.")
        return
    print("Decompiling %s @ %s" % (f.getName(), f.getEntryPoint()))

    di = DecompInterface()
    di.openProgram(currentProgram)
    res = di.decompileFunction(f, 120, ConsoleTaskMonitor())
    c = res.getDecompiledFunction().getC()

    with open("/tmp/esg_cctor.c", "w") as fh:
        fh.write(c)
    print("raw decompilation -> /tmp/esg_cctor.c")

    # scrape: ...Add(<dict>, <int id>, <Type>get_Parser...)
    # obfuscated getters look like  Foo__get_Parser / Foo$$get_Parser / Foo.get_Parser
    pairs = {}
    add_re = re.compile(r'Add\s*\([^,]+,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*([A-Za-z0-9_.$]*?get_Parser)')
    for m in add_re.finditer(c):
        num = int(m.group(1), 0)
        getter = m.group(2)
        typ = re.split(r'[._$]+get_Parser', getter)[0].strip("._$")
        pairs[num] = typ

    print("scraped %d id->type pairs" % len(pairs))
    out = "/tmp/esg_idmap.json"
    with open(out, "w") as fh:
        fh.write("{\n")
        fh.write(",\n".join('  "%d": "%s"' % (k, pairs[k]) for k in sorted(pairs)))
        fh.write("\n}\n")
    print("wrote %s" % out)
    if not pairs:
        print("No pairs scraped — inspect /tmp/esg_cctor.c and tune add_re "
              "to the Add-call shape your Il2CppDumper build produced.")

main()
