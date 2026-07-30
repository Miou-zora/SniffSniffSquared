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
  let filesOut = 0;

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
    } catch (e) { return; }
    if (!fname || seenFiles[fname]) return;
    seenFiles[fname] = true;
    try {
      const proto = file.method("ToProto").invoke() as Il2Cpp.Object;
      const hex = serialize(proto);
      if (hex) { send({ event: "file", name: fname, hex }); filesOut++; }
      else send({ event: "hb", asm: "no-bytes", scanned: 0, messages: 0, files: filesOut, at: fname });
    } catch (e) {
      send({ event: "hb", asm: "toproto-threw", scanned: 0, messages: 0, files: filesOut, at: fname + " " + String(e) });
    }
  }

  // ---- harvest descriptors the game has ALREADY built ----------------------
  //
  // Every previous approach forced the descriptor into existence by invoking a
  // static getter, which deadlocks, throws or hard-crashes the process
  // depending on context (RUNBOOK part 3). Nothing here calls a static getter
  // or touches a game-protocol class: Il2Cpp.gc.choose walks the heap for
  // FileDescriptor objects the client constructed on its own, and ToProto() is
  // an instance call on an already-initialised object.
  //
  // The trade-off is coverage: only descriptors the client has actually used
  // so far are present. Log in and exercise the game, then run this.
  const fdClass = findClassAnywhere("Google.Protobuf.Reflection.FileDescriptor");
  if (!fdClass) {
    send({ event: "hb", asm: "FileDescriptor class not found", scanned: 0, messages: 0, files: 0 });
    send({ event: "done", messages: 0, files: 0, classes: 0 });
    return;
  }

  let instances: Il2Cpp.Object[] = [];
  try {
    instances = Il2Cpp.gc.choose(fdClass);
  } catch (e) {
    send({ event: "hb", asm: "gc.choose failed", scanned: 0, messages: 0, files: 0, at: String(e) });
  }
  send({ event: "hb", asm: "live FileDescriptors", scanned: instances.length, messages: 0, files: 0 });

  for (const fd of instances) emitFile(fd);

  // MessageDescriptor instances give the FullName -> obfuscated class map
  const classMap: Record<string, string> = {};
  const mdClass = findClassAnywhere("Google.Protobuf.Reflection.MessageDescriptor");
  if (mdClass) {
    let mds: Il2Cpp.Object[] = [];
    try { mds = Il2Cpp.gc.choose(mdClass); } catch (e) { /* ignore */ }
    send({ event: "hb", asm: "live MessageDescriptors", scanned: mds.length, messages: 0, files: filesOut });
    for (const md of mds) {
      try {
        const full = (md.method("get_FullName").invoke() as Il2Cpp.String).content;
        if (full) classMap[full] = "";
        emitFile(md.method("get_File").invoke() as Il2Cpp.Object);
      } catch (e) { /* skip */ }
    }
  }

  const entries = Object.keys(classMap);
  for (let i = 0; i < entries.length; i += 250) {
    const chunk: Record<string, string> = {};
    for (const k of entries.slice(i, i + 250)) chunk[k] = classMap[k];
    send({ event: "classmap", chunk });
  }

  send({ event: "done", messages: entries.length, files: filesOut, classes: instances.length });
});
