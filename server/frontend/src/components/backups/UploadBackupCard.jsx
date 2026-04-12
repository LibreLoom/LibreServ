import { Upload } from "lucide-react";
import Card from "../common/cards/Card";
import UploadProgress from "./UploadProgress";

export default function UploadBackupCard({
  uploadFile,
  onFileSelect,
  onUploadComplete,
  onUploadError,
  fileInputRef,
}) {
  return (
    <Card icon={Upload} title="Upload Backup" padding={false} className="animate-in fade-in slide-in-from-bottom-2">
      <div
        key={uploadFile ? "uploading" : "idle"}
        className="animate-in fade-in slide-in-from-bottom-2 p-4"
        style={{ animationDuration: "var(--motion-duration-medium2)" }}
      >
        {uploadFile ? (
          <UploadProgress
            file={uploadFile}
            onComplete={onUploadComplete}
            onError={onUploadError}
          />
        ) : (
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-primary/20 rounded-[16px] p-6 hover:border-primary/40 hover:bg-primary/5 cursor-pointer transition-colors">
            <Upload className="w-8 h-8 text-primary/40 mb-2" />
            <span className="text-sm text-primary/60">
              Drop backup file here or click to upload
            </span>
            <span className="text-xs text-primary/35 mt-1">
              .tar, .tar.gz, or .tgz files
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".tar,.tar.gz,.tgz"
              className="hidden"
              onChange={onFileSelect}
            />
          </label>
        )}
      </div>
    </Card>
  );
}
