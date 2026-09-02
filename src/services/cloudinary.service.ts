import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

import { env } from "@/config/env.js";

export type TUploadedImage = {
  url: string;
  publicId: string;
  width: number | null;
  height: number | null;
  bytes: number;
  format: string;
};

/** Root folder for every project's uploads, so they're easy to find/purge in the Cloudinary dashboard. */
const UPLOAD_FOLDER = "canva/project-media";

// The SDK exposes no request timeout of its own, so a network stall (or, right
// now, an unconfigured/invalid account) would otherwise hang the upload
// request forever instead of failing back to the client.
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

export class CloudinaryService {
  private static instance: CloudinaryService;
  private configured = false;

  private constructor() {}

  public static getInstance(): CloudinaryService {
    if (!CloudinaryService.instance) {
      CloudinaryService.instance = new CloudinaryService();
    }

    return CloudinaryService.instance;
  }

  /** Deferred to first use rather than module load, so importing this file never crashes a build with empty env vars. */
  private ensureConfigured(): void {
    if (this.configured) {
      return;
    }

    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
    });

    this.configured = true;
  }

  async uploadImage(buffer: Buffer, projectId: string): Promise<TUploadedImage> {
    this.ensureConfigured();

    const upload = new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: `${UPLOAD_FOLDER}/${projectId}`, resource_type: "image" },
        (error, uploadResult) => {
          if (error || !uploadResult) {
            reject(error ?? new Error("Cloudinary upload returned no result"));
            return;
          }

          resolve(uploadResult);
        },
      );

      stream.end(buffer);
    });

    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Upload to Cloudinary timed out")), UPLOAD_TIMEOUT_MS);
    });

    const result = await Promise.race([upload, timeout]);

    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width ?? null,
      height: result.height ?? null,
      bytes: result.bytes,
      format: result.format,
    };
  }

  /** Best-effort: a failed remote delete still lets the DB row (the source of truth for the panel) go. */
  async deleteImage(publicId: string): Promise<void> {
    this.ensureConfigured();

    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    } catch (error) {
      console.error(`Failed to delete Cloudinary asset ${publicId}`, error);
    }
  }
}

export const cloudinaryService = CloudinaryService.getInstance();
