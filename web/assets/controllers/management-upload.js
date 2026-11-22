import { ManagementClientError } from "./management-client-error.js";

/** Upload bytes with the current session, keeping the existing progress UI. */
export function uploadManagementFile(file, { name, signal, onProgress } = {}, session) {
  return new Promise((resolve, reject) => {
    const { url, headers, isCurrent, rejectUnauthorized } = session();
    if (typeof XMLHttpRequest === "undefined") {
      reject(new ManagementClientError("当前环境不支持上传", { code: "upload_unavailable" }));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.open("POST", url(name || file.name || "file"));
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    for (const [header, value] of Object.entries(headers)) xhr.setRequestHeader(header, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (!isCurrent()) {
        reject(new ManagementClientError("已切换后端，旧上传已作废", { code: "stale_client", stale: true }));
        return;
      }
      let result;
      try {
        result = JSON.parse(xhr.responseText);
        // eslint-disable-next-line no-restricted-syntax -- an upload response can be a proxy error page instead of JSON; the upload is rejected with invalid_response
      } catch {
        reject(new ManagementClientError("上传响应无效", { code: "invalid_response" }));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve(result);
        return;
      }
      const error = new ManagementClientError(result?.error || "上传失败", {
        code: result?.code || `http_${xhr.status}`,
        status: xhr.status
      });
      if (xhr.status === 401) rejectUnauthorized(error);
      reject(error);
    };
    xhr.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new ManagementClientError("上传连接中断，请重试", { code: "network", network: true }));
    };
    xhr.onabort = () => {
      signal?.removeEventListener("abort", abort);
      reject(new ManagementClientError("上传已取消", { code: "aborted" }));
    };
    xhr.send(file);
  });
}
