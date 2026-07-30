/*
 * Diagnostic probe — what does the protobuf reflection API expose, and is
 * there a bulk path that avoids ~80 IL2CPP invokes per message?
 *
 * The per-field walk in agent.ts costs roughly 8 invokes per field across
 * ~2300 messages and has never finished. If FileDescriptor exposes its
 * serialized FileDescriptorProto, one call per .proto file yields every
 * message in it and we parse host-side instead.
 *
 * Build: npx frida-compile probe.ts -o probe.js
 * Run:   run.py -p <pid> -a probe.js
 */
import "frida-il2cpp-bridge";

function findClass(name: string): Il2Cpp.Class | null {
  for (const asm of Il2Cpp.domain.assemblies) {
    const k = asm.image.tryClass(name);
    if (k) return k;
  }
  return null;
}

function members(klass: Il2Cpp.Class, label: string) {
  console.log(`[probe] ${label} methods:`);
  for (const m of klass.methods) {
    if (m.parameterCount > 1) continue;
    console.log(`  ${m.isStatic ? "static " : ""}${m.name} -> ${m.returnType.name} (${m.parameterCount})`);
  }
  console.log(`[probe] ${label} fields:`);
  for (const f of klass.fields) {
    console.log(`  ${f.isStatic ? "static " : ""}${f.name}: ${f.type.name}`);
  }
}

Il2Cpp.perform(() => {
  const md = findClass("Google.Protobuf.Reflection.MessageDescriptor");
  const fd = findClass("Google.Protobuf.Reflection.FileDescriptor");
  if (md) members(md, "MessageDescriptor");
  if (fd) members(fd, "FileDescriptor");

  // Can we reach a serialized descriptor from a real message class?
  const ksv = findClass("ksv");
  if (ksv) {
    let getter: Il2Cpp.Method | null = null;
    for (const m of ksv.methods) {
      if (m.isStatic && m.parameterCount === 0 && m.returnType.name.indexOf("MessageDescriptor") >= 0) {
        getter = m;
        break;
      }
    }
    if (getter) {
      const desc = getter.invoke() as Il2Cpp.Object;
      console.log(`[probe] ksv descriptor FullName = ${(desc.method("get_FullName").invoke() as Il2Cpp.String).content}`);
      try {
        const file = desc.method("get_File").invoke() as Il2Cpp.Object;
        console.log(`[probe] ksv .File name = ${(file.method("get_Name").invoke() as Il2Cpp.String).content}`);
        // the prize: serialized FileDescriptorProto for the whole file
        for (const cand of ["get_SerializedData", "get_SerializedProto", "SerializedData"]) {
          try {
            const bs = file.method(cand).invoke() as Il2Cpp.Object;
            const len = bs.method("get_Length").invoke() as number;
            console.log(`[probe] *** ${cand} -> ByteString of ${len} bytes ***`);
          } catch (e) {
            console.log(`[probe] ${cand}: not available`);
          }
        }
      } catch (e) {
        console.log(`[probe] .File: ${e}`);
      }
    }
  }

  send({ event: "done", messages: {}, idMap: {} });
});
