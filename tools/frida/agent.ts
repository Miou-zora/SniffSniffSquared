/*
 * Dofus 3 protocol dumper — runtime, build-exact.
 *
 * Extracts, from the LIVE client, the serialized FileDescriptorProto of every
 * .proto file the client has loaded. That single blob per file carries real
 * message names, real field names, numbers, types and nesting — everything
 * `proto/messages.json` is missing.
 *
 * WHY THIS SHAPE: walking FieldDescriptors through the bridge costs ~8 IL2CPP
 * invokes per field, ~184k invokes over the whole protocol. That version never
 * finished (killed at ~25 min, freezing the client). Going via
 * FileDescriptor.ToProto() is ~4 invokes per *message* and one serialization
 * per *file*, and the parsing happens host-side in Python instead.
 *
 * Results stream out per file, so a kill mid-scan still yields partial data.
 *
 * Build: npx frida-compile agent.ts -o agent.js
 * Run:   run.py -p <pid>          (see RUNBOOK.md part 2.5)
 */
import "frida-il2cpp-bridge";

// ---- helpers ---------------------------------------------------------------

/** Cheap prefilter: every Google.Protobuf message implements IMessage. */
let prefilterWorks = true;
function mightBeMessage(klass: Il2Cpp.Class): boolean {
  if (!prefilterWorks) return true;
  try {
    for (const i of klass.interfaces) {
      if (i.name.indexOf("IMessage") >= 0 || i.name === "IBufferMessage") return true;
    }
    return false;
  } catch (_) {
    prefilterWorks = false;
    return true;
  }
}

/**
 * Classes whose descriptor getter deadlocks when invoked from an injected
 * thread: the static constructor waits on something that never completes here
 * (the process goes idle, not busy). There is no way to time out an IL2CPP
 * invoke, so the only option is to not make the call.
 *
 * Add any class the heartbeat names as "INVOKING <x>" immediately before a
 * hang. Skipping one costs nothing when another class in the same .proto file
 * still resolves -- we only need one descriptor per file.
 */
const POISON = new Set<string>(["hdx"]);

/**
 * The generated accessors are obfuscated in the game protocol assembly
 * (get_Descriptor -> `coma`, get_Parser -> `colz`), so they cannot be found by
 * name — doing so silently yields ZERO messages while appearing to work.
 * Signatures survive obfuscation: static, zero-arg, returns MessageDescriptor.
 */
function descriptorGetter(klass: Il2Cpp.Class): Il2Cpp.Method | null {
  const byName = klass.tryMethod("get_Descriptor");
  if (byName && byName.isStatic) return byName;
  for (const m of klass.methods) {
    if (!m.isStatic || m.parameterCount !== 0) continue;
    if (m.returnType.name.indexOf("MessageDescriptor") >= 0) return m;
  }
  return null;
}

/** `ToByteArray()` is an extension method, so it lives on MessageExtensions. */
let toByteArray: Il2Cpp.Method | null = null;
function findToByteArray(): Il2Cpp.Method | null {
  if (toByteArray) return toByteArray;
  for (const asm of Il2Cpp.domain.assemblies) {
    const k = asm.image.tryClass("Google.Protobuf.MessageExtensions");
    if (!k) continue;
    for (const m of k.methods) {
      if (m.name === "ToByteArray" && m.isStatic && m.parameterCount === 1) {
        toByteArray = m;
        return m;
      }
    }
  }
  return null;
}

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));

/**
 * Serialize any IMessage to a hex string, via the extension method.
 *
 * Hex rather than frida's binary `send(payload, data)` channel: sending the
 * descriptor as binary stalls the scan partway through the first assembly.
 * Built via a lookup table into a preallocated array — the obvious
 * `out += ...` loop is quadratic and wedges on multi-megabyte descriptors.
 */
function serialize(msg: Il2Cpp.Object): string | null {
  const tba = findToByteArray();
  if (!tba) return null;
  try {
    const arr = tba.invoke(msg) as Il2Cpp.Array;
    const len = arr.length;
    // no `.elements` in bridge 0.13 — element data begins after the array header
    const buf = arr.handle.add(Il2Cpp.Array.headerSize).readByteArray(len);
    if (!buf) return null;
    const u8 = new Uint8Array(buf);
    const parts: string[] = new Array(len);
    for (let i = 0; i < len; i++) parts[i] = HEX[u8[i]];
    return parts.join("");
  } catch (e) {
    return null;
  }
}

// ---- main ------------------------------------------------------------------

