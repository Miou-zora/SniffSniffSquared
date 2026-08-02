import { redirect } from "next/navigation";

/** See the note in ../worth/page.tsx. */
export default function BrokenPage(): never {
  redirect("/items");
}
