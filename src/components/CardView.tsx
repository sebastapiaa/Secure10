import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { lineAt } from "../engine/score";
import type { Edge, EdgeLines, Line, Measurement } from "../engine/types";
import { EDGES } from "../engine/types";

type Which = "outer" | "inner";
interface Handle {
  which: Which;
  edge: Edge;
}

function endpoints(line: Line, edge: Edge, w: number, h: number) {
  return edge === "left" || edge === "right"
    ? { x1: lineAt(line, 0), y1: 0, x2: lineAt(line, h), y2: h }
    : { x1: 0, y1: lineAt(line, 0), x2: w, y2: lineAt(line, w) };
}

function borderPolygon(outer: EdgeLines, inner: EdgeLines, edge: Edge, w: number, h: number): string {
  const o = endpoints(outer[edge], edge, w, h);
  const i = endpoints(inner[edge], edge, w, h);
  return `${o.x1},${o.y1} ${o.x2},${o.y2} ${i.x2},${i.y2} ${i.x1},${i.y1}`;
}

const LOUPE_SIZE = 190;
const LOUPE_ZOOM = 5;

interface Props {
  url: string;
  width: number;
  height: number;
  measurement: Measurement;
  onChange: (m: Measurement, final: boolean) => void;
}

export function CardView({ url, width, height, measurement, onChange }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const dragging = useRef<{ handle: Handle; startValue: number; startA: number; moved: boolean } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; px: number; py: number } | null>(null);

  const toImage = (e: PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * width,
      y: ((e.clientY - rect.top) / rect.height) * height,
      px: e.clientX - rect.left,
      py: e.clientY - rect.top,
    };
  };

  const moved = (handle: Handle, a: number): Measurement => {
    const lines = measurement[handle.which];
    const fits = { ...measurement.fits };
    if (handle.which === "inner") delete fits[handle.edge];
    return {
      ...measurement,
      fits,
      [handle.which]: { ...lines, [handle.edge]: { ...lines[handle.edge], a } },
    };
  };

  const beginDrag = (e: PointerEvent, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);
    const value = handle.edge === "left" || handle.edge === "right" ? p.x : p.y;
    dragging.current = { handle, startValue: value, startA: measurement[handle.which][handle.edge].a, moved: false };
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = toImage(e);
    setCursor(p);
    const d = dragging.current;
    if (!d) return;
    const value = d.handle.edge === "left" || d.handle.edge === "right" ? p.x : p.y;
    d.moved = true;
    onChange(moved(d.handle, d.startA + value - d.startValue), false);
  };

  const onPointerUp = (e: PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    dragging.current = null;
    if (d.moved) {
      const p = toImage(e);
      const value = d.handle.edge === "left" || d.handle.edge === "right" ? p.x : p.y;
      onChange(moved(d.handle, d.startA + value - d.startValue), true);
    }
  };

  const onKey = (e: KeyboardEvent, handle: Handle) => {
    const vertical = handle.edge === "left" || handle.edge === "right";
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forward = vertical ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const step = (e.shiftKey ? 2 : 0.25) * (e.key === back ? -1 : 1);
    onChange(moved(handle, measurement[handle.which][handle.edge].a + step), true);
  };

  useEffect(() => {
    const canvas = loupe.current;
    const img = image.current;
    if (!canvas || !img || !cursor || !img.complete) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = LOUPE_SIZE * ratio;
    canvas.height = LOUPE_SIZE * ratio;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const span = LOUPE_SIZE / LOUPE_ZOOM;
    ctx.drawImage(img, cursor.x - span / 2, cursor.y - span / 2, span, span, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    const project = (x: number, y: number) => [(x - cursor.x + span / 2) * LOUPE_ZOOM, (y - cursor.y + span / 2) * LOUPE_ZOOM];
    for (const which of ["outer", "inner"] as const) {
      ctx.strokeStyle = which === "outer" ? "#ff4fd8" : "#29e7ff";
      ctx.lineWidth = 1;
      for (const edge of EDGES) {
        const seg = endpoints(measurement[which][edge], edge, width, height);
        const [ax, ay] = project(seg.x1, seg.y1);
        const [bx, by] = project(seg.x2, seg.y2);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
  }, [cursor, measurement, width, height]);

  const handles: Handle[] = EDGES.flatMap((edge) => [
    { which: "outer" as const, edge },
    { which: "inner" as const, edge },
  ]);

  // Keep the loupe beside the pointer, on whichever side has room.
  const flipX = cursor && cursor.px > (svg.current?.clientWidth ?? 0) / 2;
  const flipY = cursor && cursor.py > (svg.current?.clientHeight ?? 0) / 2;

  return (
    <div className="cardview" style={{ aspectRatio: `${width} / ${height}`, ["--card-ratio" as string]: width / height }}>
      <img ref={image} src={url} alt="Straightened crop of the scanned card" draggable={false} />
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (!dragging.current) setCursor(null);
        }}
      >
        {EDGES.map((edge) => (
          <polygon key={edge} className="border-wash" points={borderPolygon(measurement.outer, measurement.inner, edge, width, height)} />
        ))}
        {handles.map((handle) => {
          const seg = endpoints(measurement[handle.which][handle.edge], handle.edge, width, height);
          const vertical = handle.edge === "left" || handle.edge === "right";
          return (
            <g key={handle.which + handle.edge} className={`handle ${handle.which}`}>
              <line {...seg} className="handle-line" />
              <line
                {...seg}
                className="handle-hit"
                style={{ cursor: vertical ? "ew-resize" : "ns-resize" }}
                tabIndex={0}
                role="slider"
                aria-label={`${handle.which === "outer" ? "Card edge" : "Frame line"}, ${handle.edge}`}
                aria-valuenow={Math.round(measurement[handle.which][handle.edge].a)}
                onPointerDown={(e) => beginDrag(e, handle)}
                onKeyDown={(e) => onKey(e, handle)}
              />
            </g>
          );
        })}
      </svg>
      {cursor && (
        <canvas
          ref={loupe}
          className="loupe"
          aria-hidden="true"
          style={{
            width: LOUPE_SIZE,
            height: LOUPE_SIZE,
            left: cursor.px + (flipX ? -LOUPE_SIZE - 18 : 18),
            top: cursor.py + (flipY ? -LOUPE_SIZE - 18 : 18),
          }}
        />
      )}
    </div>
  );
}