// Runs at top level, synchronously inside script.load().
//
// Deferring it (setTimeout, with either the free or the "main" thread flag)
// reliably stalls partway through the first assembly with the process idle —
// blocked, not working. Synchronous execution gets through it. The cost is
// that load() exceeds frida's RPC deadline and raises TransportError on the
// host; the agent keeps running regardless, so run.py treats that as expected
// and goes on pumping messages instead of tearing the session down.
Il2Cpp.perform(() => {
  const seenFiles: Record<string, boolean> = {};
  const classMap: Record<string, string> = {}; // descriptor FullName -> obfuscated C# type
  let messages = 0,
    filesOut = 0,
    scanned = 0;

  if (!findToByteArray()) {
    console.log("[agent] WARNING: MessageExtensions.ToByteArray not found; cannot serialize descriptors");
  }

    // ---- seed from classes known to be on the wire -------------------------
  //
  // A blind class scan deadlocks almost immediately: invoking the descriptor
  // getter on the first classes of Ankama.Dofus.Protocol.Game (hdx, then hdy,
  // ...) never returns, and the process goes idle rather than busy. Skipping
  // them one at a time does not converge -- they all trip the same shared
  // static initialisation.
  //
  // Directly resolving a class that is actually used on the wire works fine
  // (verified with `ksv`). So seed from those, take each one's FileDescriptor,
  // and walk the dependency graph. One serialized FileDescriptorProto covers
  // every message in that .proto file, so a handful of seeds reaches the whole
  // protocol without touching the poisoned classes.
  const SEEDS = [
    "ksv", "jrj", "jri", "iwa", "kmw", "knh", "jpp", "kqh", "kdh", "kag", "jqj",
  ];

  const pending: Il2Cpp.Object[] = [];

  function findClassAnywhere(name: string): Il2Cpp.Class | null {
    for (const a of Il2Cpp.domain.assemblies) {
      const k = a.image.tryClass(name);
      if (k) return k;
    }
    return null;
  }

  function emitFile(file: Il2Cpp.Object): void {
    let fname = "";
    try {
      fname = (file.method("get_Name").invoke() as Il2Cpp.String).content || "";
    } catch (e) {
      return;
    }
    if (!fname || seenFiles[fname]) return;
    seenFiles[fname] = true;
    try {
      const proto = file.method("ToProto").invoke() as Il2Cpp.Object;
      const hex = serialize(proto);
      if (hex) {
        send({ event: "file", name: fname, hex });
        filesOut++;
      }
    } catch (e) {
      send({ event: "hb", asm: "serialize-failed", scanned, messages, files: filesOut, at: fname });
    }
    // follow imports so one seed can reach a whole package
    try {
      const deps = file.method("get_Dependencies").invoke() as Il2Cpp.Object;
      const n = deps.method("get_Count").invoke() as number;
      for (let i = 0; i < n; i++) {
        pending.push(deps.method("get_Item").invoke(i) as Il2Cpp.Object);
      }
    } catch (e) {
      /* no Dependencies accessor on this protobuf version */
    }
  }

  for (const name of SEEDS) {
    scanned++;
    const klass = findClassAnywhere(name);
    if (!klass) {
      send({ event: "hb", asm: "seed", scanned, messages, files: filesOut, skipped: name + " (absent)" });
      continue;
    }
    const gd = descriptorGetter(klass);
    if (!gd) {
      send({ event: "hb", asm: "seed", scanned, messages, files: filesOut, skipped: name + " (no descriptor)" });
      continue;
    }
    send({ event: "hb", asm: "seed", scanned, messages, files: filesOut, invoking: name });
    try {
      const desc = gd.invoke() as Il2Cpp.Object;
      const full = (desc.method("get_FullName").invoke() as Il2Cpp.String).content;
      if (full) {
        classMap[full] = klass.type.name;
        messages++;
      }
      emitFile(desc.method("get_File").invoke() as Il2Cpp.Object);
    } catch (e) {
      send({ event: "hb", asm: "seed", scanned, messages, files: filesOut, skipped: name + " (threw)" });
    }
  }

  // transitive imports
  while (pending.length > 0) {
    emitFile(pending.pop() as Il2Cpp.Object);
  }

  // class map in batches, so one oversized message can't stall the transport
  const entries = Object.keys(classMap);
  for (let i = 0; i < entries.length; i += 250) {
    const chunk: Record<string, string> = {};
    for (const k of entries.slice(i, i + 250)) chunk[k] = classMap[k];
    send({ event: "classmap", chunk });
  }

  console.log(`[agent] done: classes=${scanned} messages=${messages} files=${filesOut}`);
  send({ event: "done", messages, files: filesOut, classes: scanned });
});
