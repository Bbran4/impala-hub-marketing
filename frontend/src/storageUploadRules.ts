type UploadFile = { name: string; type: string; size: number };
const images = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const documents = {
  ...images,
  gif: "image/gif",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const STORAGE_UPLOAD_RULES = {
  "profile-avatars": {
    megabytes: 15,
    types: images,
    description: "JPG, PNG or WEBP images",
  },
  "sales-desk-attachments": {
    megabytes: 15,
    types: documents,
    description: "images, PDF, Word or Excel files",
  },
  "chat-attachments": {
    megabytes: 25,
    types: {
      ...documents,
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      txt: "text/plain",
      csv: "text/csv",
    },
    description: "images, PDF, Word, Excel, PowerPoint, TXT or CSV files",
  },
} as const;
export type UploadBucket = keyof typeof STORAGE_UPLOAD_RULES;
export function storageFileAccept(bucket: UploadBucket): string {
  return Object.keys(STORAGE_UPLOAD_RULES[bucket].types)
    .map((extension) => `.${extension}`)
    .join(",");
}
export function storageFileType(
  bucket: UploadBucket,
  file: UploadFile,
): string {
  const rule = STORAGE_UPLOAD_RULES[bucket];
  const types: Record<string, string> = rule.types;
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const expected = Object.hasOwn(types, extension) ? types[extension] : undefined;
  if (!expected || (file.type && file.type.toLowerCase() !== expected))
    throw new Error(`${file.name}: use ${rule.description}.`);
  if (
    !Number.isFinite(file.size) ||
    file.size <= 0 ||
    file.size > rule.megabytes * 1024 * 1024
  )
    throw new Error(
      `${file.name}: files must be between 1 byte and ${rule.megabytes} MB.`,
    );
  return expected;
}
