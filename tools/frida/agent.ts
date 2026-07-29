/*
 * Dofus 3 protocol dumper — runtime, build-exact.
 *
 * Extracts, from the LIVE client:
 *   - every protobuf message: real FullName + real field names/numbers/types
 *     (read from Google.Protobuf MessageDescriptor, which carries the real
 *      proto names even though the C# type names are obfuscated)
 *   - the wire id <-> message map (static class `esg`: Dictionary<int,MessageParser> dqft)
 *
 * Writes /tmp/dofus_protocol.json on the machine running the client.
 *
 * Build:  npm i frida-il2cpp-bridge && npx frida-compile agent.ts -o agent.js
 * Run:    frida -U -n Dofus -l agent.js         (attach to running client)
 *   or    frida -U -f com.ankama.dofus -l agent.js --no-pause
 *
 * NOTE: three spots depend on frida-il2cpp-bridge version — flagged with (VERIFY).
 *       If a call throws "no such method/field/property", check those first.
 */
import "frida-il2cpp-bridge";

// Google.Protobuf.Reflection.FieldType enum -> proto type keyword
const FIELD_TYPE: Record<number, string> = {
  0: "double", 1: "float", 2: "int64", 3: "uint64", 4: "int32",
  5: "fixed64", 6: "fixed32", 7: "bool", 8: "string", 9: "group",
  10: "message", 11: "bytes", 12: "uint32", 13: "enum",
  14: "sfixed32", 15: "sfixed64", 16: "sint32", 17: "sint64",
};

function findClass(fullName: string): Il2Cpp.Class | null {
  for (const asm of Il2Cpp.domain.assemblies) {
    const k = asm.image.tryClass(fullName);
    if (k) return k;
  }
  return null;
}

// find a method by name whose single parameter's type name matches paramType
function findOverload(klass: Il2Cpp.Class, name: string, paramType: string): Il2Cpp.Method | null {
  for (const m of klass.methods) {
    if (m.name === name && m.parameterCount === 1 && m.parameters[0].type.name.indexOf(paramType) >= 0) {
      return m;
    }
  }
  return null;
}

function readFields(descriptor: Il2Cpp.Object): any[] {
  const out: any[] = [];
  const coll = descriptor.method("get_Fields").invoke() as Il2Cpp.Object;              // FieldCollection
  const list = coll.method("InDeclarationOrder").invoke() as Il2Cpp.Object;            // IList<FieldDescriptor>
  const count = (list.method("get_Count").invoke() as number);
  for (let i = 0; i < count; i++) {
    const f = list.method("get_Item").invoke(i) as Il2Cpp.Object;                      // FieldDescriptor
    const ftype = f.method("get_FieldType").invoke() as number;
    const rec: any = {
      name: (f.method("get_Name").invoke() as Il2Cpp.String).content,
      number: f.method("get_FieldNumber").invoke() as number,
      type: FIELD_TYPE[ftype] ?? String(ftype),
      repeated: f.method("get_IsRepeated").invoke() as boolean,
      map: f.method("get_IsMap").invoke() as boolean,
    };
    try {
      if (rec.type === "message" || rec.type === "group") {
        const mt = f.method("get_MessageType").invoke() as Il2Cpp.Object;
        rec.ref = (mt.method("get_FullName").invoke() as Il2Cpp.String).content;
      } else if (rec.type === "enum") {
        const et = f.method("get_EnumType").invoke() as Il2Cpp.Object;
        rec.ref = (et.method("get_FullName").invoke() as Il2Cpp.String).content;
      }
    } catch (_) { /* older proto lib: skip ref */ }
    out.push(rec);
  }
  return out;
}

Il2Cpp.perform(() => {
  const messages: Record<string, any> = {};   // fullName -> {fields}
  let idMap: Record<string, number> = {};      // fullName -> wire id

  // ---- pass 1: every protobuf message descriptor (names + fields) ----
  let scanned = 0, found = 0;
  for (const asm of Il2Cpp.domain.assemblies) {
    for (const klass of asm.image.classes) {
      scanned++;
      const gd = klass.tryMethod("get_Descriptor");
      const gp = klass.tryMethod("get_Parser");
      if (!gd || !gp || !gd.isStatic) continue;
      // a real message has both a static Descriptor and a static Parser
      if (gp.returnType.name.indexOf("MessageParser") < 0) continue;
      try {
        const desc = gd.invoke() as Il2Cpp.Object;
        const full = (desc.method("get_FullName").invoke() as Il2Cpp.String).content;
        if (!full) continue;
        messages[full] = { obf: klass.type.name, fields: readFields(desc) };
        found++;
      } catch (e) { /* not a descriptor-bearing message */ }
    }
  }
  console.log(`[pass1] classes scanned=${scanned} messages=${found}`);

  // ---- pass 2: wire id map from esg.dqft (Dictionary<int, MessageParser>) ----
  const esg = findClass("esg");
  const byteString = findClass("Google.Protobuf.ByteString");
  if (esg && byteString) {
    const dqft = esg.field("dqft").value as Il2Cpp.Object;                 // (VERIFY) field name
    const empty = byteString.method("get_Empty").invoke() as Il2Cpp.Object;
    const en = dqft.method("GetEnumerator").invoke() as Il2Cpp.Object;
    let n = 0;
    while (en.method("MoveNext").invoke() as boolean) {
      const cur = en.method("get_Current").invoke() as Il2Cpp.Object;      // KeyValuePair<int,MessageParser>
      const id = cur.method("get_Key").invoke() as number;
      const parser = cur.method("get_Value").invoke() as Il2Cpp.Object;    // MessageParser
      try {
        // parse empty -> default instance -> real descriptor name
        const parse = findOverload(parser.class, "ParseFrom", "ByteString");   // (VERIFY) overload
        const msg = parse!.invoke(empty) as Il2Cpp.Object;
        const desc = msg.method("get_Descriptor").invoke() as Il2Cpp.Object;
        const full = (desc.method("get_FullName").invoke() as Il2Cpp.String).content;
        if (!full) continue;
        idMap[full] = id;
        if (messages[full]) messages[full].id = id;
        n++;
      } catch (e) { console.log(`  id ${id}: ${e}`); }
    }
    console.log(`[pass2] esg entries mapped=${n}`);
  } else {
    console.log(`[pass2] SKIPPED: esg=${!!esg} ByteString=${!!byteString} (adjust class name)`);
  }

  console.log(`done: messages=${Object.keys(messages).length}, ids=${Object.keys(idMap).length}`);
  // hand the result to the host runner (run.py), which writes the file and exits
  send({ event: "done", messages, idMap });
});
