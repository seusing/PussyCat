import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

export async function openWrssExternal(url: string) {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function saveWrssBlob(defaultFileName: string, blob: Blob) {
  if (isTauri()) {
    const extension = defaultFileName.split(".").pop() || "bin",
      path = await save({
        title: "保存公众号文件",
        defaultPath: defaultFileName,
        filters: [
          { name: `${extension.toUpperCase()} 文件`, extensions: [extension] },
        ],
      });
    if (!path) return false;
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    await writeFile(path, new Uint8Array(bytes));
    return true;
  }
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = defaultFileName;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

export async function downloadWrssFile(url: string, defaultFileName: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`下载失败（${response.status}）`);
  return saveWrssBlob(defaultFileName, await response.blob());
}
