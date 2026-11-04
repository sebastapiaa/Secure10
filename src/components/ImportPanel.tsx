import { useRef, useState } from "react";

const ACCEPT = "image/jpeg,image/png,image/webp,image/tiff,image/bmp,.tif,.tiff";

interface Props {
  busy: string | null;
  errors: string[];
  notice: string | null;
  onFiles: (files: File[]) => void;
}

export function ImportPanel({ busy, errors, notice, onFiles }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <section className="panel import" aria-labelledby="import-title">
      <h2 id="import-title">Import new</h2>
      <button
        type="button"
        className={"dropzone" + (over ? " over" : "") + (busy ? " working" : "")}
        disabled={Boolean(busy)}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!busy && e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
        }}
      >
        {busy ? (
          <>
            <span className="scanbar" aria-hidden="true" />
            <strong>{busy}</strong>
          </>
        ) : (
          <>
            <strong>Drop a scan here</strong>
            <span>or click to choose a file</span>
          </>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        data-testid="scan-input"
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
      <p className="hint">300 DPI or higher, JPG, PNG or TIFF. Leave background around each card, lid closed. For several cards, keep them in the same layout on the front and back scans and they'll be matched by position.</p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {errors.map((message) => (
        <p className="error" role="alert" key={message}>
          {message}
        </p>
      ))}
    </section>
  );
}
