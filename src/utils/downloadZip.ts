import JSZip from "jszip";
import type { GeneratedFile } from "../compiler/types";

export async function downloadZip(files: GeneratedFile[], zipName = "datapack.zip") {
  if (!files?.length) return;

  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.path, f.contents ?? "");
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
