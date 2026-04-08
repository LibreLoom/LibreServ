import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import TypewriterLoader from "../ui/TypewriterLoader";

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

function UploadProgress({ file, onUpload, onComplete, onError }) {
  const [progress, setProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [error, setError] = useState(null);
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (!file || hasStartedRef.current) return;
    hasStartedRef.current = true;

    const formData = new FormData();
    formData.append("backup", file);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const percentComplete = Math.round((event.loaded / event.total) * 100);
        setProgress(percentComplete);
        setUploadedBytes(event.loaded);
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setProgress(100);
        const response = JSON.parse(xhr.responseText);
        onComplete(response);
      } else {
        const errData = JSON.parse(xhr.responseText);
        setError(errData.error || "Upload failed");
        onError(new Error(errData.error || "Upload failed"));
      }
    });

    xhr.addEventListener("error", () => {
      setError("Network error during upload");
      onError(new Error("Network error during upload"));
    });

    xhr.addEventListener("abort", () => {
      setError("Upload cancelled");
      onError(new Error("Upload cancelled"));
    });

    xhr.open("POST", "/api/v1/backups/upload");
    xhr.withCredentials = true;
    xhr.send(formData);

    onUpload(xhr);
  }, [file, onComplete, onError, onUpload]);

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 rounded-[12px] bg-error/10 border border-error/20">
        <span className="text-sm text-error">{error}</span>
      </div>
    );
  }

  if (progress === 100) {
    return (
      <div className="flex items-center gap-2 p-4 rounded-[12px] bg-success/10 border border-success/20">
        <span className="text-sm text-success">Upload complete</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <TypewriterLoader message="Uploading backup..." size="md" />

      <div className="w-full bg-primary/10 rounded-full h-2 overflow-hidden">
        <div
          className="bg-primary h-full transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-primary/50 font-mono">
        <span>{formatBytes(uploadedBytes)} / {formatBytes(file.size)}</span>
        <span>{progress}%</span>
      </div>
    </div>
  );
}

UploadProgress.propTypes = {
  file: PropTypes.instanceOf(File).isRequired,
  onUpload: PropTypes.func,
  onComplete: PropTypes.func,
  onError: PropTypes.func,
};

UploadProgress.defaultProps = {
  onUpload: () => {},
  onComplete: () => {},
  onError: () => {},
};

export default UploadProgress;
