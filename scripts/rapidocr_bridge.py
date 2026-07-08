import argparse
import json
import sys
from pathlib import Path

from PIL import Image
import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def load_engine():
    try:
        from rapidocr import RapidOCR
    except Exception:
        from rapidocr_onnxruntime import RapidOCR
    return RapidOCR()


def normalize_box(box):
    if box is None:
        return None
    points = np.array(box, dtype=float).reshape(-1, 2)
    x1, y1 = points.min(axis=0)
    x2, y2 = points.max(axis=0)
    return [int(round(x1)), int(round(y1)), int(round(x2 - x1)), int(round(y2 - y1))]


def list_or_empty(value):
    if value is None:
        return []
    return list(value)


def normalize_rows(raw):
    if raw is None:
        return []
    if all(hasattr(raw, name) for name in ("boxes", "txts", "scores")):
        txts = list_or_empty(raw.txts)
        scores = list_or_empty(raw.scores)
        boxes = list_or_empty(raw.boxes)
        if not boxes:
            boxes = [None] * len(txts)
        return zip(txts, scores, boxes)
    rows = raw[0] if isinstance(raw, tuple) else raw
    out = []
    for row in rows or []:
        if isinstance(row, dict):
            out.append((row.get("text", ""), float(row.get("score", 0)), row.get("box")))
        elif len(row) >= 3:
            out.append((str(row[1]), float(row[2]), row[0]))
    return out


def recognize(engine, image_path):
    image = np.array(Image.open(image_path).convert("RGB"))
    rows = []
    for text, score, box in normalize_rows(engine(image)):
        rows.append({"text": text, "score": float(score), "box": normalize_box(box)})
    return {"ok": True, "rows": rows}


def probe():
    load_engine()
    return {"ok": True, "backend": "rapidocr-python"}


def serve():
    engine = load_engine()
    print(json.dumps({"ok": True, "ready": True, "backend": "rapidocr-python"}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            path = Path(request["image"])
            result = recognize(engine, path)
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
        print(json.dumps(result, ensure_ascii=False), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("image", nargs="?")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.serve:
            serve()
            return 0
        if args.probe:
            result = probe()
        else:
            if not args.image:
                raise ValueError("image path is required")
            path = Path(args.image)
            if not path.is_file():
                raise FileNotFoundError(str(path))
            result = recognize(load_engine(), path)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
