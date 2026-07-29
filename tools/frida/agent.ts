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

// Cheap prefilter: every Google.Protobuf message implements IMessage. Reading
// the interface list costs far less than invoking get_Descriptor on all ~50k
// classes, which is what made a full scan take longer than anyone would wait.
// If the bridge doesn't expose `interfaces`, fall through and test everything.
let prefilterWorks = true;
function mightBeMessage(klass: Il2Cpp.Class): boolean {
  if (!prefilterWorks) return true;
  try {
    // generated classes declare IMessage`1 / IBufferMessage as well as IMessage
    for (const i of klass.interfaces) {
      if (i.name.indexOf("IMessage") >= 0 || i.name === "IBufferMessage") return true;
    }
    return false;
  } catch (_) {
    prefilterWorks = false;
    return true;
  }
}

// The generated accessors are obfuscated in the game protocol assembly
// (get_Descriptor -> `coma`, get_Parser -> `colz`), so they can't be found by
// name. Their signatures are untouched: a static, zero-arg method returning a
// MessageDescriptor is the descriptor getter whatever it's called.
function descriptorGetter(klass: Il2Cpp.Class): Il2Cpp.Method | null {
  let byName = klass.tryMethod("get_Descriptor");
  if (byName && byName.isStatic) return byName;
  for (const m of klass.methods) {
    if (!m.isStatic || m.parameterCount !== 0) continue;
    if (m.returnType.name.indexOf("MessageDescriptor") >= 0) return m;
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
    const t0 = Date.now();
    let here = 0, seen = 0;
    for (const klass of asm.image.classes) {
      scanned++;
      seen++;
      if (!mightBeMessage(klass)) continue;
      const gd = descriptorGetter(klass);
      if (!gd) continue;
      try {
        const desc = gd.invoke() as Il2Cpp.Object;
        const full = (desc.method("get_FullName").invoke() as Il2Cpp.String).content;
        if (!full) continue;
        messages[full] = { obf: klass.type.name, fields: readFields(desc) };
        found++;
        here++;
      } catch (e) { /* not a descriptor-bearing message */ }
    }
    // per-assembly so a long scan shows progress instead of dead air
    if (here > 0 || seen > 500) {
      console.log(`[pass1] ${asm.name}: classes=${seen} messages=${here} (${Date.now() - t0}ms)`);
    }
  }
  console.log(`[pass1] done: classes scanned=${scanned} messages=${found} prefilter=${prefilterWorks}`);

  // ---- pass 2: wire id map from esg.dqft (Dictionary<int, MessageParser>) ----
  const esg = findClass("esg");
  const byteString = findClass("Google.Protobuf.ByteString");
  if (esg && byteString) {
    // the field name is obfuscated and drifts per build; fall back to whatever
    // static Dictionary<int,...> the class holds
    let dict = esg.tryField("dqft");
    if (!dict) {
      for (const f of esg.fields) {
        if (f.isStatic && f.type.name.indexOf("Dictionary") >= 0 && f.type.name.indexOf("Int32") >= 0) {
          dict = f;
          console.log(`[pass2] dqft not found; using static field ${f.name}: ${f.type.name}`);
          break;
        }
      }
    }
    if (!dict) {
      console.log(`[pass2] no id dictionary on esg; fields: ${esg.fields.map((f) => f.name).join(",")}`);
      send({ event: "done", messages, idMap });
      return;
    }
    const dqft = dict.value as Il2Cpp.Object;
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
