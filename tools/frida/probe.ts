/*
 * Diagnostic probe #2 — the game-protocol classes implement IMessage but have
 * no Descriptor/Parser (reflection stripped), yet the wire carries
 * `type.ankama.com/<name>`. Find where that <name> comes from.
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

Il2Cpp.perform(() => {
  // ---- full member list of a message we see on the wire ----
  const ksv = findClass("ksv");
  if (ksv) {
    console.log("[probe] ksv fields:");
    for (const f of ksv.fields) {
      console.log(`  ${f.isStatic ? "static " : ""}${f.name}: ${f.type.name}`);
    }
    console.log("[probe] ksv methods:");
    for (const m of ksv.methods) {
      console.log(`  ${m.isStatic ? "static " : ""}${m.name} -> ${m.returnType.name} (${m.parameterCount})`);
    }
    // static string fields often hold the proto name
    for (const f of ksv.fields) {
      if (!f.isStatic || f.type.name.indexOf("String") < 0) continue;
      try {
        console.log(`  [static string] ${f.name} = ${(f.value as Il2Cpp.String).content}`);
      } catch (e) { /* not readable */ }
    }
  } else {
    console.log("[probe] ksv not found");
  }

  // ---- who holds a String-keyed registry (type url -> parser/factory)? ----
  console.log("[probe] static Dictionary<String,...> fields:");
  let hits = 0;
  for (const asm of Il2Cpp.domain.assemblies) {
    for (const klass of asm.image.classes) {
      let fields;
      try {
        fields = klass.fields;
      } catch (_) {
        continue;
      }
      for (const f of fields) {
        if (!f.isStatic) continue;
        const tn = f.type.name;
        if (tn.indexOf("Dictionary<System.String") < 0) continue;
        // only the ones whose value side smells like a message factory
        if (!/Parser|Message|Type|Func|Delegate/.test(tn)) continue;
        console.log(`  ${klass.type.name}.${f.name}: ${tn}`);
        if (++hits >= 20) break;
      }
      if (hits >= 20) break;
    }
    if (hits >= 20) break;
  }
  console.log(`[probe] string-keyed registry candidates=${hits}`);

  // ---- anything referencing the Any type url prefix ----
  const any = findClass("Google.Protobuf.WellKnownTypes.Any");
  if (any) {
    console.log("[probe] Any methods:");
    for (const m of any.methods) {
      console.log(`  ${m.isStatic ? "static " : ""}${m.name} -> ${m.returnType.name} (${m.parameterCount})`);
    }
  }

  send({ event: "done", messages: {}, idMap: {} });
});
