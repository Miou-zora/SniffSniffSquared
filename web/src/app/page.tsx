// Placeholder shell. Exists to prove the design tokens resolve end to end;
// delete it when real pages arrive.

const swatches = [
  { token: "bg-void-black", label: "Void Black", border: true },
  { token: "bg-ground-iron", label: "Ground Iron" },
  { token: "bg-carbon-veil", label: "Carbon Veil" },
  { token: "bg-lime-pulse", label: "Lime Pulse" },
  { token: "bg-phosphor-white", label: "Phosphor White" },
  { token: "bg-sage-60", label: "Sage 60" },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-[1280px] px-24 py-96">
      <p className="text-caption tracking-caption text-moss-70 uppercase">
        design system wired
      </p>

      <h1 className="text-heading-lg tracking-heading-lg mt-16 max-w-[20ch]">
        SniffSniffSquared
      </h1>

      <p className="text-subheading tracking-subheading text-moss-80 mt-20 max-w-[52ch]">
        Dofus 3 marketplace prices, captured off the wire and decoded. Nothing is built
        yet — this page only confirms the tokens resolve.
      </p>

      <div className="mt-48 flex flex-wrap gap-12">
        <button className="border-phosphor-white bg-ground-iron text-phosphor-white text-body tracking-body cursor-pointer rounded-xl border px-32 py-16 font-medium">
          Primary action
        </button>
        <button className="border-pine-15 text-sage-60 text-body tracking-body hover:border-circuit-border cursor-pointer rounded-xl border px-32 py-16 font-medium transition-colors">
          Ghost action
        </button>
      </div>

      <div className="border-phosphor-blue-black mt-64 border-t pt-32">
        <p className="text-caption tracking-caption text-deep-fern mb-16 uppercase">
          palette
        </p>
        <div className="flex flex-wrap gap-16">
          {swatches.map((s) => (
            <div key={s.token} className="flex items-center gap-8">
              <span
                className={`${s.token} ${s.border ? "border-circuit-border border" : ""} block size-24 rounded-md`}
              />
              <span className="text-body-sm tracking-body-sm text-sage-40">
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
