import type { Request, Response } from "express";
// pptxgenjs ships UMD namespace types that TypeScript's NodeNext resolver treats
// as a non-constructable namespace. The runtime ESM default export IS the class.
// We import the module and re-type it so the rest of the file stays type-safe.
import pptxgenImport from "pptxgenjs";
import axios from "axios";

import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { dbService } from "@/services/db.service.js";
import type { ProjectIdParams } from "@/modules/project/project.validation.js";

// pptxgenjs uses `export as namespace` UMD types that are incompatible with
// NodeNext strict module resolution. The runtime default export IS the class,
// but TypeScript infers the namespace type (no construct signatures, no instance
// methods). Cast once here; the `any` is contained to this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PptxGen = pptxgenImport as unknown as new () => any;

const SLIDE_WIDTH_IN = 10;

function hexColor(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace("#", "");
  if (clean.length === 3) return clean.split("").map((c) => c + c).join("").toUpperCase();
  if (clean.length === 6) return clean.toUpperCase();
  return undefined;
}

async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    const res = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 8000 });
    const buffer = Buffer.from(res.data);
    const mime = (res.headers["content-type"] as string | undefined) ?? "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

export const exportPptx = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const projectResult = await dbService.getProjectForUser(projectId, requesterId);
  if (!projectResult) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const slides = await canvasCacheService.listSlides(projectId);
  if (slides.length === 0) {
    res.status(422).json({ error: "Project has no slides" });
    return;
  }

  const pptx = new PptxGen();

  const firstSlide = slides[0]!;
  const slideHeightIn = SLIDE_WIDTH_IN * (firstSlide.height / firstSlide.width);
  pptx.defineLayout({ name: "CUSTOM", width: SLIDE_WIDTH_IN, height: slideHeightIn });
  pptx.layout = "CUSTOM";

  for (const canvas of slides) {
    const elements = await canvasCacheService.listElements(projectId, canvas.canvasId);
    const slide = pptx.addSlide();

    const bgColor = hexColor(canvas.backgroundColor) ?? "FFFFFF";
    slide.background = { color: bgColor };

    const sorted = [...elements].sort((a, b) => a.zIndex - b.zIndex);

    for (const el of sorted) {
      const xPct = `${((el.x / canvas.width) * 100).toFixed(3)}%`;
      const yPct = `${((el.y / canvas.height) * 100).toFixed(3)}%`;
      const wPct = `${((el.width / canvas.width) * 100).toFixed(3)}%`;
      const hPct = `${((el.height / canvas.height) * 100).toFixed(3)}%`;
      const rotate = Math.round(el.rotation ?? 0);
      const transparency = Math.max(0, Math.min(100, Math.round((1 - (el.opacity ?? 1)) * 100)));

      const fillHex = hexColor(el.fill);
      const strokeHex = hexColor(el.stroke);
      // Convert canvas-pixel stroke width to pt (slide is SLIDE_WIDTH_IN inches at 72 pt/in)
      const strokePt = el.strokeWidth > 0 ? Math.max(0.5, (el.strokeWidth / canvas.width) * SLIDE_WIDTH_IN * 72) : 0;

      const fillOpts = fillHex
        ? { fill: { color: fillHex, transparency } }
        : { fill: { type: "none" as const } };

      const lineOpts =
        strokeHex && strokePt > 0 ? { line: { color: strokeHex, width: strokePt } } : {};

      const baseOpts = { x: xPct, y: yPct, w: wPct, h: hPct, rotate, ...fillOpts, ...lineOpts };

      switch (el.type) {
        case "rect":
          slide.addShape(pptx.ShapeType.rect, baseOpts);
          break;

        case "ellipse":
          slide.addShape(pptx.ShapeType.ellipse, baseOpts);
          break;

        case "triangle":
          slide.addShape(pptx.ShapeType.triangle, baseOpts);
          break;

        case "star":
          slide.addShape(pptx.ShapeType.star5, baseOpts);
          break;

        case "polygon":
          slide.addShape(pptx.ShapeType.hexagon, baseOpts);
          break;

        case "diamond":
          slide.addShape(pptx.ShapeType.diamond, baseOpts);
          break;

        case "parallelogram":
          slide.addShape(pptx.ShapeType.parallelogram, baseOpts);
          break;

        case "trapezoid":
          slide.addShape(pptx.ShapeType.trapezoid, baseOpts);
          break;

        case "cross":
          slide.addShape(pptx.ShapeType.plus, baseOpts);
          break;

        case "heart":
          slide.addShape(pptx.ShapeType.heart, baseOpts);
          break;

        case "cloud":
          slide.addShape(pptx.ShapeType.cloud, baseOpts);
          break;

        case "callout":
          slide.addShape(pptx.ShapeType.callout1, baseOpts);
          break;

        case "line":
          slide.addShape(pptx.ShapeType.line, {
            x: xPct,
            y: yPct,
            w: wPct,
            h: hPct,
            rotate,
            line: { color: strokeHex ?? "000000", width: Math.max(0.5, strokePt) },
          });
          break;

        case "arrow":
          slide.addShape(pptx.ShapeType.line, {
            x: xPct,
            y: yPct,
            w: wPct,
            h: hPct,
            rotate,
            line: {
              color: strokeHex ?? "000000",
              width: Math.max(0.5, strokePt),
              endArrowType: "arrow",
            },
          });
          break;

        case "text": {
          const fontSizePt = Math.max(6, Math.round(((el.props?.fontSize ?? 40) / canvas.height) * slideHeightIn * 72));
          const textColor = fillHex ?? "000000";
          const fontStyle = el.props?.fontStyle ?? "";
          slide.addText(el.props?.text ?? "", {
            x: xPct,
            y: yPct,
            w: wPct,
            h: hPct,
            rotate,
            fontSize: fontSizePt,
            fontFace: "Arial",
            color: textColor,
            align: (el.props?.align as "left" | "center" | "right" | undefined) ?? "left",
            bold: fontStyle.includes("bold"),
            italic: fontStyle.includes("italic"),
            wrap: true,
            valign: "top",
            transparency,
          });
          break;
        }

        case "icon": {
          const iconSizePt = Math.max(6, Math.round((Math.min(el.width, el.height) * 0.8 / canvas.height) * slideHeightIn * 72));
          slide.addText(el.props?.text ?? "", {
            x: xPct,
            y: yPct,
            w: wPct,
            h: hPct,
            rotate,
            fontSize: iconSizePt,
            align: "center",
            valign: "middle",
            transparency,
          });
          break;
        }

        case "image": {
          const imgSrc = el.props?.src;
          if (imgSrc) {
            const imgData = await fetchImageAsBase64(imgSrc);
            if (imgData) {
              slide.addImage({ data: imgData, x: xPct, y: yPct, w: wPct, h: hPct, rotate, transparency });
            }
          }
          break;
        }
      }
    }
  }

  const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const safeName = projectResult.project.projectName.replace(/[^\w\s-]/g, "").trim() || "presentation";

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pptx"`);
  res.send(buffer);
};
