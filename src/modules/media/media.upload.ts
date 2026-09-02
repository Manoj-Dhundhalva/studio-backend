import multer from "multer";

/** Mirrors `MAX_ELEMENTS_PER_CANVAS`-style hardcoded limits elsewhere — not worth an env var. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

/**
 * Memory storage, not disk: the buffer goes straight into a Cloudinary
 * upload stream (`cloudinary.service.ts`) and is never written to this
 * server's filesystem.
 */
export const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(new Error("Only image uploads (PNG, JPEG, WEBP, GIF, SVG) are supported"));
      return;
    }

    callback(null, true);
  },
});
