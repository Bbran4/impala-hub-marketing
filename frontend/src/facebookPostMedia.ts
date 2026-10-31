// App limits keep a complete multi-photo publication inside the function budget.
export const MAX_POST_IMAGES = 10;
export const MAX_POST_IMAGE_BYTES = 15 * 1024 * 1024;
export const POST_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export function validateImageFile(file: { type: string; size: number }): void {
  if (!POST_IMAGE_TYPES.includes(file.type.toLowerCase()))
    throw new Error("Choose JPG, PNG, WEBP or GIF images.");
  if (
    !Number.isFinite(file.size) ||
    file.size <= 0 ||
    file.size > MAX_POST_IMAGE_BYTES
  )
    throw new Error("Each image must be between 1 byte and 15 MB.");
}

export function validateImageCount(count: number): void {
  if (count > MAX_POST_IMAGES)
    throw new Error(
      `A post can contain up to ${MAX_POST_IMAGES} images. Remove some images before saving.`,
    );
}

export function facebookPostMedia(value: unknown): { url: string }[] {
  if (!Array.isArray(value)) throw new Error("Post images must be a list.");
  validateImageCount(value.length);
  return value.map((image) => {
    if (!image || typeof image !== "object" || typeof image.url !== "string")
      throw new Error(
        "Each image needs a public HTTPS address. Remove and upload the image again.",
      );
    let url: URL;
    try {
      url = new URL(image.url);
    } catch {
      throw new Error(
        "Each image needs a public HTTPS address. Remove and upload the image again.",
      );
    }
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    )
      throw new Error(
        "Each image needs a public HTTPS address. Remove and upload the image again.",
      );
    if (
      image.content_type != null &&
      image.content_type !== "" &&
      (typeof image.content_type !== "string" ||
        !POST_IMAGE_TYPES.includes(image.content_type.toLowerCase()))
    )
      throw new Error("Choose JPG, PNG, WEBP or GIF images.");
    if (
      image.size != null &&
      (typeof image.size !== "number" ||
        !Number.isFinite(image.size) ||
        image.size <= 0 ||
        image.size > MAX_POST_IMAGE_BYTES)
    )
      throw new Error("Each image must be between 1 byte and 15 MB.");
    return { url: image.url };
  });
}
