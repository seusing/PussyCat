import { useEffect, useState } from "react";
import { loadWrssImage, wrssImageRemote } from "./wrssClient";

// 应用 CSP 只放行 'self' 和 data: 图片,公众号图片必须经宿主代理取回再转成 data URL。
export function WrssMarkdownImage({
  baseUrl,
  src,
  alt,
}: {
  baseUrl?: string;
  src?: string;
  alt?: string;
}) {
  const remote = wrssImageRemote(src),
    [data, setData] = useState("");
  useEffect(() => {
    setData("");
    if (!remote) return;
    const controller = new AbortController();
    loadWrssImage(baseUrl, remote, controller.signal)
      .then(setData)
      .catch(() => {});
    return () => controller.abort();
  }, [baseUrl, remote]);
  if (!remote) return src ? <img src={src} alt={alt ?? ""} /> : null;
  return data ? <img src={data} alt={alt ?? ""} /> : null;
}
