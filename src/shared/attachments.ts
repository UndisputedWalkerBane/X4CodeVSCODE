export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const timestamp = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}";
// Older uploads used a timestamp alone; later ones added a UUID. Each relocation prepended another UUID.
const legacyUploadPrefix = new RegExp("^(?:" + uuid + "-)*" + timestamp + "-(?:" + uuid + "-)?$");
const managedDirectory = /(?:^|[/\\])\.agent-hub[/\\]attachments[/\\]$/;

export function prefixedAttachmentName(prefix: string, name: string): string {
  const suffix = imageExtensions.has(name.toLowerCase()) ? ".file" : "";
  return prefix + "-" + name + suffix;
}

/** The leading dot of an extensionless filename such as ".png" is part of its name. */
export function isImageAttachment(path: string): boolean {
  const basenameStart = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  const extensionStart = path.lastIndexOf(".");
  if (extensionStart <= basenameStart || !imageExtensions.has(path.slice(extensionStart).toLowerCase())) return false;
  return !(managedDirectory.test(path.slice(0, basenameStart)) && legacyUploadPrefix.test(path.slice(basenameStart, extensionStart)));
}
