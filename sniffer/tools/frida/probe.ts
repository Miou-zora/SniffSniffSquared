/*
 * Find a method the game calls regularly on its own thread, to piggyback the
 * descriptor extraction onto.
 *
 * Why: invoking a game-protocol descriptor getter from an injected thread
 * deadlocks (see RUNBOOK part 3). Il2Cpp.perform(..., "main") does not help --
 * it attaches our thread to the main context rather than running our code on
 * the game's thread. Hooking a real per-frame method does.
 *
 * Build: npx frida-compile probe.ts -o probe.js
 * Run:   run.py -p <pid> -a probe.js
 */
import "frida-il2cpp-bridge";

Il2Cpp.perform(() => {
  const candidates: { klass: string; method: string; asm: string }[] = [];

  for (const asm of Il2Cpp.domain.assemblies) {
    // the game's own code, not engine internals
    if (asm.name.indexOf("Core") < 0 && asm.name.indexOf("Ankama") < 0) continue;
    for (const klass of asm.image.classes) {
      let methods;
      try {
        methods = klass.methods;
      } catch (_) {
        continue;
      }
      for (const m of methods) {
        if (m.isStatic || m.parameterCount !== 0) continue;
        if (m.name !== "Update" && m.name !== "LateUpdate" && m.name !== "Tick") continue;
        if (m.virtualAddress.isNull()) continue;
        candidates.push({ klass: klass.type.name, method: m.name, asm: asm.name });
        break;
      }
      if (candidates.length >= 40) break;
    }
    if (candidates.length >= 40) break;
  }

  send({ event: "hb", asm: "candidates", scanned: candidates.length, messages: 0, files: 0 });
  for (const c of candidates.slice(0, 40)) {
    console.log(`[cand] ${c.asm} :: ${c.klass}.${c.method}`);
  }

  // Hook them all and report which ones actually fire, and on which thread.
  let hits: Record<string, number> = {};
  for (const c of candidates.slice(0, 40)) {
    const klass = (() => {
      for (const a of Il2Cpp.domain.assemblies) {
        const k = a.image.tryClass(c.klass);
        if (k) return k;
      }
      return null;
    })();
    if (!klass) continue;
    const m = klass.tryMethod(c.method);
    if (!m || m.virtualAddress.isNull()) continue;
    const label = `${c.klass}.${c.method}`;
    try {
      Interceptor.attach(m.virtualAddress, {
        onEnter() {
          hits[label] = (hits[label] || 0) + 1;
        },
      });
    } catch (e) {
      /* not hookable */
    }
  }

  // let the game run, then report which hooks fired
  setTimeout(() => {
    const fired = Object.keys(hits)
      .sort((a, b) => hits[b] - hits[a])
      .slice(0, 10)
      .map((k) => `${k}=${hits[k]}`);
    send({ event: "hb", asm: "fired", scanned: Object.keys(hits).length, messages: 0, files: 0, at: fired.join(" ") });
    send({ event: "done", messages: 0, files: 0, classes: 0 });
  }, 5000);
});
